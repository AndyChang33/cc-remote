# CC Remote

Monitor and control Claude Code tasks from your phone or browser in real time.

## Install

```bash
npm install

# macOS Apple Silicon — run once after npm install
chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
```

## Quick Start

### Local

```bash
npm start
# or with custom port/directory
PORT=8080 CC_WORK_DIR=/path/to/project npm start
```

Open the address printed in the terminal. Phone and computer must be on the same WiFi.

### Docker

```bash
# One command: build container + start host daemon
ccd

# Stop
ccd-stop
```

The container runs only the server (`NO_PTY=1`). Terminal sessions are spawned on the host via `ccrd`. Click "New" in the dashboard to create a host shell.

---

## Three Usage Modes

### 1. PTY Session (Dashboard)

Click "+ New" on the web dashboard — the server spawns a real PTY shell. You can type commands and run `claude` directly in the browser. Full-duplex with color, cursor, and CJK input support.

In Docker mode, the PTY is created on the host machine via the `ccrd` daemon.

### 2. Monitor Existing Claude Code Sessions (Hooks)

Configure Claude Code hooks to report every tool call / notification to the server. The dashboard shows read-only monitor cards with event logs (tool calls + diffs + command output).

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse":      [{ "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3456/hook -H 'Content-Type: application/json' -d @- > /dev/null 2>&1 || true" }] }],
    "PostToolUse":     [{ "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3456/hook -H 'Content-Type: application/json' -d @- > /dev/null 2>&1 || true" }] }],
    "Notification":    [{ "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3456/hook -H 'Content-Type: application/json' -d @- > /dev/null 2>&1 || true" }] }],
    "UserPromptSubmit":[{ "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3456/hook -H 'Content-Type: application/json' -d @- > /dev/null 2>&1 || true" }] }],
    "Stop":            [{ "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3456/hook -H 'Content-Type: application/json' -d @- > /dev/null 2>&1 || true" }] }]
  }
}
```

Event log format:
- `Bash` — command + stdout/stderr
- `Edit` — file path + `-`/`+` diff
- `Write` — file path + content preview
- `Notification` — Claude's prompt messages
- `UserPromptSubmit` — user instructions
- `Stop` — task completed

### 3. Proxy Mode via `ccr` (Recommended)

Use `ccr` instead of `claude` in your terminal. The server receives the full PTY stream — the web view shows exactly what your terminal shows, **and you can send keyboard input from the browser/phone** (including y/n confirmations).

```bash
ccr                    # equivalent to claude
ccr --resume           # resume last conversation
```

`ccr` will:
1. Start a claude PTY immediately
2. Connect to the CC Remote server and register as a proxy stream
3. Mirror all PTY output to both your terminal and the server
4. Forward keyboard input from web viewers to the claude PTY

---

## Session Management

- **Rename**: Tap the pencil icon on a dashboard card or terminal page title
- **Title persistence**: Stored in browser `localStorage` (`cc-titles` key), persists across sessions
- **Waiting indicator**: When Claude needs input, cards show an orange dot + badge, and browser notifications fire

---

## Architecture

```
Phone / Browser
   │
   │  WebSocket /ws
   ▼
server.js (Node.js, single file)
   ├── PTY session (node-pty)              ← Dashboard "New"
   ├── Monitor session (hook events)       ← ~/.claude/settings.json hooks
   ├── Proxy session (ccr.js streaming)    ← run ccr in terminal
   └── Host PTY session (ccrd.js)          ← Docker mode "New"
         │
         └── ccrd.js ── node-pty ── host shell
```

### Docker Mode

```
┌─── Docker Container ────────┐     ┌─── Host Machine ──────────┐
│  server.js (NO_PTY=1)       │◄────│  ccrd.js (host daemon)    │
│  :3456                      │     │    ├── spawns PTY on host  │
│  web UI + hooks + proxy     │     │    └── proxy back to server│
└─────────────────────────────┘     └───────────────────────────┘
         ▲                                    ▲
     Browser                           ccr.js / claude hooks
```

### WebSocket Protocol

| Direction | Format | Meaning |
|-----------|--------|---------|
| server → client | raw bytes | terminal output |
| client → server | raw string | keyboard input (written to PTY) |
| client → server | `\x00` + JSON | control message |
| proxy → server | raw bytes | PTY stream from ccr.js / ccrd.js |
| server → proxy | `\x00{"type":"input","data":"..."}` | keyboard input from web |

### Control Messages

| type | direction | description |
|------|-----------|-------------|
| `create` | client→server | create PTY session (or host PTY in Docker mode) |
| `join` | client→server | join / switch session |
| `leave` | client→server | leave session |
| `resize` | client→server | resize terminal |
| `rename` | client→server | rename session (broadcast to all clients) |
| `proxy_init` | proxy→server | register as proxy stream; `id` param to attach to existing session |
| `host_init` | ccrd→server | register as host bridge |
| `sessions` | server→client | full session list |
| `session_update` | server→client | single session state change |
| `joined` | server→client | join success with scrollback |
| `created` | server→client | new session created |
| `proxy_ready` | server→proxy | proxy registration success |
| `host_ready` | server→ccrd | host bridge registered |
| `spawn` | server→ccrd | request host daemon to spawn a PTY |

---

## Public Access (ngrok)

By default, the server is only accessible on the local network. Use ngrok to expose it publicly.

```bash
# Option 1: manual
npm start
ngrok http 3456

# Option 2: one command (starts server + ngrok + claude)
ccrn
```

ngrok outputs an `https://xxxx.ngrok-free.app` URL — open it on your phone. WebSocket automatically uses `wss://`.

**Security note:** The ngrok URL is publicly accessible. Consider adding Basic Auth:

```bash
ngrok http 3456 --basic-auth="user:yourpassword"
```

---

## Shell Aliases

```bash
ccr              # claude + proxy to server
ccrn             # server + ngrok + claude (one command)
ccrd             # host daemon (Docker mode)
ccd              # Docker: build + start container + ccrd
ccd-stop         # Docker: stop container
```

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `PORT` | `3456` | Server port |
| `CC_WORK_DIR` | `$HOME` | Initial working directory for PTY sessions |
| `CC_REMOTE_URL` | `ws://localhost:3456/ws` | Server URL for ccr.js / ccrd.js |
| `NO_PTY` | `0` | Set to `1` to disable local PTY (Docker mode) |
| `SHELL` | System default | Shell to spawn for PTY sessions |
