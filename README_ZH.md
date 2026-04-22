# CC Remote

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
<br>[English](README.md)

在手机/浏览器上实时监控和操控电脑上的 Claude Code 任务。

## 安装

### macOS 菜单栏 App（推荐）

下载 [CCRemoteServer-v1.2.0.dmg](https://github.com/AndyChang33/cc-remote/releases/latest/download/CCRemoteServer-v1.2.0.dmg) — macOS 菜单栏应用，一键启动/停止服务器，查看用量费用，配置端口和工作目录。沙盒模式限制远程终端只能在安全目录内操作。无需终端。

1. 打开 DMG，拖入应用程序
2. 启动 — 菜单栏出现终端图标
3. 点击图标 → **启动服务器**
4. 浏览器或手机打开 `http://localhost:3456`（需同一 WiFi）

### 命令行

```bash
npm install

# macOS Apple Silicon 需要额外执行一次（npm install 之后）
chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper

npm start
# 或自定义端口/目录
PORT=8080 CC_WORK_DIR=/path/to/project npm start
```

启动后访问终端打印的地址，手机和电脑需在同一 WiFi。

### Docker

```bash
docker compose up -d          # 启动服务器容器
node scripts/ccrd.js          # 启动宿主机 daemon，用于创建终端

# 停止
docker compose down
```

或使用 shell alias（参见 [Shell Aliases](#shell-aliases)）：
```bash
ccd              # docker compose up + ccrd（一条命令）
ccd-stop         # docker compose down
```

容器只跑服务器（`NO_PTY=1`），终端会话通过 `ccrd` 在宿主机上创建。在 Dashboard 点「新建」即可创建宿主机 shell。

---

## 三种使用模式

### 1. PTY 会话（Dashboard 新建）

在网页 Dashboard 点击「+ 新建」，服务器会启动一个真实的 PTY shell，可以在网页里直接打字运行 `claude`。全双工，支持颜色/光标/中文输入。

Docker 模式下，PTY 通过 `ccrd` daemon 在宿主机上创建。

### 2. 监控已有 Claude Code 会话（Hooks）

配置 Claude Code hooks，让每次工具调用/通知都上报到服务器。Dashboard 会显示只读的监控卡片，包含事件日志（工具调用 + diff + 命令输出）。

在 `~/.claude/settings.json` 里加入：

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

事件日志格式：
- `Bash` — 命令内容 + 执行输出（stdout/stderr）
- `Edit` — 文件路径 + `-`/`+` diff
- `Write` — 文件路径 + 内容预览
- `Notification` — Claude 的提示消息
- `UserPromptSubmit` — 用户输入的指令
- `Stop` — 任务结束 + 费用/token 摘要

### 3. 代理模式 `ccr`（推荐）

在终端里用 `ccr` 替代 `claude`。服务器会收到完整的 PTY 输出流，网页里可以看到和终端一模一样的内容，**并且可以从网页/手机发送键盘输入**（包括 y/n 选择）。

```bash
ccr                    # 等价于 claude
ccr --resume           # 继续上次对话
```

`ccr` 会：
1. 立即启动 claude PTY
2. 连接到 CC Remote 服务器并注册为代理流
3. 将所有 PTY 输出同时写到终端 + 服务器（供网页查看）
4. 将网页发来的按键转发给 claude PTY

---

## 会话管理

- **重命名**：Dashboard 卡片右侧铅笔图标，或终端页标题旁铅笔图标
- **标题持久化**：存储在浏览器 `localStorage`（key: `cc-titles`），跨会话保留
- **等待提示**：当 Claude 需要输入时，卡片显示橙色圆点 + badge，触发浏览器通知

---

## 架构

```
手机/浏览器
   │
   │  WebSocket /ws
   ▼
server.js (Node.js, 单文件)
   ├── PTY 会话 (node-pty)              ← Dashboard 新建
   ├── Monitor 会话 (hook events)       ← ~/.claude/settings.json hooks
   ├── Proxy 会话 (ccr.js 流式接入)     ← 终端里运行 ccr
   └── Host PTY 会话 (ccrd.js)          ← Docker 模式新建
         │
         └── ccrd.js ── node-pty ── 宿主机 shell
```

### Docker 模式

```
┌─── Docker 容器 ─────────────┐     ┌─── 宿主机 ────────────────┐
│  server.js (NO_PTY=1)       │◄────│  ccrd.js (host daemon)    │
│  :3456                      │     │    ├── 在宿主机创建 PTY    │
│  web UI + hooks + proxy     │     │    └── proxy 回容器        │
└─────────────────────────────┘     └───────────────────────────┘
         ▲                                    ▲
     浏览器                            ccr.js / claude hooks
```

### WebSocket 消息协议

| 方向 | 格式 | 含义 |
|------|------|------|
| server → client | raw bytes | 终端输出 |
| client → server | raw string | 键盘输入（写入 PTY） |
| client → server | `\x00` + JSON | 控制消息 |
| proxy → server | raw bytes | ccr.js / ccrd.js 推送的 PTY 流 |
| server → proxy | `\x00{"type":"input","data":"..."}` | 网页发来的键盘输入 |

### 控制消息类型

| type | 方向 | 说明 |
|------|------|------|
| `create` | client→server | 新建 PTY 会话（Docker 模式下创建宿主机 PTY） |
| `join` | client→server | 加入/切换会话 |
| `leave` | client→server | 离开会话 |
| `resize` | client→server | 调整终端尺寸 |
| `rename` | client→server | 重命名会话（广播给所有客户端） |
| `proxy_init` | proxy→server | 注册为代理流；`id` 参数可连接已有会话 |
| `host_init` | ccrd→server | 注册为宿主机桥接 |
| `sessions` | server→client | 全量会话列表 |
| `session_update` | server→client | 单个会话状态变更 |
| `joined` | server→client | 加入成功，附带 scrollback |
| `created` | server→client | 新 PTY 会话创建完成 |
| `proxy_ready` | server→proxy | 代理注册成功 |
| `host_ready` | server→ccrd | 宿主机桥接已注册 |
| `spawn` | server→ccrd | 请求宿主机 daemon 创建 PTY |

---

## 外网访问（ngrok）

默认只能局域网访问。用 ngrok 可以把服务暴露到公网。

```bash
# 方式一：手动
npm start
ngrok http 3456

# 方式二：一条命令（启动 server + ngrok + claude）
ccrn
```

ngrok 会输出一个 `https://xxxx.ngrok-free.app` 地址，直接用手机浏览器打开即可。WebSocket 自动走 `wss://`。

**安全提示：** ngrok 地址公开可访问，建议加 Basic Auth：

```bash
ngrok http 3456 --basic-auth="user:yourpassword"
```

---

## Shell Aliases

```bash
ccr              # claude + proxy 到 server
ccrn             # server + ngrok + claude（一条命令）
ccrd             # 宿主机 daemon（Docker 模式）
ccd              # Docker：构建启动容器 + ccrd
ccd-stop         # Docker：停止容器
```

## 配置

| 环境变量 | 默认值 | 说明 |
|---------|-------|------|
| `PORT` | `3456` | 服务端口 |
| `CC_WORK_DIR` | `$HOME` | PTY 会话的初始工作目录 |
| `CC_REMOTE_URL` | `ws://localhost:3456/ws` | ccr.js / ccrd.js 连接的服务器地址 |
| `NO_PTY` | `0` | 设为 `1` 禁用本地 PTY（Docker 模式） |
| `SANDBOX` | `0` | 设为 `1` 限制远程终端只能在沙盒目录内操作 |
| `SANDBOX_DIR` | `~/.cc-remote/sandbox` | 沙盒目录路径 |
| `SHELL` | 系统默认 | PTY 会话使用的 shell |

## License

[MIT](LICENSE)
