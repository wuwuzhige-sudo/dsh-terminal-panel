# dsh-terminal-panel

A manual **Terminal** tab in the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) web conversation view. Run commands on the harness host machine directly from the browser — green-on-black classic terminal look, persistent `cwd`, `sudo` password prompt, command history.

![Terminal](docs/terminal.png)

## Features

- **Terminal tab** in every conversation view (`对话 · 轨迹 · 终端` ordering)
- **Manual command execution** on the host machine via the harness `subprocess` service
- **Persistent working directory** — plain `cd` works across commands (`cd ..`, `cd ~/x`, relative paths, error messages for bad targets)
- **sudo support** — commands starting with `sudo` run with `sudo -S`, so you can type the password into the panel while the command is busy
- **Command history** (↑/↓), **Ctrl+C** to interrupt the running command, **clear screen**, **reset directory**
- **ANSI escape cleanup** — raw escape sequences never reach the panel
- **Output cap** — 512 KiB rolling buffer, so long-running output cannot blow up memory

## Install

The plugin ships as a dsh profile plugin. On the machine running `dsh web`:

```bash
# 1. Install the package into the web profile (git dependency; pnpm resolves it)
dsh plugin --profile web add <your-account>/dsh-terminal-panel

# 2. Register the plugin in the profile patch layer
cat >> ~/.dsh/profiles/web/cordis.patch.yml <<'EOF'

- insert:
    - id: dsh-terminal-panel
      name: 'dsh-terminal-panel'
      config:
        trustedHosts:
          - myhost.tailXXXX.ts.net   # optional: hosts allowed to drive the terminal
EOF

# 3. Restart the web app (adjust to how you run it)
systemctl --user restart dsh-web
```

Then hard-refresh (Ctrl+Shift+R) the `dsh web` page — the **Terminal** tab appears in the conversation view.

## Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `trustedHosts` | `string[]` | `[]` | Extra hostnames (besides loopback) allowed to call the terminal RPC. Required when the web UI is served through a reverse proxy / Tailscale Serve with a real hostname. |

## Security

> ⚠️ **This plugin executes arbitrary commands on the harness host.** Anyone who can reach the `/sxec/*` endpoints can run commands as the harness user.

- Requests are accepted **only** from loopback hosts or hosts listed in `trustedHosts` (DNS-rebinding defence).
- There is **no built-in authentication** — protect the web server itself with a reverse-proxy auth layer (e.g. Caddy `basic_auth`) when exposing it beyond localhost.
- The endpoint inherits the exposure of whatever fronts the dsh web server: bind it to loopback only, or put an authenticated proxy in front.

## How it works

- **Host half** (`lib/index.js`): a dsh plugin that registers a `/sxec/*` route family on the harness webserver (`term-init`, `term-run`, `term-send`, `term-signal`, `term-reset`, `term-read`). Commands run through the harness `subprocess` service; output is ANSI-sanitised and buffered.
- **Client half** (`lib/client.js`): registers the Terminal slot in `conversation.view` and talks to the host via same-origin `fetch('/sxec/*')` calls (no WebSocket, no extra ports).

## Development

```bash
git clone <your-account>/dsh-terminal-panel
# edit lib/index.js (host) / lib/client.js (client), then:
systemctl --user restart dsh-web   # host changes take effect immediately
# client changes need a hard refresh of the page
```

## License

MIT
