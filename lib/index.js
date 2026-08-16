/**
 * dsh-terminal-panel — host half
 *
 * Exposes a small HTTP RPC under the webserver prefix `/sxec` that lets the
 * conversation "Terminal" tab run commands.
 *
 * Two execution modes:
 * - Local (default): commands run directly with the dsh process's privileges
 *   via `node:child_process`, bypassing the harness subprocess sandbox.
 * - SSH (`sshTarget` configured): a PERSISTENT `ssh -t` session (pseudo-tty)
 *   per terminal panel, exactly like an SSH client. Benefits:
 *     * sudo credentials cache per-tty — password asked once per 15 min
 *     * `cd`/environment persist natively inside the session
 *     * interactive programs work; commands run in the HOST namespace of the
 *       sshd server, so setuid/sudo work even when dsh is sandboxed
 *     * key OR password authentication: if the key is missing, ssh prompts
 *       on the pty and the panel routes the (masked) input to it
 *
 * Runtime configuration (term-config endpoint):
 * - boot values come from the plugin config (cordis.patch.yml)
 * - the panel can override them at runtime via `POST /sxec/term-config`;
 *   overrides persist in `~/.local/share/dsh-terminal-panel/config.json`
 *
 * Security model:
 * - Requests are accepted only from loopback hosts or hosts listed in the
 *   `trustedHosts` plugin config (DNS-rebinding defence).
 * - No authentication here: the endpoint inherits the protection of whatever
 *   fronts the dsh web server. Anyone who can reach it can execute commands
 *   as the target user.
 */
import z from '@deepseek-ai/schemastery'
import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { networkInterfaces, homedir } from 'node:os'
import { basename, dirname, join as pathJoin } from 'node:path'

export const name = 'dsh-terminal-panel'
export const inject = ['webServer', 'sessions', 'sandboxPolicy']

const BASH = 'bash'
const DONE_FIND = /__SXE_DONE__:(-?\d+)\|([^\n]*)/
const DONE_RE = /__SXE_DONE__:(-?\d+)\|([^\n]*)\n?/g
const PROBE_STRIPS = [/SXEID\|[^\n]*\n?/g, /SXECWD\|[^\n]*\n?/g]

const DATA_DIR = `${homedir()}/.local/share/dsh-terminal-panel`
const CONFIG_FILE = `${DATA_DIR}/config.json`
const TMP_DIR = `${DATA_DIR}/tmp`
// Transfer cap for the SFTP tab (payload crosses the HTTP layer as base64).
const SFTP_MAX_BYTES = 64 * 1024 * 1024

/** Single-quote a string for safe interpolation into a shell command line. */
function sq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Base ssh argv for a connection to the configured target. */
function sshBaseArgs(identity, target, pty) {
  return [
    ...(pty ? ['-t', '-t'] : ['-T']),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    '-o', 'ConnectTimeout=5',
    // Only use the explicitly configured identity (or password): the host's
    // ssh-agent may hold other keys whose authorized_keys options (e.g.
    // no-pty) would break the session.
    '-o', 'IdentitiesOnly=yes',
    '-o', 'NumberOfPasswordPrompts=1',
    ...(identity ? ['-i', identity] : []),
    target,
  ]
}

/** Enumerate this host's addresses (tailscale + LAN) for the config dialog. */
function detectAddresses() {
  const tailscale = []
  const lan = []
  // tailscale CLI is the most reliable source when on PATH.
  try {
    const out = spawnSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 5000 })
    if (out.status === 0 && out.stdout) {
      for (const line of out.stdout.split('\n')) {
        const ip = line.trim()
        if (ip && !tailscale.includes(ip)) tailscale.push(ip)
      }
    }
  } catch (err) { /* tailscale not installed */ }
  // Fallback: parse the tailscale0 interface directly.
  if (tailscale.length === 0) {
    try {
      const out = spawnSync('ip', ['-4', 'addr', 'show', 'dev', 'tailscale0'], { encoding: 'utf8', timeout: 5000 })
      if (out.status === 0 && out.stdout) {
        const m = out.stdout.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/)
        if (m && m[1]) tailscale.push(m[1])
      }
    } catch (err) { /* no ip tool */ }
  }
  // LAN interfaces via os.networkInterfaces — note family is the NUMBER 4 on
  // Node < 18 and the string 'IPv4' on newer versions; accept both.
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces || []) {
      const isV4 = iface.family === 'IPv4' || iface.family === 4
      if (isV4 && !iface.internal && iface.address && !tailscale.includes(iface.address)) {
        lan.push(iface.address)
      }
    }
  }
  return { tailscale, lan }
}

export const Config = z.object({
  /** Extra hosts (besides loopback) allowed to drive the terminal, e.g. ["mybox.tail1234.ts.net"]. */
  trustedHosts: z.array(z.string()).default([]),
  /** SSH target for command execution, e.g. "user@127.0.0.1". Empty = run locally. */
  sshTarget: z.string().default(''),
  /** SSH identity file for the target (default ~/.ssh/dsh-terminal). */
  sshIdentity: z.string().default(''),
})

/** Load runtime overrides (config.json) over the boot config. */
function loadRuntimeOverrides(boot) {
  try {
    const f = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    return {
      sshTarget: typeof f.sshTarget === 'string' ? f.sshTarget : boot.sshTarget || '',
      sshIdentity: typeof f.sshIdentity === 'string' ? f.sshIdentity : boot.sshIdentity || '',
      sshUser: typeof f.sshUser === 'string' ? f.sshUser : '',
      sshPassword: typeof f.sshPassword === 'string' ? f.sshPassword : '',
    }
  } catch (err) {
    return { sshTarget: boot.sshTarget || '', sshIdentity: boot.sshIdentity || '', sshUser: '', sshPassword: '' }
  }
}

function hostAllowed(hostHeader, trustedHosts) {
  if (typeof hostHeader !== 'string') return false
  const host = hostHeader.split(':')[0].toLowerCase()
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return true
  return trustedHosts.some((entry) => entry.toLowerCase() === host)
}

export function apply(ctx, config) {
  const { webServer, sessions, sandboxPolicy } = ctx
  const trustedHosts = (config && config.trustedHosts) || []
  const boot = loadRuntimeOverrides(config)
  // Runtime-mutable ssh settings (overridable via term-config).
  let sshTarget = boot.sshTarget
  let sshIdentity = boot.sshIdentity || (sshTarget ? `${homedir()}/.ssh/dsh-terminal` : '')
  let sshUser = boot.sshUser || ''
  let sshPassword = boot.sshPassword || ''

  /** Resolve the full user@host target (config may store host and user separately). */
  function resolveTarget() {
    if (!sshTarget) return ''
    if (sshTarget.includes('@')) return sshTarget
    const user = sshUser || process.env.USER || 'root'
    return `${user}@${sshTarget}`
  }

  /** Spawn env for ssh: inject the password through SSH_ASKPASS (no tty needed). */
  function sshEnv() {
    const env = { ...process.env }
    if (sshPassword) {
      env.SSH_ASKPASS = `${DATA_DIR}/askpass.sh`
      env.SSH_ASKPASS_REQUIRE = 'force'
      env.SXE_SSH_PASSWORD = sshPassword
      try {
        mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(`${DATA_DIR}/askpass.sh`, '#!/bin/sh\nprintf \'%s\n\' "$SXE_SSH_PASSWORD"\n', { mode: 0o700 })
      } catch (err) { /* ignore */ }
    } else {
      delete env.SSH_ASKPASS
      delete env.SSH_ASKPASS_REQUIRE
      delete env.SXE_SSH_PASSWORD
    }
    return env
  }

  /**
   * Run one sftp batch (`sftp -b -`) against the configured target and
   * resolve with { exitCode, stdout, stderr }. Every SFTP panel operation is
   * a short-lived connection reusing the same credentials as the terminal
   * session — key or password (via SSH_ASKPASS), no extra login to manage.
   * Note: sftp(1) does not understand ssh's `-T` flag, so the option list is
   * built here rather than reusing sshBaseArgs.
   */
  function sftpArgs(identity, target) {
    return [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-o', 'ConnectTimeout=5',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'NumberOfPasswordPrompts=1',
      ...(identity ? ['-i', identity] : []),
      target,
    ]
  }
  function sftpBatch(commands) {
    return new Promise((resolve) => {
      const target = resolveTarget()
      if (!target) return resolve({ error: 'SFTP 需要 SSH 主机，请先在设置中配置' })
      let child
      try {
        child = nodeSpawn('sftp', ['-q', '-b', '-', ...sftpArgs(sshIdentity, target)], { stdio: ['pipe', 'pipe', 'pipe'], env: sshEnv() })
      } catch (err) {
        return resolve({ error: 'sftp 启动失败: ' + String(err && err.message ? err.message : err) })
      }
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (d) => { stdout += String(d) })
      child.stderr.on('data', (d) => { stderr += String(d) })
      child.on('close', (code) => resolve({ exitCode: code, stdout, stderr }))
      child.on('error', (e) => resolve({ error: 'sftp 启动失败: ' + String(e && e.message ? e.message : e) }))
      try {
        child.stdin.write(commands.join('\n') + '\n')
        child.stdin.end()
      } catch (err) {
        resolve({ error: 'sftp 写入失败: ' + String(err && err.message ? err.message : err) })
      }
    })
  }

  /**
   * Parse `ls -la` output from sftp. Batch mode echoes each command as a
   * `sftp> ...` line and prints FULL paths, with a `?` where the link count
   * would be (`drwxr-xr-x    ? ql ql 4096 Aug 16 10:00 /home/x/.`). Lines look
   * like `drwxr-xr-x    ? ql       ql         4096 Aug 16 10:00 /home/x/name`
   * (year instead of time when older than ~6 months, still three fields).
   */
  const LS_RE = /^([bcdlps-][rwxsStT-]{9})\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/
  function parseLs(out) {
    const entries = []
    for (const line of String(out).split('\n')) {
      if (!line || line.startsWith('sftp>')) continue
      const m = line.match(LS_RE)
      if (!m) continue
      // Split the symlink target BEFORE basename: the target may contain `/`
      // (e.g. `lnk -> /etc/hosts`), which would otherwise truncate the name.
      let name = m[9]
      let target = ''
      const arrow = name.indexOf(' -> ')
      if (arrow !== -1) {
        target = name.slice(arrow + 4)
        name = name.slice(0, arrow)
      }
      name = basename(name)
      if (!name || name === '.' || name === '..') continue
      entries.push({
        name,
        type: m[1][0] === 'd' ? 'dir' : m[1][0] === 'l' ? 'link' : 'file',
        size: parseInt(m[5], 10) || 0,
        mtime: `${m[6]} ${m[7]} ${m[8]}`,
        mode: m[1],
        target,
      })
    }
    return entries
  }

  /** Stage a base64 payload to a temp file, run sftp commands, clean up. */
  async function sftpWithTmp(buf) {
    let tmp = ''
    try {
      mkdirSync(TMP_DIR, { recursive: true })
      tmp = pathJoin(TMP_DIR, `dsh-sftp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
      if (buf) writeFileSync(tmp, buf)
    } catch (err) {
      return { error: '写入临时文件失败: ' + String(err && err.message ? err.message : err) }
    }
    return tmp
  }
  function tmpCleanup(tmp) {
    try { unlinkSync(tmp) } catch (err) { /* ignore */ }
  }

  const BUF_CAP = 512 * 1024
  let state = { cwd: null, buffer: '', total: 0, running: null, busy: false, rc: null, signaled: false, user: null, host: null, home: null, sudo: false, auth: false, runTail: '', sessionInitPending: false, initNoiseStart: 0, initWaiters: [], execWaiters: [] }
  let session = null
  // Serialise every write to the pty session so probes and user commands can
  // never interleave their completion markers in the shared runTail.
  let opQueue = Promise.resolve()
  function enqueue(fn) {
    const p = opQueue.then(fn)
    opQueue = p.then(() => {}, () => {})
    return p
  }

  /** Spawn a short-lived LOCAL shell, run `script` in `cwd`, resolve with output. */
  function runCaptureLocal(script, cwd) {
    return new Promise((resolve) => {
      const child = nodeSpawn(BASH, ['-c', script], { cwd: cwd ?? undefined, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => { out += String(d) })
      child.stderr.on('data', (d) => { err += String(d) })
      child.on('close', (code, signal) => resolve({ exitCode: code, signal, stdout: out, stderr: err }))
      child.on('error', (e) => resolve({ exitCode: -1, signal: null, stdout: out, stderr: String(e) }))
    })
  }

  /**
   * Ensure the persistent pty session exists. The remote side turns the
   * prompt into a sentinel; ssh buffers stdin until authenticated, so with
   * password auth the user's password is requested (masked in the panel)
   * before the init line takes effect.
   */
  function ensureSession() {
    if (session && session.child.exitCode === null) return session
    let child
    try {
      child = nodeSpawn('ssh', [...sshBaseArgs(sshIdentity, resolveTarget(), true), 'exec bash --noprofile --norc'], { stdio: ['pipe', 'pipe', 'pipe'], env: sshEnv() })
    } catch (err) {
      return null
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => appendOut(chunk))
    child.stderr.on('data', (chunk) => appendOut(chunk))
    child.on('close', () => {
      if (state.running === child) {
        state.running = null
        state.busy = false
        state.rc = null
        state.signaled = true
        state.sudo = false
        state.auth = false
      }
      const waiters = state.execWaiters
      state.execWaiters = []
      for (const w of waiters) { try { w(null) } catch (err) { /* ignore */ } }
      session = null
    })
    session = { child }
    // Disable terminal echo and turn the prompt into a sentinel. The init
    // line (and with password auth, the ssh password prompt) is echoed by
    // the pty before stty -echo takes effect.
    state.sessionInitPending = true
    state.auth = false
    state.initNoiseStart = state.total
    try { child.stdin.write("stty -echo; PS1='__SXE_READY__'\n") } catch (err) { /* ignore */ }
    return session
  }

  function sessionWrite(line) {
    if (!session || !session.child.stdin || session.child.stdin.destroyed) return false
    try {
      session.child.stdin.write(line)
      return true
    } catch (err) {
      return false
    }
  }

  /** Resolve when the session init sentinel arrives (stty -echo applied). */
  function waitSessionReady() {
    if (!state.sessionInitPending) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 6000)
      state.initWaiters.push(() => { clearTimeout(timer); resolve() })
    })
  }

  /**
   * Run one command through the pty session and resolve with the DONE marker
   * outcome ({rc, cwd}) or {error} / {timeout}. The command's text stays in
   * the panel buffer (probes use SXE* markers that term-read strips).
   */
  function sessionExec(script) {
    return enqueue(() => new Promise((resolve) => {
      const s = ensureSession()
      if (!s) return resolve({ error: 'ssh session 启动失败' })
      waitSessionReady().then(() => {
        state.runTail = ''
        if (!sessionWrite(`${script}; echo "__SXE_DONE__:$?|$PWD"\n`)) return resolve({ error: 'ssh session 不可用' })
        const timer = setTimeout(() => resolve({ timeout: true }), 30000)
        state.execWaiters.push((payload) => {
          clearTimeout(timer)
          if (!payload) return resolve({ error: 'ssh session 已断开' })
          resolve(payload)
        })
      })
    }))
  }

  /** Strip ANSI escape sequences and normalise CRLF. */
  const sanitize = (s) => {
    let out = ''
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (c === 27) {
        if (s[i + 1] === '[') {
          i += 2
          while (i < s.length && !(s.charCodeAt(i) >= 0x40 && s.charCodeAt(i) <= 0x7e)) i++
        } else if (s[i + 1] === ']') {
          i += 2
          while (i < s.length) {
            if (s.charCodeAt(i) === 7) break
            if (s[i] === String.fromCharCode(27) && s[i + 1] === '\\') break
            i++
          }
        } else {
          i += 1
        }
        continue
      }
      if (c === 13) {
        if (s[i + 1] === '\n') i++
        out += '\n'
        continue
      }
      out += s[i]
    }
    return out
  }
  const appendOut = (chunk) => {
    const text = sanitize(String(chunk))
    if (!text) return
    state.buffer += text
    state.total += text.length
    if (state.buffer.length > BUF_CAP) state.buffer = state.buffer.slice(state.buffer.length - BUF_CAP)
    if (!sshTarget) return
    // Session initialisation: detect the ssh password prompt (masked input)
    // and cut the init echo noise once the sentinel (line-start) appears.
    if (state.sessionInitPending) {
      if (/[Pp]assword:/i.test(text) && !state.auth) state.auth = true
      const m = /(^|\n)__SXE_READY__/.exec(text)
      if (m) {
        if (!state.auth) {
          const noiseEnd = state.total - text.length + m.index + m[0].length
          const winStart = state.total - state.buffer.length
          const cutStart = state.initNoiseStart - winStart
          const cutEnd = noiseEnd - winStart
          if (cutStart >= 0 && cutEnd <= state.buffer.length && cutEnd > cutStart) {
            state.buffer = state.buffer.slice(0, cutStart) + state.buffer.slice(cutEnd)
            state.total -= (noiseEnd - state.initNoiseStart)
          }
        }
        state.sessionInitPending = false
        state.auth = false
        const waiters = state.initWaiters
        state.initWaiters = []
        for (const fn of waiters) { try { fn() } catch (err) { /* ignore */ } }
      }
      return
    }
    // Completion marker / prompt sentinel for runs and probes.
    state.runTail = (state.runTail + text).slice(-4096)
    const m = state.runTail.match(DONE_FIND)
    const prompt = !m && state.running && state.runTail.includes('__SXE_READY__')
    if (m || prompt) {
      if (state.running) {
        state.running = null
        state.busy = false
        state.rc = m ? parseInt(m[1], 10) : null
        state.signaled = false
        state.sudo = false
        if (m && m[2]) state.cwd = m[2]
      }
      const waiters = state.execWaiters
      state.execWaiters = []
      const payload = m ? { rc: parseInt(m[1], 10), cwd: m[2] || null } : null
      for (const w of waiters) { try { w(payload) } catch (err) { /* ignore */ } }
      state.runTail = ''
    }
  }
  const resolveCwd = (sessionId) => {
    if (sessionId && sessions && typeof sessions.get === 'function') {
      try {
        const s = sessions.get(sessionId)
        if (s && s.header && typeof s.header.cwd === 'string' && s.header.cwd) return s.header.cwd
      } catch (err) { /* ignore */ }
    }
    if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) {
      return sandboxPolicy.workspaceRoot
    }
    return null
  }
  const probeCwd = async () => {
    try {
      if (sshTarget) {
        const res = await sessionExec(`printf 'SXECWD|%s\\n' "$PWD"`)
        if (res && res.cwd) state.cwd = res.cwd
        return
      }
      const outcome = await runCaptureLocal('pwd', state.cwd)
      if (outcome && outcome.exitCode === 0 && outcome.stdout) {
        const text = outcome.stdout.trim()
        if (text) state.cwd = text
      }
    } catch (err) { /* keep previous cwd */ }
  }
  const ensureIdentity = async () => {
    if (state.user !== null) return
    try {
      if (sshTarget) {
        // Parse the identity from the probe output (SXEID marker).
        const prev = { user: state.user, host: state.host, home: state.home }
        const res = await sessionExec(`printf 'SXEID|%s|%s|%s\\n' "$(id -un)" "$(hostname)" "$HOME"`)
        // The probe output is in the buffer; extract from the newest tail.
        const idx = state.buffer.lastIndexOf('SXEID|')
        if (idx !== -1) {
          const m = state.buffer.slice(idx).match(/SXEID\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)/)
          if (m) {
            state.user = m[1] || ''
            state.host = m[2] || ''
            state.home = m[3] || ''
          }
        }
        if (state.user === null) { state.user = prev.user; state.host = prev.host; state.home = prev.home }
        return
      }
      const outcome = await runCaptureLocal('echo "$(id -un)"; echo "$(hostname)"; echo "$HOME"', state.cwd || '/')
      if (outcome && outcome.exitCode === 0 && outcome.stdout) {
        const lines = outcome.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
        state.user = lines[0] || ''
        state.host = lines[1] || ''
        state.home = lines[2] || ''
      }
    } catch (err) { /* keep defaults */ }
  }
  const finishRun = (proc, outcome) => {
    if (state.running === proc) {
      state.running = null
      state.busy = false
      state.rc = outcome ? outcome.exitCode : null
      state.signaled = !!(outcome && outcome.signal)
      state.sudo = false
    }
    probeCwd()
  }
  ctx.effect(() => () => {
    if (state.running) {
      try { state.running.terminate() } catch (err) { /* ignore */ }
      state.running = null
    }
    if (session) {
      try { session.child.kill('SIGTERM') } catch (err) { /* ignore */ }
      session = null
    }
  })

  const handlers = {
    'term-init': async (args) => {
      if (!state.cwd) state.cwd = resolveCwd(args && typeof args.sessionId === 'string' ? args.sessionId : undefined)
      await ensureIdentity()
      return { cwd: state.cwd, user: state.user, host: state.host, home: state.home, busy: state.busy, rc: state.rc, signaled: state.signaled, sudo: state.sudo, auth: state.auth, configured: !!sshTarget }
    },
    'term-run': async (args) => {
      const command = args && typeof args.command === 'string' ? args.command : ''
      if (!command.trim()) return { error: 'empty command' }
      if (state.running) return { error: '上一条命令仍在执行，等待完成或用 Ctrl+C 中断' }
      if (!state.cwd) {
        const c = resolveCwd(args && typeof args.sessionId === 'string' ? args.sessionId : undefined)
        if (!c) return { error: '无法确定工作目录' }
        state.cwd = c
      }
      const trimmed = command.trim()
      const cdMatch = trimmed.match(/^cd(?:\s+(.+))?$/)
      const hasMeta = cdMatch && cdMatch[1] !== undefined && /[&|;<>(){}`'"$\\\n]/.test(cdMatch[1])
      if (cdMatch && !hasMeta) {
        await ensureIdentity()
        let target = cdMatch[1] ? cdMatch[1].trim() : '~'
        if (target === '~') target = state.home || '~'
        else if (target.startsWith('~/')) target = (state.home || '~') + target.slice(1)
        try {
          let p = ''
          let ok = false
          let outcome = null
          if (sshTarget) {
            outcome = await sessionExec(`cd ${sq(target)} && printf 'SXECWD|%s\\n' "$PWD"`)
            ok = !!(outcome && outcome.rc === 0 && outcome.cwd)
            p = outcome && outcome.cwd ? outcome.cwd : ''
          } else {
            outcome = await runCaptureLocal(`cd ${sq(target)} && pwd`, state.cwd)
            ok = !!(outcome && outcome.exitCode === 0 && outcome.stdout)
            p = outcome && outcome.stdout ? outcome.stdout.trim() : ''
          }
          if (ok && p) {
            state.cwd = p
            return { ok: true, cwd: state.cwd }
          }
          return { error: 'cd: 目录不存在或无权限' }
        } catch (err) {
          return { error: 'cd failed: ' + String(err && err.message ? err.message : err) }
        }
      }
      let script = command
      if (trimmed === 'sudo' || trimmed.startsWith('sudo ')) script = 'sudo -S' + trimmed.slice(4)
      state.sudo = trimmed === 'sudo' || trimmed.startsWith('sudo ')

      let proc
      if (sshTarget) {
        const s = ensureSession()
        if (!s) return { error: 'ssh session 启动失败' }
        proc = s.child
        const writeErr = await enqueue(async () => {
          await waitSessionReady()
          state.runTail = ''
          if (!sessionWrite(`cd ${sq(state.cwd || '/')} 2>/dev/null; ${script}; echo "__SXE_DONE__:$?|$PWD"\n`)) {
            return 'ssh session 不可用'
          }
          return null
        })
        if (writeErr) return { error: writeErr }
      } else {
        try {
          proc = nodeSpawn(BASH, ['-c', script], { cwd: state.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
          proc.done = new Promise((resolve) => {
            proc.on('close', (code, signal) => resolve({ exitCode: code, signal }))
            proc.on('error', (e) => resolve({ exitCode: -1, signal: null, error: String(e) }))
          })
          proc.terminate = () => { try { proc.kill('SIGTERM') } catch (e) { /* ignore */ } }
          proc.stdout.setEncoding('utf8')
          proc.stderr.setEncoding('utf8')
          proc.stdout.on('data', (chunk) => appendOut(chunk))
          proc.stderr.on('data', (chunk) => appendOut(chunk))
          proc.done.then((outcome) => finishRun(proc, outcome)).catch(() => finishRun(proc, null))
        } catch (err) {
          return { error: 'spawn failed: ' + String(err && err.message ? err.message : err) }
        }
      }
      state.running = proc
      state.busy = true
      state.rc = null
      state.signaled = false
      return { ok: true }
    },
    'term-send': async (args) => {
      const data = args && typeof args.data === 'string' ? args.data : ''
      if (!state.running && !state.auth) return { error: 'no running command' }
      try {
        if (sshTarget) {
          if (!sessionWrite(data)) return { error: 'ssh session 不可用' }
        } else {
          state.running.stdin.write(data)
        }
      } catch (err) {
        return { error: String(err && err.message ? err.message : err) }
      }
      return { ok: true }
    },
    'term-signal': async () => {
      if (state.running) {
        try {
          if (sshTarget) {
            if (session) session.child.kill('SIGTERM')
          } else {
            state.running.terminate()
          }
        } catch (err) { return { error: String(err && err.message ? err.message : err) } }
      }
      return { ok: true }
    },
    'term-reset': async (args) => {
      state.cwd = resolveCwd(args && typeof args.sessionId === 'string' ? args.sessionId : undefined) || state.cwd
      state.buffer = ''
      state.total = 0
      state.rc = null
      state.signaled = false
      return { ok: true, cwd: state.cwd }
    },
    'term-read': async (args) => {
      const since = args && typeof args.since === 'number' && args.since >= 0 ? Math.floor(args.since) : 0
      let text = ''
      let lossy = false
      if (since < state.total) {
        const windowStart = state.total - state.buffer.length
        if (since < windowStart) { lossy = true; text = state.buffer }
        else { text = state.buffer.slice(since - windowStart) }
      }
      if (sshTarget) {
        text = text.replace(DONE_RE, '')
        text = text.replace(/__SXE_READY__/g, '')
        for (const re of PROBE_STRIPS) text = text.replace(re, '')
      }
      return { since: state.total, text, lossy, busy: state.busy, cwd: state.cwd, rc: state.rc, signaled: state.signaled, sudo: state.sudo, auth: state.auth }
    },
    'term-config': async (args) => {
      const req = args || {}
      if (typeof req.sshTarget === 'undefined') {
        return { sshTarget, sshIdentity, sshUser, detected: detectAddresses(), local: !sshTarget }
      }
      const target = typeof req.sshTarget === 'string' ? req.sshTarget.trim() : sshTarget
      const identity = typeof req.sshIdentity === 'string' ? req.sshIdentity.trim() : sshIdentity
      const user = typeof req.sshUser === 'string' ? req.sshUser.trim() : sshUser
      const password = typeof req.sshPassword === 'string' ? req.sshPassword : sshPassword
      try {
        mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(CONFIG_FILE, JSON.stringify({ sshTarget: target, sshIdentity: identity, sshUser: user, sshPassword: password }, null, 2), { mode: 0o600 })
      } catch (err) {
        return { error: '保存配置失败: ' + String(err && err.message ? err.message : err) }
      }
      sshTarget = target
      sshIdentity = identity || (password ? '' : (target ? `${homedir()}/.ssh/dsh-terminal` : ''))
      sshUser = user
      sshPassword = password
      // Reconnect on the next command.
      if (session) {
        try { session.child.kill('SIGTERM') } catch (err) { /* ignore */ }
        session = null
      }
      state.running = null
      state.busy = false
      state.sudo = false
      state.auth = false
      state.sessionInitPending = false
      return { ok: true, sshTarget, sshIdentity }
    },
    'term-init-key': async () => {
      const hostPart = sshTarget.split('@').pop() || ''
      if (sshTarget && hostPart !== '127.0.0.1' && hostPart !== 'localhost') {
        return { error: '一键初始化仅支持本机目标（127.0.0.1 / localhost），远程主机请手动添加公钥' }
      }
      const keyPath = sshIdentity || `${homedir()}/.ssh/dsh-terminal`
      const pubPath = `${keyPath}.pub`
      try {
        if (!existsSync(keyPath)) {
          const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'dsh-terminal-panel'], { encoding: 'utf8' })
          if (r.status !== 0) return { error: 'ssh-keygen 失败: ' + (r.stderr || r.stdout || '') }
        }
        const pub = readFileSync(pubPath, 'utf8').trim()
        const authFile = `${homedir()}/.ssh/authorized_keys`
        let auth = ''
        try { auth = readFileSync(authFile, 'utf8') } catch (err) { /* not exists */ }
        if (!auth.includes(pub.split(' ')[1])) {
          writeFileSync(authFile, (auth ? auth.replace(/\n?$/, '\n') : '') + `restrict,pty,no-user-rc ${pub}\n`, { mode: 0o600 })
        }
        return { ok: true, keyPath, pub }
      } catch (err) {
        return { error: '初始化失败: ' + String(err && err.message ? err.message : err) }
      }
    },
    'sftp-init': async () => {
      await ensureIdentity()
      return { available: !!resolveTarget(), target: resolveTarget(), home: state.home || '' }
    },
    'sftp-list': async (args) => {
      const p = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.'
      const r = await sftpBatch(['ls -la ' + sq(p)])
      if (r.error) return r
      if (r.stderr && r.stderr.trim()) return { error: r.stderr.trim().split('\n')[0] }
      return { path: p, entries: parseLs(r.stdout) }
    },
    'sftp-mkdir': async (args) => {
      const p = typeof args.path === 'string' ? args.path.trim() : ''
      if (!p) return { error: 'empty path' }
      const r = await sftpBatch(['mkdir ' + sq(p)])
      if (r.error) return r
      if (r.stderr && r.stderr.trim()) return { error: r.stderr.trim().split('\n')[0] }
      return { ok: true }
    },
    'sftp-rm': async (args) => {
      const p = typeof args.path === 'string' ? args.path.trim() : ''
      if (!p) return { error: 'empty path' }
      const cmd = args.isDir === true ? 'rmdir' : 'rm'
      const r = await sftpBatch([`${cmd} ${sq(p)}`])
      if (r.error) return r
      if (r.stderr && r.stderr.trim()) return { error: r.stderr.trim().split('\n')[0] }
      return { ok: true }
    },
    'sftp-download': async (args) => {
      const p = typeof args.path === 'string' ? args.path.trim() : ''
      if (!p) return { error: 'empty path' }
      const tmp = await sftpWithTmp(null)
      if (typeof tmp !== 'string') return tmp
      const r = await sftpBatch(['get ' + sq(p) + ' ' + sq(tmp)])
      if (r.error) return r
      if (r.stderr && r.stderr.trim()) { tmpCleanup(tmp); return { error: r.stderr.trim().split('\n')[0] } }
      let buf = null
      try { buf = readFileSync(tmp) } catch (err) { /* fallthrough */ }
      tmpCleanup(tmp)
      if (!buf) return { error: '读取下载文件失败' }
      if (buf.length > SFTP_MAX_BYTES) {
        return { error: `文件超过 ${SFTP_MAX_BYTES / 1048576}MB 传输上限，请改用终端 scp 下载` }
      }
      return { name: basename(p) || 'download', size: buf.length, data: buf.toString('base64') }
    },
    'sftp-upload': async (args) => {
      const dir = typeof args.dir === 'string' && args.dir.trim() ? args.dir.trim() : '.'
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      const data = typeof args.data === 'string' ? args.data : ''
      if (!name || !data) return { error: 'missing name/data' }
      if (!/^[A-Za-z0-9+/=_-]+$/.test(data)) return { error: '无效的上传数据' }
      const buf = Buffer.from(data, 'base64')
      if (buf.length === 0) return { error: '无效的上传数据' }
      if (buf.length > SFTP_MAX_BYTES) {
        return { error: `文件超过 ${SFTP_MAX_BYTES / 1048576}MB 传输上限` }
      }
      const tmp = await sftpWithTmp(buf)
      if (typeof tmp !== 'string') return tmp
      const r = await sftpBatch(['put ' + sq(tmp) + ' ' + sq(dir.replace(/\/+$/, '') + '/' + name)])
      tmpCleanup(tmp)
      if (r.error) return r
      if (r.stderr && r.stderr.trim()) return { error: r.stderr.trim().split('\n')[0] }
      return { ok: true, name }
    },
  }

  webServer.register({
    kind: 'prefix',
    path: '/sxec',
    handler: async (req, res) => {
      if (!hostAllowed(req.headers.host, trustedHosts)) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('forbidden')
        return
      }
      const method = req.url.split('?')[0].replace(/^\/sxec\/?/, '') || 'term-init'
      const fn = handlers[method]
      if (!fn) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      }
      let payload = {}
      if (req.method === 'POST') {
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const body = Buffer.concat(chunks).toString('utf8')
          if (body) payload = JSON.parse(body)
        } catch (err) {
          res.writeHead(400, { 'content-type': 'text/plain' })
          res.end('bad json')
          return
        }
      }
      try {
        const result = await fn(payload)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(err && err.message ? err.message : err) }))
      }
    },
  })
}
