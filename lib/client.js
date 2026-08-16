/**
 * dsh-terminal-panel — client half
 *
 * Registers two tabs in the conversation view (`conversation.view` slot):
 * - "终端" (Terminal): green-on-black terminal with inline prompt, command
 *   history (arrow keys), Ctrl+C interruption, clear screen, reset directory.
 * - "SFTP": file browser over the same SSH connection — list/navigate
 *   directories, upload, download, mkdir, delete.
 *
 * Both tabs share one SSH connection config (host / user / password / key),
 * edited from a shared settings overlay that auto-opens on first run.
 * Communication with the host half goes through same-origin `fetch('/sxec/*')`
 * calls — no extra channels needed.
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

    // Shared view state across sessions; the host keeps the real buffer.
    const view = { text: '', since: 0, cwd: '', user: '', host: '', home: '', busy: false, rc: null, signaled: false, ready: false, err: null, sudo: false, auth: false, configured: true }

    // Shared state across the Terminal/SFTP tabs (and across sessions).
    // Theme lives here too so both panels switch together.
    const setup = {
      open: false,
      busy: false,
      msg: '',
      cfg: { sshTarget: '', sshUser: '', sshPassword: '', sshIdentity: '' },
      detected: { tailscale: [], lan: [] },
      theme: 'classic',
    }
    try { setup.theme = localStorage.getItem('sxe-theme') === 'modern' ? 'modern' : 'classic' } catch (e) { /* ignore */ }
    let setupListeners = []
    function emitSetup() { for (const fn of setupListeners) fn() }
    /** Re-render the calling component whenever shared setup state changes. */
    function useSetupTick() {
      const [, setTick] = react.useState(0)
      react.useEffect(() => {
        const fn = () => setTick((t) => t + 1)
        setupListeners.push(fn)
        return () => { setupListeners = setupListeners.filter((f) => f !== fn) }
      }, [])
    }
    /** Panel root class: shared variables + per-theme overrides. */
    function panelCls(extra) {
      return 'sxe-panel' + (setup.theme === 'modern' ? ' sxe-panel--modern' : '') + (extra ? ' ' + extra : '')
    }

    // Two themes: classic (green on black) and modern (black on white).
    // All colours live in CSS custom properties on .sxe-panel; the --modern
    // class only swaps the variables, so one stylesheet serves both panels.
    // Tab order follows the conversation.view registration order, so the SFTP
    // tab naturally sits right of the Terminal tab (chat, trajectory,
    // terminal, sftp) without any CSS reordering.
    const css = `
.sxe-panel { --bg:#000; --fg:#33ff66; --dim:#66ff99; --border:rgba(51,255,102,0.3); --btn-bg:rgba(51,255,102,0.08); --btn-border:rgba(51,255,102,0.35); --btn-hover:rgba(51,255,102,0.18); --sel:rgba(51,255,102,0.35); }
.sxe-panel--modern { --bg:#ffffff; --fg:#111111; --dim:#444444; --border:rgba(0,0,0,0.2); --btn-bg:rgba(0,0,0,0.05); --btn-border:rgba(0,0,0,0.25); --btn-hover:rgba(0,0,0,0.1); --sel:rgba(0,0,0,0.15); }
.sxe-term, .sxe-sftp { display:flex; flex-direction:column; gap:6px; box-sizing:border-box; height:calc(100% - 22px); min-width:360px; margin-left:116px; margin-right:139px; background:var(--bg); color:var(--fg); border:1px solid var(--border); border-radius:8px; padding:8px 10px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; }
.sxe-term-head { flex:none; display:flex; gap:6px; align-items:flex-start; flex-wrap:wrap; }
.sxe-term-status { flex:1; min-width:140px; opacity:0.7; font-size:11px; }
.sxe-btn { background:var(--btn-bg); color:var(--fg); border:1px solid var(--btn-border); border-radius:6px; padding:3px 10px; cursor:pointer; font:inherit; white-space:nowrap; }
.sxe-btn:hover { background:var(--btn-hover); }
.sxe-btn:disabled { opacity:0.45; cursor:default; }
.sxe-term-scroll { flex:1; min-height:0; overflow:auto; cursor:text; user-select:text; -webkit-user-select:text; }
.sxe-term-lines { white-space:pre-wrap; word-break:break-all; }
.sxe-term-hint { opacity:0.5; font-size:11px; padding:2px 0; }
.sxe-term-line { display:flex; align-items:center; }
.sxe-term-prompt { white-space:pre; flex:none; color:var(--dim); }
.sxe-term-inline { flex:1; min-width:0; background:transparent; border:none; outline:none; color:var(--fg); caret-color:var(--fg); font:inherit; padding:0; }
.sxe-term-scroll ::selection { background:var(--sel); }
.sxe-term-inline::selection { background:var(--sel); }
.sxe-sftp-head { flex:none; display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.sxe-sftp-path { flex:1; min-width:140px; opacity:0.8; font-size:11px; word-break:break-all; }
.sxe-sftp-body { flex:1; min-height:0; overflow:hidden; user-select:text; -webkit-user-select:text; display:flex; flex-direction:column; }
.sxe-sftp-grid { display:grid; grid-template-columns:1fr 1fr; gap:2px 14px; align-content:start; flex:1; min-height:0; }
.sxe-sftp-row { display:flex; align-items:center; gap:6px; padding:2px 6px; border-radius:4px; min-width:0; }
.sxe-sftp-row:hover { background:var(--btn-bg); }
.sxe-sftp-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sxe-sftp-name--click { cursor:pointer; }
.sxe-sftp-meta { flex:none; opacity:0.55; font-size:11px; text-align:right; }
.sxe-sftp-foot { flex:none; display:flex; justify-content:flex-end; align-items:center; gap:6px; opacity:0.7; font-size:11px; }
.sxe-sftp-empty { opacity:0.5; padding:8px 4px; }
.sxe-sftp-err { color:#e5484d; opacity:0.9; font-size:11px; padding:2px 4px; white-space:pre-wrap; }
.sxe-sftp-newdir { display:flex; gap:6px; align-items:center; }
.sxe-sftp-newdir input { flex:1; min-width:0; background:transparent; color:var(--fg); border:1px solid var(--btn-border); border-radius:6px; padding:3px 8px; font:inherit; outline:none; }
.sxe-sftp-newdir input:focus { border-color:var(--fg); }
`

    const sxInput = { width: '100%', boxSizing: 'border-box', background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: '6px', padding: '6px 8px', font: 'inherit', marginTop: '4px', outline: 'none' }

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

    const openSetup = async () => {
      try {
        const res = await rpc('term-config', {})
        if (res && typeof res === 'object') {
          if (res.detected && typeof res.detected === 'object') setup.detected = res.detected
          setup.cfg = {
            sshTarget: (typeof res.sshTarget === 'string' && res.sshTarget.includes('@')) ? res.sshTarget.split('@').pop() : (typeof res.sshTarget === 'string' ? res.sshTarget : ''),
            sshUser: (typeof res.sshTarget === 'string' && res.sshTarget.includes('@')) ? res.sshTarget.split('@')[0] : (typeof res.sshUser === 'string' ? res.sshUser : ''),
            sshPassword: '',
            sshIdentity: typeof res.sshIdentity === 'string' ? res.sshIdentity : '',
          }
        }
      } catch (e) { /* ignore */ }
      setup.msg = ''
      setup.open = true
      emitSetup()
    }
    const closeSetup = () => { setup.open = false; emitSetup() }
    const saveConfig = async () => {
      setup.busy = true
      setup.msg = ''
      emitSetup()
      try {
        const res = await rpc('term-config', {
          sshTarget: setup.cfg.sshTarget.trim(),
          sshUser: setup.cfg.sshUser.trim(),
          sshPassword: setup.cfg.sshPassword,
          sshIdentity: setup.cfg.sshIdentity.trim(),
        })
        if (res && typeof res === 'object' && typeof res.error === 'string') {
          setup.msg = '⚠ ' + res.error
        } else {
          setup.open = false
          view.text += '✔ 配置已保存，下一条命令将使用新连接\n'
          emitSetup()
        }
      } catch (e) {
        setup.msg = '⚠ ' + String(e && e.message ? e.message : e)
      }
      setup.busy = false
      emitSetup()
    }
    const initKey = async () => {
      setup.busy = true
      setup.msg = ''
      emitSetup()
      try {
        const res = await rpc('term-init-key', {})
        if (res && typeof res === 'object' && typeof res.error === 'string') {
          setup.msg = '⚠ ' + res.error
        } else {
          setup.msg = '✔ 密钥已就绪：' + (res && res.keyPath ? res.keyPath : '')
        }
      } catch (e) {
        setup.msg = '⚠ ' + String(e && e.message ? e.message : e)
      }
      setup.busy = false
      emitSetup()
    }
    const toggleTheme = () => {
      setup.theme = setup.theme === 'modern' ? 'classic' : 'modern'
      try { localStorage.setItem('sxe-theme', setup.theme) } catch (e) { /* ignore */ }
      emitSetup()
    }

    /** Shared settings overlay rendered inside whichever panel is active. */
    function setupOverlay() {
      if (!setup.open) return null
      return react.createElement('div', { style: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 } },
        react.createElement('div', { style: { background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: '10px', padding: '16px 18px', width: 'min(420px, 90%)', display: 'flex', flexDirection: 'column', gap: '10px', fontFamily: 'inherit', fontSize: '13px' } },
          react.createElement('div', { style: { fontWeight: 600 } }, '终端/SFTP 连接设置'),
          react.createElement('label', null, 'SSH 主机（IP 或域名，留空 = 本机直跑）',
            react.createElement('input', { style: sxInput, value: setup.cfg.sshTarget, onChange: (e) => { setup.cfg.sshTarget = e.target.value; emitSetup() }, placeholder: '手动输入，或点下方快捷地址' }),
            react.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' } },
              react.createElement('button', { className: 'sxe-btn', onClick: () => { setup.cfg.sshTarget = '127.0.0.1'; emitSetup() } }, '本机 127.0.0.1'),
              (setup.detected.tailscale || []).map((ip) => react.createElement('button', { className: 'sxe-btn', key: 'ts-' + ip, onClick: () => { setup.cfg.sshTarget = ip; emitSetup() } }, 'Tailscale ' + ip)),
              (setup.detected.lan || []).filter((ip) => !(setup.detected.tailscale || []).includes(ip)).map((ip) => react.createElement('button', { className: 'sxe-btn', key: 'lan-' + ip, onClick: () => { setup.cfg.sshTarget = ip; emitSetup() } }, '局域网 ' + ip)),
            ),
          ),
          react.createElement('label', null, '用户名',
            react.createElement('input', { style: sxInput, value: setup.cfg.sshUser, onChange: (e) => { setup.cfg.sshUser = e.target.value; emitSetup() }, placeholder: '如 root' }),
          ),
          react.createElement('label', null, 'SSH 密码（留空则用密钥认证）',
            react.createElement('input', { type: 'password', style: sxInput, value: setup.cfg.sshPassword, onChange: (e) => { setup.cfg.sshPassword = e.target.value; emitSetup() }, placeholder: '本机/远程登录密码' }),
          ),
          react.createElement('label', null, '密钥路径（可选）',
            react.createElement('input', { style: sxInput, value: setup.cfg.sshIdentity, onChange: (e) => { setup.cfg.sshIdentity = e.target.value; emitSetup() }, placeholder: '如 ~/.ssh/dsh-terminal' }),
          ),
          setup.msg ? react.createElement('div', { style: { fontSize: '12px', opacity: 0.9 } }, setup.msg) : null,
          react.createElement('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            react.createElement('button', { className: 'sxe-btn', onClick: saveConfig, disabled: setup.busy }, '保存并重连'),
            react.createElement('button', { className: 'sxe-btn', onClick: initKey, disabled: setup.busy }, '一键初始化密钥'),
            react.createElement('button', { className: 'sxe-btn', onClick: closeSetup }, '取消'),
          ),
          react.createElement('div', { style: { fontSize: '11px', opacity: 0.6 } }, '提示：终端与 SFTP 共用同一套登录；本机场景推荐留空密码、点「一键初始化密钥」。'),
        ),
      )
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
          useSetupTick()

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
                  if (typeof res.configured === 'boolean') view.configured = res.configured
                }
              } catch (e) { view.err = String(e && e.message ? e.message : e) }
              if (!cancelled) setTick((t) => t + 1)
              if (!cancelled && !view.configured) { setup.open = true; emitSetup() }
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
                  if (typeof res.auth === 'boolean' && res.auth !== view.auth) { view.auth = res.auth; changed = true }
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
              // sudo itself emits the newline after the password, so no extra
              // line break is added here.
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

          return react.createElement('div', { className: panelCls('sxe-term') },
            react.createElement('div', { className: 'sxe-term-head' },
              react.createElement('span', { className: 'sxe-term-status' }, status),
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
              react.createElement('button', { className: 'sxe-btn', onClick: toggleTheme }, setup.theme === 'modern' ? '经典样式' : '现代样式'),
              react.createElement('button', { className: 'sxe-btn', onClick: openSetup }, '设置'),
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
                      : view.auth
                        ? '输入 SSH 登录密码（隐藏显示）'
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
                  // Mask the field while a sudo command or an SSH login waits for a password.
                  type: (view.sudo || view.auth) ? 'password' : 'text',
                  placeholder: view.sudo ? '输入 sudo 密码…' : view.auth ? '输入 SSH 密码…' : '',
                  onKeyDown: onKeyDown,
                }),
              ),
            ),
            setupOverlay(),
          )
        },
      ))

      slots.inject('conversation.view', () => slots.register(
        { name: 'conversation.view', id: 'sftp', order: 21, label: 'SFTP' },
        (props) => {
          const { useState, useEffect, useRef } = react
          const [path, setPath] = useState('')
          const [entries, setEntries] = useState(null)
          const [err, setErr] = useState('')
          const [busy, setBusy] = useState(false)
          const [available, setAvailable] = useState(true)
          const [newDir, setNewDir] = useState(false)
          const [newDirName, setNewDirName] = useState('')
          const [page, setPage] = useState(0)
          const fileRef = useRef(null)
          useSetupTick()
          // Fixed page size so the panel content never stretches the view
          // area: 10 rows x 2 columns, navigated with the pager below.
          const PAGE = 20

          const load = async (p) => {
            const target = typeof p === 'string' ? p : path
            setBusy(true)
            setErr('')
            try {
              const res = await rpc('sftp-list', { path: target })
              if (res && typeof res === 'object' && typeof res.error === 'string') {
                setErr(res.error)
                setEntries(null)
              } else {
                setPath(target)
                setEntries(res && Array.isArray(res.entries) ? res.entries : [])
                setPage(0)
              }
            } catch (e) { setErr(String(e && e.message ? e.message : e)) }
            setBusy(false)
          }

          // Initialise: availability + home directory, then list it.
          useEffect(() => {
            let cancelled = false
            ;(async () => {
              let start = ''
              try {
                const res = await rpc('sftp-init', {})
                if (cancelled) return
                if (res && typeof res === 'object') {
                  if (typeof res.available === 'boolean') setAvailable(res.available)
                  if (typeof res.home === 'string' && res.home) start = res.home
                }
              } catch (e) { if (!cancelled) setErr(String(e && e.message ? e.message : e)) }
              if (!cancelled) await load(start)
            })()
            return () => { cancelled = true }
          }, [])

          const joinPath = (p, name) => {
            const base = p.replace(/\/+$/, '')
            return base ? base + '/' + name : '/' + name
          }
          const parentPath = () => {
            const base = path.replace(/\/+$/, '')
            if (!base) return '/'
            return base.split('/').slice(0, -1).join('/') || '/'
          }
          const crumbs = path.split('/').filter(Boolean)

          const fmtSize = (n) => {
            if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
            if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
            return n + ' B'
          }
          const icon = (t) => t === 'dir' ? '📁' : t === 'link' ? '🔗' : '📄'

          const download = async (name) => {
            setBusy(true)
            setErr('')
            try {
              const res = await rpc('sftp-download', { path: joinPath(path, name) })
              if (res && typeof res === 'object' && typeof res.error === 'string') {
                setErr(res.error)
              } else if (res && typeof res.data === 'string') {
                const bytes = Uint8Array.from(atob(res.data), (c) => c.charCodeAt(0))
                const url = URL.createObjectURL(new Blob([bytes]))
                const a = document.createElement('a')
                a.href = url
                a.download = res.name || name
                document.body.appendChild(a)
                a.click()
                a.remove()
                setTimeout(() => URL.revokeObjectURL(url), 10000)
              }
            } catch (e) { setErr(String(e && e.message ? e.message : e)) }
            setBusy(false)
          }

          const onPickFile = (e) => {
            const file = e.target.files && e.target.files[0]
            e.target.value = ''
            if (!file) return
            setBusy(true)
            setErr('')
            const reader = new FileReader()
            reader.onload = async () => {
              const data = String(reader.result).split(',')[1] || ''
              try {
                const res = await rpc('sftp-upload', { dir: path, name: file.name, data })
                if (res && typeof res === 'object' && typeof res.error === 'string') setErr(res.error)
                else load()
              } catch (err2) { setErr(String(err2 && err2.message ? err2.message : err2)) }
              setBusy(false)
            }
            reader.onerror = () => { setErr('读取本地文件失败'); setBusy(false) }
            reader.readAsDataURL(file)
          }

          const doMkdir = async () => {
            const name = newDirName.trim()
            if (!name) { setNewDir(false); return }
            setBusy(true)
            setErr('')
            try {
              const res = await rpc('sftp-mkdir', { path: joinPath(path, name) })
              if (res && typeof res === 'object' && typeof res.error === 'string') setErr(res.error)
              else load()
              setNewDir(false)
              setNewDirName('')
            } catch (e) { setErr(String(e && e.message ? e.message : e)) }
            setBusy(false)
          }

          const remove = async (entry) => {
            if (!window.confirm('确定删除 ' + entry.name + (entry.type === 'dir' ? '（目录，需为空）' : '') + ' ？')) return
            setBusy(true)
            setErr('')
            try {
              const res = await rpc('sftp-rm', { path: joinPath(path, entry.name), isDir: entry.type === 'dir' })
              if (res && typeof res === 'object' && typeof res.error === 'string') setErr(res.error)
              else load()
            } catch (e) { setErr(String(e && e.message ? e.message : e)) }
            setBusy(false)
          }

          // Sorted, then sliced to the current page (two columns of 8 rows).
          const sorted = [...(entries || [])].sort((a, b) => {
            if (a.type === 'dir' && b.type !== 'dir') return -1
            if (a.type !== 'dir' && b.type === 'dir') return 1
            return a.name.localeCompare(b.name)
          })
          const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE))
          const cur = Math.min(page, totalPages - 1)
          const pageEntries = sorted.slice(cur * PAGE, cur * PAGE + PAGE)

          const renderRow = (entry) => react.createElement('div', { key: entry.name, className: 'sxe-sftp-row' },
            react.createElement('span', { className: 'sxe-sftp-name' + (entry.type === 'dir' ? ' sxe-sftp-name--click' : ''), onClick: entry.type === 'dir' ? () => load(joinPath(path, entry.name)) : undefined, title: (entry.type === 'link' && entry.target ? '→ ' + entry.target : '') || (entry.mtime || ''), style: { cursor: entry.type === 'dir' ? 'pointer' : 'default' } },
              icon(entry.type) + ' ' + entry.name),
            react.createElement('span', { className: 'sxe-sftp-meta' }, entry.type === 'dir' ? '目录' : fmtSize(entry.size)),
            entry.type === 'dir'
              ? react.createElement(react.Fragment, null,
                  react.createElement('button', { className: 'sxe-btn', onClick: () => load(joinPath(path, entry.name)), disabled: busy }, '打开'),
                  react.createElement('button', { className: 'sxe-btn', onClick: () => remove(entry), disabled: busy }, '删除'))
              : react.createElement(react.Fragment, null,
                  react.createElement('button', { className: 'sxe-btn', onClick: () => download(entry.name), disabled: busy }, '下载'),
                  react.createElement('button', { className: 'sxe-btn', onClick: () => remove(entry), disabled: busy }, '删除')))

          let body = null
          if (!available) {
            body = react.createElement('div', { className: 'sxe-sftp-empty' },
              'SFTP 需要 SSH 主机。请在「终端」页签点「设置」，配置 SSH 主机/用户名/密码或密钥后使用。')
          } else if (err) {
            body = react.createElement('div', { className: 'sxe-sftp-err' }, err)
          } else if (entries === null) {
            body = react.createElement('div', { className: 'sxe-sftp-empty' }, '加载中…')
          } else if (sorted.length === 0) {
            body = react.createElement('div', { className: 'sxe-sftp-empty' }, '（空目录）')
          } else {
            body = react.createElement('div', { className: 'sxe-sftp-grid' }, pageEntries.map(renderRow))
          }

          return react.createElement('div', { className: panelCls('sxe-sftp') },
            react.createElement('div', { className: 'sxe-sftp-head' },
              react.createElement('span', { className: 'sxe-sftp-path' }, path || '/'),
              react.createElement('button', { className: 'sxe-btn', onClick: () => load(parentPath()), disabled: busy }, '上级'),
              react.createElement('button', { className: 'sxe-btn', onClick: () => load(), disabled: busy }, '刷新'),
              react.createElement('button', { className: 'sxe-btn', onClick: () => { setNewDir(true); setNewDirName('') }, disabled: busy }, '新建目录'),
              react.createElement('button', { className: 'sxe-btn', onClick: () => fileRef.current && fileRef.current.click(), disabled: busy }, '上传'),
              react.createElement('button', { className: 'sxe-btn', onClick: openSetup }, '设置'),
            ),
            newDir
              ? react.createElement('div', { className: 'sxe-sftp-newdir' },
                  react.createElement('input', { value: newDirName, onChange: (e) => setNewDirName(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') doMkdir(); if (e.key === 'Escape') setNewDir(false) }, placeholder: '目录名', autoFocus: true }),
                  react.createElement('button', { className: 'sxe-btn', onClick: doMkdir, disabled: busy }, '创建'),
                  react.createElement('button', { className: 'sxe-btn', onClick: () => setNewDir(false) }, '取消'),
                )
              : null,
            react.createElement('div', { className: 'sxe-sftp-body' },
              crumbs.length > 0
                ? react.createElement('div', { className: 'sxe-sftp-row' },
                    react.createElement('span', { className: 'sxe-sftp-name sxe-sftp-name--click', onClick: () => { setPage(0); load('/') } }, '📁 /'),
                    crumbs.map((seg, i) => react.createElement('span', { key: i, className: 'sxe-sftp-name sxe-sftp-name--click', onClick: () => { setPage(0); load('/' + crumbs.slice(0, i + 1).join('/')) } }, ' / ' + seg)),
                    react.createElement('span', { className: 'sxe-sftp-meta' }, busy ? '加载中…' : (entries ? entries.length + ' 项' : '')),
                  )
                : null,
              body,
            ),
            sorted.length > 0
              ? react.createElement('div', { className: 'sxe-sftp-foot' },
                  react.createElement('button', { className: 'sxe-btn', onClick: () => setPage(Math.max(0, cur - 1)), disabled: busy || cur <= 0 }, '上一页'),
                  react.createElement('span', null, '第 ' + (cur + 1) + ' / ' + totalPages + ' 页'),
                  react.createElement('button', { className: 'sxe-btn', onClick: () => setPage(Math.min(totalPages - 1, cur + 1)), disabled: busy || cur >= totalPages - 1 }, '下一页'),
                )
              : null,
            react.createElement('input', { ref: fileRef, type: 'file', style: { display: 'none' }, onChange: onPickFile }),
            setupOverlay(),
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
