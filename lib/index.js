/**
 * dsh-terminal-panel — host half
 *
 * Exposes a small HTTP RPC under the webserver prefix `/sxec` that lets the
 * conversation "Terminal" tab run commands on the harness host machine.
 *
 * Security model:
 * - Requests are accepted only from loopback hosts or hosts listed in the
 *   `trustedHosts` plugin config (DNS-rebinding defence: an attacker page
 *   cannot drive this endpoint through an origin we never declared).
 * - There is intentionally NO authentication here: the endpoint inherits the
 *   protection of whatever fronts the dsh web server (loopback binding,
 *   reverse-proxy auth, etc.). Anyone who can reach it can execute commands
 *   as the harness user — document that clearly in deployments.
 */
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-terminal-panel'
export const inject = ['webServer', 'subprocess', 'sessions', 'sandboxPolicy']

export const Config = z.object({
  /** Extra hosts (besides loopback) allowed to drive the terminal, e.g. ["mybox.tail1234.ts.net"]. */
  trustedHosts: z.array(z.string()).default([]),
})

function hostAllowed(hostHeader, trustedHosts) {
  if (typeof hostHeader !== 'string') return false
  const host = hostHeader.split(':')[0].toLowerCase()
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return true
  return trustedHosts.some((entry) => entry.toLowerCase() === host)
}

export function apply(ctx, config) {
  const { webServer, subprocess, sessions, sandboxPolicy } = ctx
  const trustedHosts = (config && config.trustedHosts) || []
  if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
    console.error('dsh-terminal-panel: subprocess service unavailable')
    return
  }

  const BUF_CAP = 512 * 1024
  // Terminal session state: one shared shell-like session for the panel.
  // `cwd` is tracked persistently so plain `cd` works across commands.
  let state = { cwd: null, buffer: '', total: 0, running: null, busy: false, rc: null, signaled: false, user: null, host: null, home: null, sudo: false }
  let bashPath = null

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
  const getBash = async () => {
    if (!bashPath) bashPath = await subprocess.resolveExecutable('bash')
    return bashPath
  }
  /** After each command, sync the tracked cwd with the real one (in case a child changed it). */
  const probeCwd = async () => {
    try {
      const path = await getBash()
      const probe = subprocess.spawn({
        argv: [path, '-c', 'pwd'],
        cwd: state.cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: 'ignore' },
        graceMs: 1000,
      })
      const outcome = await probe.done
      if (outcome && outcome.exitCode === 0 && probe.collected && probe.collected.stdout) {
        const text = probe.collected.stdout.readFrom(0).text.trim()
        if (text) state.cwd = text
      }
    } catch (err) { /* keep previous cwd */ }
  }
  const ensureIdentity = async () => {
    if (state.user !== null) return
    try {
      const path = await getBash()
      const probe = subprocess.spawn({
        argv: [path, '-c', 'echo "$(id -un)"; echo "$(hostname)"; echo "$HOME"'],
        cwd: state.cwd || '/',
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: 'ignore' },
        graceMs: 1000,
      })
      const outcome = await probe.done
      if (outcome && outcome.exitCode === 0 && probe.collected && probe.collected.stdout) {
        const lines = probe.collected.stdout.readFrom(0).text.split('\n').map((s) => s.trim()).filter(Boolean)
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
      try { state.running.proc.terminate() } catch (err) { /* ignore */ }
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
          const path = await getBash()
          const probe = subprocess.spawn({
            argv: [path, '-c', 'cd "$@" && pwd', 'dsh-terminal-panel-cd', target],
            cwd: state.cwd,
            stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
            graceMs: 2000,
          })
          const outcome = await probe.done
          if (outcome && outcome.exitCode === 0 && probe.collected && probe.collected.stdout) {
            const p = probe.collected.stdout.readFrom(0).text.trim()
            if (!p) return { error: 'cd: 无法解析目标目录' }
            state.cwd = p
            return { ok: true, cwd: state.cwd }
          }
          const errText = probe.collected && probe.collected.stderr ? probe.collected.stderr.readFrom(0).text.trim() : ''
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
        const path = await getBash()
        proc = subprocess.spawn({
          argv: [path, '-c', script],
          cwd: state.cwd,
          stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
          graceMs: 1000,
        })
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
