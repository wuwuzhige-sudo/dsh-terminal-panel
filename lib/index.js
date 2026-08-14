/**
 * dsh-terminal-panel — host half
 *
 * Exposes a small HTTP RPC under the webserver prefix `/sxec` that lets the
 * conversation "Terminal" tab run commands.
 *
 * Two execution modes:
 * - Local (default): commands run directly with the dsh process's privileges
 *   via `node:child_process`, deliberately bypassing the harness subprocess
 *   sandbox (bwrap's user namespace would strip setuid and make sudo
 *   unusable).
 * - SSH (`sshTarget` configured): every command goes through `ssh -T` to the
 *   configured target (e.g. `user@127.0.0.1`). This runs the command in the
 *   HOST namespace of the sshd server — full privileges including sudo —
 *   and also lets the panel act as a remote terminal to any SSH host.
 *
 * Security model:
 * - Requests are accepted only from loopback hosts or hosts listed in the
 *   `trustedHosts` plugin config (DNS-rebinding defence: an attacker page
 *   cannot drive this endpoint through an origin we never declared).
 * - There is intentionally NO authentication here: the endpoint inherits the
 *   protection of whatever fronts the dsh web server (loopback binding,
 *   reverse-proxy auth, etc.). Anyone who can reach it can execute commands
 *   as the target user — document that clearly in deployments.
 * - The SSH identity key (default `~/.ssh/dsh-terminal`) is equivalent to a
 *   login credential: keep it 0600 and restrict it in authorized_keys.
 */
import z from '@deepseek-ai/schemastery'
import { spawn as nodeSpawn } from 'node:child_process'

export const name = 'dsh-terminal-panel'
export const inject = ['webServer', 'sessions', 'sandboxPolicy']

const BASH = 'bash'
/** Completion marker emitted at the end of each SSH-mode command line. */
const DONE_MARK = '__SXE_DONE__:'
const DONE_RE = /__SXE_DONE__:(-?\d+)\n?/g

/** Single-quote a string for safe interpolation into a shell command line. */
function sq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Base ssh argv for a non-interactive (-T) connection. */
function sshBaseArgs(identity, target) {
  return [
    '-T',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    '-o', 'ConnectTimeout=5',
    ...(identity ? ['-i', identity] : []),
    target,
  ]
}

export const Config = z.object({
  /** Extra hosts (besides loopback) allowed to drive the terminal, e.g. ["mybox.tail1234.ts.net"]. */
  trustedHosts: z.array(z.string()).default([]),
  /** SSH target for command execution, e.g. "user@127.0.0.1". Empty = run locally. */
  sshTarget: z.string().default(''),
  /** SSH identity file for the target (default ~/.ssh/dsh-terminal). */
  sshIdentity: z.string().default(''),
})

function hostAllowed(hostHeader, trustedHosts) {
  if (typeof hostHeader !== 'string') return false
  const host = hostHeader.split(':')[0].toLowerCase()
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return true
  return trustedHosts.some((entry) => entry.toLowerCase() === host)
}

export function apply(ctx, config) {
  const { webServer, sessions, sandboxPolicy } = ctx
  const trustedHosts = (config && config.trustedHosts) || []
  const sshTarget = (config && config.sshTarget && config.sshTarget.trim()) || ''
  const sshIdentity = (config && config.sshIdentity && config.sshIdentity.trim()) ||
    (sshTarget ? `${process.env.HOME || '/home/ql'}/.ssh/dsh-terminal` : '')

  const BUF_CAP = 512 * 1024
  // Terminal session state: one shared shell-like session for the panel.
  // `cwd` is tracked persistently so plain `cd` works across commands.
  let state = { cwd: null, buffer: '', total: 0, running: null, busy: false, rc: null, signaled: false, user: null, host: null, home: null, sudo: false }

  /**
   * Spawn a short-lived shell, run `script` in `cwd`, and resolve with the
   * collected output. Local mode exits naturally; SSH mode closes stdin after
   * writing so the remote bash exits at EOF.
   */
  function runCapture(script, cwd) {
    return new Promise((resolve) => {
      let child
      if (!sshTarget) {
        child = nodeSpawn(BASH, ['-c', script], { cwd: cwd ?? undefined, stdio: ['ignore', 'pipe', 'pipe'] })
      } else {
        child = nodeSpawn('ssh', [...sshBaseArgs(sshIdentity, sshTarget), BASH, '--noprofile', '--norc'], { stdio: ['pipe', 'pipe', 'pipe'] })
        child.stdin.write(`cd ${sq(cwd || '/')} 2>/dev/null; ${script}\n`)
        child.stdin.end()
      }
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => { out += String(d) })
      child.stderr.on('data', (d) => { err += String(d) })
      child.on('close', (code, signal) => resolve({ exitCode: code, signal, stdout: out, stderr: err }))
      child.on('error', (e) => resolve({ exitCode: -1, signal: null, stdout: out, stderr: String(e) }))
    })
  }

  /**
   * Spawn an interactive shell for one command with piped stdio.
   * Local mode: completes when the process exits.
   * SSH mode: writes a completion marker line so the panel knows when the
   * remote command finished without closing stdin (sudo needs it for the
   * password). The marker is part of the same input line, so a stdin-reading
   * command (sudo -S) can never consume it.
   */
  function spawnInteractive(script, cwd) {
    let child
    if (!sshTarget) {
      child = nodeSpawn(BASH, ['-c', script], { cwd: cwd ?? undefined, stdio: ['pipe', 'pipe', 'pipe'] })
    } else {
      child = nodeSpawn('ssh', [...sshBaseArgs(sshIdentity, sshTarget), BASH, '--noprofile', '--norc'], { stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdin.write(`cd ${sq(cwd || '/')} 2>/dev/null; ${script}; echo ${DONE_MARK}$?\n`)
    }
    child.done = new Promise((resolve) => {
      child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
      child.on('error', (e) => resolve({ exitCode: -1, signal: null, error: String(e) }))
    })
    child.terminate = () => { try { child.kill('SIGTERM') } catch (e) { /* ignore */ } }
    return child
  }

  /** Strip ANSI escape sequences and normalise CRLF so the panel shows clean text. */
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
    // SSH mode: detect the completion marker (scan chunk + buffer tail to
    // survive partial writes) and finalise the run.
    if (state.running && sshTarget) {
      const probe = text + state.buffer.slice(-64)
      const m = probe.match(/__SXE_DONE__:(-?\d+)/)
      if (m) {
        const proc = state.running
        state.running = null
        state.busy = false
        state.rc = parseInt(m[1], 10)
        state.signaled = false
        state.sudo = false
        probeCwd()
        if (proc && proc.stdin && !proc.stdin.destroyed) {
          try { proc.stdin.end() } catch (err) { /* ignore */ }
        }
      }
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
  /** After each command, sync the tracked cwd with the real one (in case a child changed it). */
  const probeCwd = async () => {
    try {
      const outcome = await runCapture('pwd', state.cwd)
      if (outcome && outcome.exitCode === 0 && outcome.stdout) {
        const text = outcome.stdout.trim()
        if (text) state.cwd = text
      }
    } catch (err) { /* keep previous cwd */ }
  }
  const ensureIdentity = async () => {
    if (state.user !== null) return
    try {
      const outcome = await runCapture('echo "$(id -un)"; echo "$(hostname)"; echo "$HOME"', state.cwd || '/')
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
  })

  const handlers = {
    'term-init': async (args) => {
      if (!state.cwd) state.cwd = resolveCwd(args && typeof args.sessionId === 'string' ? args.sessionId : undefined)
      await ensureIdentity()
      return { cwd: state.cwd, user: state.user, host: state.host, home: state.home, busy: state.busy, rc: state.rc, signaled: state.signaled, sudo: state.sudo }
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
      // Every command runs in its own process, so a bare `cd` would otherwise be
      // lost. Detect pure `cd` (with optional target, `~`/relative supported)
      // and persist the resolved directory in the session state. Compound
      // commands containing shell metacharacters fall through to normal
      // execution (`cd x && y` still works, just does not persist).
      const trimmed = command.trim()
      const cdMatch = trimmed.match(/^cd(?:\s+(.+))?$/)
      const hasMeta = cdMatch && cdMatch[1] !== undefined && /[&|;<>(){}`'"$\\\n]/.test(cdMatch[1])
      if (cdMatch && !hasMeta) {
        await ensureIdentity()
        let target = cdMatch[1] ? cdMatch[1].trim() : '~'
        if (target === '~') target = state.home || '~'
        else if (target.startsWith('~/')) target = (state.home || '~') + target.slice(1)
        try {
          const outcome = await runCapture(`cd ${sq(target)} && pwd`, state.cwd)
          if (outcome && outcome.exitCode === 0 && outcome.stdout) {
            const p = outcome.stdout.trim()
            if (!p) return { error: 'cd: 无法解析目标目录' }
            state.cwd = p
            return { ok: true, cwd: state.cwd }
          }
          const errText = outcome && outcome.stderr ? outcome.stderr.trim() : ''
          return { error: 'cd: ' + (errText || '目录不存在或无权限') }
        } catch (err) {
          return { error: 'cd failed: ' + String(err && err.message ? err.message : err) }
        }
      }
      let script = command
      if (trimmed === 'sudo' || trimmed.startsWith('sudo ')) script = 'sudo -S' + trimmed.slice(4)
      // Tell the client the running command consumes a sensitive stdin line
      // (sudo password) so it can mask the input field.
      state.sudo = trimmed === 'sudo' || trimmed.startsWith('sudo ')
      let proc
      try {
        proc = spawnInteractive(script, state.cwd)
      } catch (err) {
        return { error: 'spawn failed: ' + String(err && err.message ? err.message : err) }
      }
      state.running = proc
      state.busy = true
      state.rc = null
      state.signaled = false
      proc.stdout.setEncoding('utf8')
      proc.stderr.setEncoding('utf8')
      proc.stdout.on('data', (chunk) => appendOut(chunk))
      proc.stderr.on('data', (chunk) => appendOut(chunk))
      proc.done.then((outcome) => finishRun(proc, outcome)).catch(() => finishRun(proc, null))
      return { ok: true }
    },
    'term-send': async (args) => {
      const data = args && typeof args.data === 'string' ? args.data : ''
      if (!state.running) return { error: 'no running command' }
      try {
        state.running.stdin.write(data)
      } catch (err) {
        return { error: String(err && err.message ? err.message : err) }
      }
      return { ok: true }
    },
    'term-signal': async () => {
      if (state.running) {
        try { state.running.terminate() } catch (err) { return { error: String(err && err.message ? err.message : err) } }
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
      // SSH mode: hide the completion markers from the panel.
      if (sshTarget) text = text.replace(DONE_RE, '')
      return { since: state.total, text, lossy, busy: state.busy, cwd: state.cwd, rc: state.rc, signaled: state.signaled, sudo: state.sudo }
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
