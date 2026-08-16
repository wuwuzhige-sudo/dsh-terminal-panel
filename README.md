# dsh-terminal-panel

**Terminal + SFTP** tabs in the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) web conversation view. Run commands on the harness host machine directly from the browser — green-on-black classic terminal look, persistent `cwd`, `sudo` password prompt, command history — and browse/transfer files over the same SSH connection with an SFTP tab.

![Terminal](docs/terminal.png)

## Features

- **Terminal tab** in every conversation view (`对话 · 轨迹 · 终端 · SFTP` ordering)
- **SFTP tab** right next to the terminal — file browser over the **same SSH connection** (same host / user / password / key, no second login): navigate directories, upload, download, create directories, delete files and empty directories
- **Manual command execution** on the host machine via the harness `subprocess` service
- **Persistent working directory** — plain `cd` works across commands (`cd ..`, `cd ~/x`, relative paths, error messages for bad targets)
- **sudo support** — commands starting with `sudo` run with `sudo -S`; the panel masks the password field while sudo is waiting (type it at the bottom line and press Enter)
- **Command history** (↑/↓), **Ctrl+C** to interrupt the running command, **clear screen**, **reset directory**
- **Two themes** — classic green-on-black and modern black-on-white, toggled by a button next to the panel controls; the choice persists across reloads (localStorage) and applies to both tabs
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

Then hard-refresh (Ctrl+Shift+R) the `dsh web` page — the **终端** and **SFTP** tabs appear in the conversation view.

## Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `trustedHosts` | `string[]` | `[]` | Extra hostnames (besides loopback) allowed to call the terminal RPC. Required when the web UI is served through a reverse proxy / Tailscale Serve with a real hostname. |
| `sshTarget` | `string` | `''` | SSH target for command execution, e.g. `user@127.0.0.1` or `user@my-server`. Empty = run commands locally. |
| `sshIdentity` | `string` | `~/.ssh/dsh-terminal` | SSH identity file used for `sshTarget`. |
| `sshUser` | `string` | `''` | SSH username when `sshTarget` holds a bare host. |
| `sshPassword` | `string` | `''` | SSH password (delivered via `SSH_ASKPASS`, never through a pty prompt). Empty = key auth. |

### Runtime configuration (no restart needed)

Open the **设置** button in either tab (or the first-run setup panel when no
target is configured) and set host / username / password / key path — the
**Terminal and SFTP tabs share this one login**. Settings persist in
`~/.local/share/dsh-terminal-panel/config.json` and take effect on the next
command — no `cordis.patch.yml` edits or service restarts. The panel lists
the host's detected addresses (Tailscale IP first) for convenience, and a
**one-click key initialisation** for localhost targets.

### SFTP tab

The SFTP tab opens at the target user's home directory and offers:

- directory navigation (click, breadcrumbs, up button) with type/size columns
- a **two-column grid, 16 items per page** with 上一页/下一页 pager buttons —
  the panel stays the same height as the terminal (no scrolling)
- **download** files to the browser (saved via the browser download)
- **upload** files from the local machine (native file picker)
- **new directory** and **delete** (files, and empty directories only)

Transfers run through the system `sftp` client in batch mode, reusing the
terminal's SSH credentials — password auth works without extra prompts
(`SSH_ASKPASS`), key auth is used automatically when configured. The transfer
cap is **64 MB per file** (the payload crosses the HTTP layer as base64); for
larger files use `scp`/`rsync` from the terminal tab. In local mode
(`sshTarget` empty) the SFTP tab shows a hint pointing to the settings panel.

### SSH mode (why you want it)

When dsh runs sandboxed (bwrap/user namespace — the default on Linux), the
process cannot `setuid`, so **sudo is unusable** in local mode. In SSH mode
the panel keeps **one persistent `ssh -t` session (pseudo-tty)** per terminal,
exactly like an SSH client:

- commands run in the **host namespace** of the sshd server → setuid/sudo work
- **sudo asks for the password only once per 15 minutes** (credential cache
  is bound to the session's tty, just like a normal SSH terminal)
- `cd` and environment persist natively inside the session
- interactive programs (top, htop, …) work
- the same mechanism turns the panel into a remote terminal for **any** SSH host:

```yaml
- insert:
    - id: dsh-terminal-panel
      name: 'dsh-terminal-panel'
      config:
        trustedHosts:
          - myhost.tailXXXX.ts.net
        sshTarget: user@127.0.0.1      # localhost: sudo works
        # sshTarget: user@remote-host   # or any SSH host
        sshIdentity: /home/<user>/.ssh/dsh-terminal
```

Set up the identity once (one command, no password prompts afterwards):

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/dsh-terminal
# allow shell access (no port forwarding etc.):
echo "restrict,no-user-rc $(cat ~/.ssh/dsh-terminal.pub)" >> ~/.ssh/authorized_keys
# for a remote target, add the same line to the target's authorized_keys
```

> In SSH mode a completion marker is emitted after each command so the panel
> knows when the remote command finished (it is stripped from the display).
> Commands reading stdin (e.g. `sudo -S`) keep stdin open — type the password
> in the panel and press Enter; the input is masked.

## Security

> ⚠️ **This plugin executes arbitrary commands on the harness host.** Anyone who can reach the `/sxec/*` endpoints can run commands as the target user.

- Requests are accepted **only** from loopback hosts or hosts listed in `trustedHosts` (DNS-rebinding defence).
- There is **no built-in authentication** — protect the web server itself with a reverse-proxy auth layer (e.g. Caddy `basic_auth`) when exposing it beyond localhost.
- The SSH password (if configured) is stored in the user-level `config.json` (0600) and delivered to ssh via `SSH_ASKPASS`; prefer key auth on shared machines.
- The endpoint inherits the exposure of whatever fronts the dsh web server: bind it to loopback only, or put an authenticated proxy in front.

## How it works

- **Host half** (`lib/index.js`): a dsh plugin that registers a `/sxec/*` route family on the harness webserver (`term-init`, `term-run`, `term-send`, `term-signal`, `term-reset`, `term-read`, `term-config`, `term-init-key`, `sftp-init`, `sftp-list`, `sftp-mkdir`, `sftp-rm`, `sftp-download`, `sftp-upload`). Commands run either locally via `node:child_process` (bypassing the harness subprocess sandbox) or through a persistent `ssh -t` pty session when `sshTarget` is configured; output is ANSI-sanitised and buffered. SFTP operations spawn short-lived `sftp -b -` batch processes with the same credentials.
- **Client half** (`lib/client.js`): registers the **终端** and **SFTP** slots in `conversation.view` and talks to the host via same-origin `fetch('/sxec/*')` calls (no WebSocket, no extra ports). Both tabs share one settings panel and one theme.

## Development

```bash
git clone <your-account>/dsh-terminal-panel
# edit lib/index.js (host) / lib/client.js (client), then:
systemctl --user restart dsh-web   # host changes take effect immediately
# client changes need a hard refresh of the page
```

## License

MIT
