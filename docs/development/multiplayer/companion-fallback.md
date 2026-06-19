# Companion fallback — manual `npx @hmanlab/multiplayer-watch`

When the plugin can't auto-spawn the companion pane (no supported terminal detected), it falls back to a copy-paste command. This document describes how that fallback works and the env vars that control it.

## Auto-install on first `mp_watch`

The plugin uses `npx -y @hmanlab/multiplayer-watch` as the default companion command. The `-y` flag tells npx to auto-install the package without prompting. On the first `mp_watch`, npm downloads the companion; subsequent runs use the npm cache (fast).

If `npx` itself is missing from `PATH`, `mp_watch` returns a clear error telling you to install Node.js (which ships with npx) or `npm install -g @hmanlab/multiplayer-watch` globally.

## Auto-spawn strategy order

The plugin picks the first viable strategy from:

| Priority | Strategy | When it triggers | What runs |
|---|---|---|---|
| 1 | `tmux` | `$TMUX` is set AND `tmux` is on `$PATH` | `tmux split-window -h -c <cwd> <cmd>` |
| 2 | `tmux-detached` | `tmux` is on `$PATH` but `$TMUX` is NOT set | `tmux new-session -d -s multiplayer-companion -c <cwd> <cmd>` |
| 3 | `iterm2` | `TERM_PROGRAM=iTerm.app` or `ITERM_SESSION_ID` set, `osascript` on PATH | AppleScript: `create tab with default profile` |
| 4 | `detached` (Windows) | `wt.exe` on PATH | `wt new-tab -d <cwd> -- <cmd>` |
| 5 | `detached` (Linux) | `gnome-terminal`, `konsole`, `wezterm` on PATH | Tab variant: `--tab` / `--new-tab` / `wezterm cli spawn` |
| 6 | `detached` (macOS) | `osascript` on PATH (Terminal.app) | `tell application "Terminal" do script "<cmd>"` |
| 7 | `detached` (Linux, window-only) | `alacritty`, `ghostty`, `kitty`, `xfce4-terminal` on PATH | New window (no CLI tab API) |
| 8 | `manual` | Nothing supported | Print `npx -y @hmanlab/multiplayer-watch` |

The default `<cmd>` is `npx -y @hmanlab/multiplayer-watch`, prefixed with `MP_COMPANION_SOCK=... MP_COMPANION_TOKEN=...` so the companion can authenticate with the plugin's UDS server.

## Manual fallback — the `npx` form

When strategy is `manual`, the plugin emits a toast:

```
Run `npx -y @hmanlab/multiplayer-watch` in another terminal
```

The `npx -y` form auto-installs the companion package and connects to the plugin's UDS socket.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `MP_NO_COMPANION` | unset | Set to `1` to disable auto-spawn entirely. |
| `MP_COMPANION_TMUX_SESSION` | `multiplayer-companion` | Name of the detached tmux session created by the `tmux-detached` strategy. |
| `MP_COMPANION_BIN` | `npx -y @hmanlab/multiplayer-watch` | The full command line to launch the companion. Set this to override (e.g. `node /path/to/multiplayer-watch.js`). |
| `MP_COMPANION_SOCK` | `~/.hl-plugins/multiplayer/companion.sock` | UDS socket path for the companion client to connect to. |
| `MP_COMPANION_TOKEN` | *(auto-generated)* | Auth token for the companion client. Generated per-session by the plugin. |
| `MP_COMPANION_TOKEN_FILE` | `~/.hl-plugins/multiplayer/companion.token` | Path to the token file. The watch process reads this as a fallback when `MP_COMPANION_TOKEN` is not set. |

## Platform notes

### macOS Terminal.app

Terminal.app does not have a clean AppleScript API for creating a new tab without UI scripting (Accessibility permissions). When macOS is detected and the terminal is not iTerm2, the plugin opens a new Terminal.app **window** instead.

### Windows Terminal

The `wt new-tab` command opens a new tab in the last active Windows Terminal window. If no Windows Terminal instance is running, a new window is created with one tab.

### Linux terminals

| Terminal | Tab support | CLI command |
|---|---|---|
| `gnome-terminal` | `--tab` | Opens a new tab in the last active window |
| `konsole` | `--new-tab` | Opens a new tab in the last active window |
| `wezterm` | `wezterm cli spawn` | Opens a new tab (if wezterm is running) |
| `kitty` | window (no tab CLI) | Opens a new window |
| `xfce4-terminal` | window | Opens a new window |
| `alacritty` | window | Opens a new window |
| `ghostty` | window | Opens a new window |

### tmux detached session

When `tmux` is installed but the user is NOT inside a tmux session, the plugin creates a detached session:

```bash
tmux new-session -d -s multiplayer-companion -c <cwd> \
  'MP_COMPANION_SOCK=... MP_COMPANION_TOKEN=... npx -y @hmanlab/multiplayer-watch'
```

The user can attach later:

```bash
tmux attach -t multiplayer-companion
```

Or switch to it from an existing tmux session:

```bash
tmux switch-client -t multiplayer-companion
```

To use a custom session name:

```bash
MP_COMPANION_TMUX_SESSION=my-session opencode
```
