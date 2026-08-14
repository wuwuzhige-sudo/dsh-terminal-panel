/**
 * dsh-terminal-panel — client half
 *
 * Registers a "Terminal" tab in the conversation view (`conversation.view`
 * slot). The UI is a green-on-black terminal: inline prompt, command history
 * (arrow keys), Ctrl+C interruption, clear screen, and a "reset directory"
 * button. Communication with the host half goes through same-origin
 * `fetch('/sxec/*')` calls — no extra channels needed.
 */
window.__ModuleLoader__.load({
  id: 'dsh-terminal-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    let react = require('react')

    const name = 'dsh-terminal-panel'
    const inject = ['slots']

    // Two themes: classic (green on black) and modern (black on white).
    // All colours live in CSS custom properties on .sxe-term; the --modern
    // class only swaps the variables, so one stylesheet serves both.
    const css = `div:has(> div > .sxe-term) > div[role="tablist"] { display:flex; } div:has(> div > .sxe-term) > div[role="tablist"] > button[role="tab"]:nth-child(1) { order:3; } div:has(> div > .sxe-term) > div[role="tablist"] > button[role="tab"]:nth-child(2) { order:1; } div:has(> div > .sxe-term) > div[role="tablist"] > button[role="tab"]:nth-child(3) { order:2; } .sxe-term { --bg:#000; --fg:#33ff66; --dim:#66ff99; --border:rgba(51,255,102,0.3); --btn-bg:rgba(51,255,102,0.08); --btn-border:rgba(51,255,102,0.35); --btn-hover:rgba(51,255,102,0.18); --sel:rgba(51,255,102,0.35); display:flex; flex-direction:column; gap:6px; box-sizing:border-box; height:calc(100% - 22px); min-width:360px; margin-left:116px; margin-right:139px; background:var(--bg); color:var(--fg); border:1px solid var(--border); border-radius:8px; padding:8px 10px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; } .sxe-term--modern { --bg:#ffffff; --fg:#111111; --dim:#444444; --border:rgba(0,0,0,0.2); --btn-bg:rgba(0,0,0,0.05); --btn-border:rgba(0,0,0,0.25); --btn-hover:rgba(0,0,0,0.1); --sel:rgba(0,0,0,0.15); } .sxe-term-head { flex:none; display:flex; gap:6px; align-items:flex-start; flex-wrap:wrap; } .sxe-term-status { flex:1; min-width:140px; opacity:0.7; font-size:11px; } .sxe-btn { background:var(--btn-bg); color:var(--fg); border:1px solid var(--btn-border); border-radius:6px; padding:3px 10px; cursor:pointer; font:inherit; white-space:nowrap; } .sxe-btn:hover { background:var(--btn-hover); } .sxe-term-scroll { flex:1; min-height:0; overflow:auto; cursor:text; user-select:text; -webkit-user-select:text; } .sxe-term-lines { white-space:pre-wrap; word-break:break-all; } .sxe-term-hint { opacity:0.5; font-size:11px; padding:2px 0; } .sxe-term-line { display:flex; align-items:center; } .sxe-term-prompt { white-space:pre; flex:none; color:var(--dim); } .sxe-term-inline { flex:1; min-width:0; background:transparent; border:none; outline:none; color:var(--fg); caret-color:var(--fg); font:inherit; padding:0; } .sxe-term-scroll ::selection { background:var(--sel); } .sxe-term-inline::selection { background:var(--sel); }`

    /** Same-origin RPC to the host half (`/sxec/*` webserver routes). */
    async function rpc(method, payload) {
      const res = await fetch('/sxec/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return await res.json()
    }

    function apply(ctx) {
      if (typeof document !== 'undefined' && !document.getElementById('sxe-term-style')) {
        const style = document.createElement('style')
        style.id = 'sxe-term-style'
        style.textContent = css
        document.head.appendChild(style)
      }
      const slots = ctx.get('slots')
      if (slots === undefined) return

      // Shared view state across sessions; the host keeps the real buffer.
      const view = { text: '', since: 0, cwd: '', user: '', host: '', home: '', busy: false, rc: null, signaled: false, ready: false, err: null, sudo: false }
      const MAX_TEXT = 400000
      const hist = []
      let histIdx = -1

      const tilde = (p) => {
        if (!view.home || !p) return p
        if (p === view.home) return '~'
        if (p.startsWith(view.home + '/')) return '~' + p.slice(view.home.length)
        return p
      }
      const promptText = () => {
        const user = view.user || 'user'
        const host = view.host || 'host'
        const mark = user === 'root' ? '#' : '$'
        return user + '@' + host + ':' + tilde(view.cwd || '?') + mark + ' '
      }

      slots.inject('conversation.view', () => slots.register(
        { name: 'conversation.view', id: 'terminal', order: 20, label: '终端' },
        (props) => {
          const { useState, useEffect, useRef } = react
          const sessionId = props.sessionId
          const [tick, setTick] = useState(0)
          const inputRef = useRef(null)
          const outRef = useRef(null)
          const busyRef = useRef(false)
          // Theme preference persists across page reloads (localStorage).
          const [theme, setTheme] = useState(() => {
            try { return localStorage.getItem('sxe-theme') === 'modern' ? 'modern' : 'classic' } catch (e) { return 'classic' }
          })
          const toggleTheme = () => {
            const next = theme === 'modern' ? 'classic' : 'modern'
            try { localStorage.setItem('sxe-theme', next) } catch (e) { /* ignore */ }
            setTheme(next)
          }

          // Initialise: ask the host for identity + cwd.
          useEffect(() => {
            let cancelled = false
            ;(async () => {
              try {
                const res = await rpc('term-init', { sessionId })
                if (cancelled) return
                if (res && typeof res === 'object' && typeof res.error === 'string') {
                  view.err = res.error
                } else if (res && typeof res === 'object') {
                  view.cwd = typeof res.cwd === 'string' ? res.cwd : ''
                  view.user = typeof res.user === 'string' ? res.user : ''
                  view.host = typeof res.host === 'string' ? res.host : ''
                  view.home = typeof res.home === 'string' ? res.home : ''
                  view.busy = !!res.busy
                  view.rc = typeof res.rc === 'number' ? res.rc : null
                  view.signaled = !!res.signaled
                  view.sudo = !!res.sudo
                  view.ready = true
                }
              } catch (e) { view.err = String(e && e.message ? e.message : e) }
              if (!cancelled) setTick((t) => t + 1)
            })()
            return () => { cancelled = true }
          }, [sessionId])

          // Poll the host buffer for new output / status changes.
          useEffect(() => {
            const timer = setInterval(async () => {
              if (busyRef.current) return
              busyRef.current = true
              try {
                const res = await rpc('term-read', { since: view.since })
                if (res && typeof res === 'object') {
                  let changed = false
                  if (typeof res.since === 'number' && res.since > view.since) view.since = res.since
                  if (typeof res.text === 'string' && res.text) {
                    view.text += res.text
                    if (view.text.length > MAX_TEXT) view.text = view.text.slice(view.text.length - MAX_TEXT)
                    changed = true
                  }
                  if (typeof res.cwd === 'string' && res.cwd !== view.cwd) { view.cwd = res.cwd; changed = true }
                  if (typeof res.busy === 'boolean' && res.busy !== view.busy) { view.busy = res.busy; changed = true }
                  if (typeof res.rc === 'number' && res.rc !== view.rc) { view.rc = res.rc; changed = true }
                  if (typeof res.signaled === 'boolean' && res.signaled !== view.signaled) { view.signaled = res.signaled; changed = true }
                  if (typeof res.sudo === 'boolean' && res.sudo !== view.sudo) { view.sudo = res.sudo; changed = true }
                  if (changed) setTick((t) => t + 1)
                }
              } catch (err) { /* transient */ } finally { busyRef.current = false }
            }, 200)
            return () => clearInterval(timer)
          }, [])

          // Keep the output scrolled to the bottom.
          useEffect(() => {
            const el = outRef.current
            if (el) el.scrollTop = el.scrollHeight
          }, [tick])

          const send = async () => {
            const el = inputRef.current
            if (!el) return
            const text = el.value
            if (!text.trim()) return
            el.value = ''
            if (view.busy) {
              // Busy: this input goes to the running command's stdin (sudo password, etc.)
              try { await rpc('term-send', { data: text + '\n' }) } catch (e) { /* ignore */ }
              return
            }
            // Start the echo on a fresh line: an unterminated host prompt (e.g.
            // sudo's "[sudo] password:" without a trailing newline) must not
            // glue onto the next command echo.
            if (view.text && !view.text.endsWith('\n')) view.text += '\n'
            view.text += promptText() + text + '\n'
            if (view.text.length > MAX_TEXT) view.text = view.text.slice(view.text.length - MAX_TEXT)
            hist.push(text)
            histIdx = -1
            setTick((t) => t + 1)
            try {
              const res = await rpc('term-run', { command: text, sessionId })
              if (res && typeof res === 'object' && typeof res.error === 'string') {
                view.text += '⚠ ' + res.error + '\n'
                setTick((t) => t + 1)
              } else {
                view.busy = true
                setTick((t) => t + 1)
              }
            } catch (err) {
              view.text += '⚠ ' + String(err && err.message ? err.message : err) + '\n'
              setTick((t) => t + 1)
            }
          }

          const onKeyDown = (e) => {
            const el = inputRef.current
            if (!el) return
            if (e.key === 'Enter') { e.preventDefault(); send(); return }
            if (e.key === 'ArrowUp' && !e.shiftKey) {
              if (hist.length > 0) {
                const next = Math.min(histIdx + 1, hist.length - 1)
                histIdx = next
                el.value = hist[hist.length - 1 - next]
              }
              e.preventDefault()
              return
            }
            if (e.key === 'ArrowDown' && !e.shiftKey) {
              if (histIdx >= 0) {
                histIdx -= 1
                el.value = histIdx < 0 ? '' : hist[hist.length - 1 - histIdx]
              }
              e.preventDefault()
              return
            }
            if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
              if (el.selectionStart !== el.selectionEnd) return
              e.preventDefault()
              if (view.busy) { rpc('term-signal') } else { el.value = '' }
            }
          }

          let status = '初始化中…'
          if (view.err) status = '⚠ ' + view.err
          else if (view.ready) {
            status = 'cwd: ' + (view.cwd || '?')
            status += view.busy ? ' · 执行中' : ' · 空闲'
            if (view.signaled) status += ' · 已中断'
            else if (view.rc !== null) status += ' · exit ' + view.rc
          }

          return react.createElement('div', { className: 'sxe-term' + (theme === 'modern' ? ' sxe-term--modern' : '') },
            react.createElement('div', { className: 'sxe-term-head' },
              react.createElement('span', { className: 'sxe-term-status' }, status),
              react.createElement('button', { className: 'sxe-btn', onClick: () => rpc('term-signal') }, 'Ctrl+C'),
              react.createElement('button', { className: 'sxe-btn', onClick: () => { view.text = ''; setTick((t) => t + 1) } }, '清屏'),
              react.createElement('button', { className: 'sxe-btn', onClick: async () => {
                view.text = ''
                view.rc = null
                view.signaled = false
                try {
                  const res = await rpc('term-reset', { sessionId })
                  if (res && typeof res.cwd === 'string') view.cwd = res.cwd
                } catch (e) { /* ignore */ }
                setTick((t) => t + 1)
              } }, '重置目录'),
              react.createElement('button', { className: 'sxe-btn', onClick: toggleTheme }, theme === 'modern' ? '经典样式' : '现代样式'),
            ),
            react.createElement('div', {
              ref: outRef,
              className: 'sxe-term-scroll',
            },
              react.createElement('div', { className: 'sxe-term-lines' },
                view.text || react.createElement('span', { style: { opacity: 0.5 } }, '（终端就绪）'),
              ),
              view.busy
                ? react.createElement('div', { className: 'sxe-term-hint' },
                    view.sudo
                      ? '正在等待 sudo 密码：在下方输入并回车（输入内容隐藏显示）'
                      : '执行中：此处输入的内容将发送给当前命令的 stdin')
                : null,
              react.createElement('div', { className: 'sxe-term-line' },
                react.createElement('span', { className: 'sxe-term-prompt' }, promptText()),
                react.createElement('input', {
                  ref: inputRef,
                  className: 'sxe-term-inline',
                  autoFocus: true,
                  spellCheck: false,
                  autoComplete: 'off',
                  // Mask the field while a sudo command is waiting for its password.
                  type: view.sudo ? 'password' : 'text',
                  placeholder: view.sudo ? '输入 sudo 密码…' : '',
                  onKeyDown: onKeyDown,
                }),
              ),
            ),
          )
        },
      ))
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
