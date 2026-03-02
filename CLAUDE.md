# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Local (直接运行)

```bash
npm install
chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper  # Apple Silicon required
npm start                        # port 3456
PORT=8080 CC_WORK_DIR=/path npm start
NGROK=1 npm start                # server + ngrok tunnel

lsof -ti:3456 | xargs kill -9   # kill existing server before restart
```

### Docker

```bash
ccd                              # 构建启动容器 + ccrd host daemon（一键）
ccd-stop                         # 停止容器
ccrd                             # 单独启动 host daemon（容器已运行时）
```

容器只跑 server（`NO_PTY=1`），PTY 通过 `ccrd` 在宿主机创建。Dashboard 点「新建」→ server 通知 ccrd → 宿主机 spawn shell → proxy 回 server。

### Shell aliases (已配置到 ~/.zshrc)

```bash
alias ccr="node <project-dir>/ccr.js"    # claude + proxy 到 server
alias ccrn="node <project-dir>/ccrn.js"   # server + ngrok + claude
alias ccrd="node <project-dir>/ccrd.js"   # host daemon（Docker 模式）
alias ccd="<project-dir>/cc-docker-start.sh"   # Docker 一键启动
alias ccd-stop="<project-dir>/cc-docker-stop.sh"  # Docker 停止
```

## Architecture

Single-file server (`server.js`) with no build step. All HTML/CSS/JS is embedded as template literal strings.

### Session types

| Type | Source | Bidirectional |
|------|--------|---------------|
| PTY session | Created from Dashboard (local mode) | Yes (full shell) |
| Monitor session | Claude Code hooks → `/hook` POST | No (read-only event log) |
| Proxy session | `ccr.js` wrapper → WebSocket | Yes (web can send input to claude) |
| Host PTY session | Dashboard + `ccrd.js` (Docker mode) | Yes (shell on host via proxy) |

### Key data structures

```js
sessions  // Map: id → { ptyProcess, scrollback, clients, waiting, preview, ... }
monitors  // Map: hookSessionId → { scrollback, clients, waiting, _proxyWs, ... }
_hostWs   // WebSocket: ccrd.js host bridge connection (Docker mode)
```

`_proxyWs` on a monitor is set when a `ccr.js` or `ccrd.js` instance registers via `proxy_init`. Input from web viewers is forwarded to `_proxyWs` as `\x00{"type":"input","data":"..."}`.

### WebSocket message handler logic

```
raw message arrives
  ├── starts with \x00  → handleControl(ws, JSON)
  ├── ws._isProxy       → append to monitor scrollback, forward to viewers, CONFIRM_RE check
  ├── viewer of proxy monitor  → forward to _proxyWs as input
  └── viewer of PTY session    → write to ptyProcess
```

### Control messages

`create`, `join`, `leave`, `resize`, `rename`, `proxy_init`, `host_init` (client→server)
`sessions`, `session_update`, `joined`, `created`, `proxy_ready`, `host_ready`, `spawn` (server→client)

### Docker mode (`NO_PTY=1`)

`create` 不再本地 spawn PTY，而是通过 `_hostWs` 发送 `spawn` 给 `ccrd.js`。`ccrd` 在宿主机创建 PTY 后用 `proxy_init` + session ID 连回 server。`proxy_init` 支持 `ctrl.id` 参数连接已有 monitor session。

### Hook event rendering (`fmtEvent`)

- `PreToolUse` Bash → command text
- `PreToolUse` Edit/MultiEdit → `-`/`+` diff lines (red/green)
- `PreToolUse` Write → file path + content preview
- `PostToolUse` Bash → stdout/stderr from `tool_response.stdout`
- `PostToolUse` Edit/Write → silent (diff already shown in Pre)
- `UserPromptSubmit` → all lines, each with `\r\n` prefix (avoids staircase)
- `Stop` → separator line

### Waiting state detection

- Monitor: `Notification` hook → `waiting=true`; `Stop` hook → `waiting=true`; `UserPromptSubmit`/`PreToolUse` → `waiting=false`
- PTY session: `CONFIRM_RE` regex on raw output → `waiting=true`; user keyboard input via WS → `waiting=false`
- Proxy session: `CONFIRM_RE` on streamed PTY data → `waiting=true`; new non-prompt data → `waiting=false`

```js
const CONFIRM_RE = /\(y\/n\)|\(Y\/n\)|\(Y\/N\)|Allow .+\?|Do you want to|\u203a\s*$/;
```

### CLAUDECODE env var

PTY sessions and `ccr.js` both set `CLAUDECODE: undefined` when spawning claude. Without this, claude refuses to launch inside another claude session.

### node-pty spawn-helper (Apple Silicon)

`chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper` must be re-run after every `npm install`.

### Docker files

- `Dockerfile` — 多阶段构建 (alpine)，编译 node-pty，运行时装 bash
- `.dockerignore` — 排除 node_modules、.git、ccr/ccrn/ccrd 等宿主机文件
- `docker-compose.yml` — 端口 3456，`NO_PTY=1`
- `cc-docker-start.sh` — `docker compose up -d` + `node ccrd.js`
- `cc-docker-stop.sh` — `docker compose down`
- `ccrd.js` — 宿主机 daemon，接收 `spawn` 请求，创建本地 PTY 并 proxy 回容器

### HTML pages

- `DASHBOARD_HTML` — session list, badge for waiting count, localStorage title overrides
- `TERMINAL_HTML` — xterm.js 5.3.0 + xterm-addon-fit 0.8.0 (CDN), quick-action bar, waiting banner
- Session titles stored in `localStorage['cc-titles']` as `{id: name}`, shared across both pages
