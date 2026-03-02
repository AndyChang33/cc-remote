# CC Remote

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

在手机/浏览器上实时监控和操控电脑上的 Claude Code 任务。

## 安装

```bash
npm install

# macOS Apple Silicon 需要额外执行一次（npm install 之后）
chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
```

## 启动

```bash
npm start
# 或自定义端口/目录
PORT=8080 CC_WORK_DIR=/path/to/project npm start
```

启动后访问终端打印的地址，手机和电脑需在同一 WiFi。

---

## 三种使用模式

### 1. PTY 会话（Dashboard 新建）

在网页 Dashboard 点击「+ 新建」，服务器会启动一个真实的 PTY shell，可以在网页里直接打字运行 `claude`。全双工，支持颜色/光标/中文输入。

### 2. 监控已有 Claude Code 会话（Hooks）

配置 Claude Code hooks，让每次工具调用/通知都上报到服务器。Dashboard 会显示监控卡片，点进去可以看事件日志（工具调用 + diff + 命令输出）。**只读，无法向 Claude 发送输入。**

在 `~/.claude/settings.json` 里加入：

```json
{
  "hooks": {
    "PreToolUse":     [{ "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3456/hook -H 'Content-Type: application/json' -d @- > /dev/null 2>&1 || true" }] }],
    "PostToolUse":    [{ "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3456/hook -H 'Content-Type: application/json' -d @- > /dev/null 2>&1 || true" }] }],
    "Notification":   [{ "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3456/hook -H 'Content-Type: application/json' -d @- > /dev/null 2>&1 || true" }] }],
    "UserPromptSubmit":[{ "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3456/hook -H 'Content-Type: application/json' -d @- > /dev/null 2>&1 || true" }] }],
    "Stop":           [{ "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3456/hook -H 'Content-Type: application/json' -d @- > /dev/null 2>&1 || true" }] }]
  }
}
```

事件日志格式：
- `🔧 Bash` — 命令内容 + 执行输出（stdout/stderr）
- `✏️ Edit` — 文件路径 + `-`/`+` diff
- `📝 Write` — 文件路径 + 内容预览
- `💬 Notification` — Claude 的提示消息
- `▶ UserPromptSubmit` — 用户输入的指令
- `✓ 任务结束` — Stop 事件

### 3. ccw 代理模式（推荐，全功能）

在 iTerm2 或任意终端里用 `ccw` 替代 `claude`。服务器会收到完整的 PTY 输出流，网页里可以看到和终端一模一样的内容，**并且可以从网页/手机发送键盘输入**（包括 y/n 选择）。

```bash
# 设置 alias（已自动添加到 ~/.zshrc，重开终端或 source 后生效）
ccw                    # 等价于 claude
ccw --resume          # 继续上次对话
```

ccw 会：
1. 立即启动 claude PTY
2. 连接到 CC Remote 服务器并注册为代理流
3. 将所有 PTY 输出同时写到终端 + 服务器（供网页查看）
4. 将网页发来的按键转发给 claude PTY

---

## 会话管理

- **重命名**：Dashboard 卡片右侧 ✏️，或终端页标题旁 ✏️，支持自定义标题
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
   ├── PTY 会话 (node-pty)           ← Dashboard 新建
   ├── Monitor 会话 (hook events)    ← ~/.claude/settings.json hooks
   └── Proxy 会话 (ccr.js 流式接入)  ← 终端里运行 ccw
         │
         └── ccr.js ── node-pty ── claude CLI
```

**WebSocket 消息协议：**

| 方向 | 格式 | 含义 |
|------|------|------|
| server → client | raw bytes | 终端输出 |
| client → server | raw string | 键盘输入（写入 PTY） |
| client → server | `\x00` + JSON | 控制消息 |
| proxy → server | raw bytes | ccr.js 推送的 PTY 流 |
| server → proxy | `\x00{"type":"input","data":"..."}` | 网页发来的键盘输入 |

**控制消息类型：**

| type | 方向 | 说明 |
|------|------|------|
| `create` | client→server | 新建 PTY 会话 |
| `join` | client→server | 加入/切换会话 |
| `leave` | client→server | 离开会话 |
| `resize` | client→server | 调整终端尺寸 |
| `rename` | client→server | 重命名会话（广播给所有客户端） |
| `proxy_init` | ccw→server | 注册为代理流，创建 monitor 条目 |
| `sessions` | server→client | 全量会话列表 |
| `session_update` | server→client | 单个会话状态变更 |
| `joined` | server→client | 加入成功，附带 scrollback |
| `created` | server→client | 新 PTY 会话创建完成 |
| `proxy_ready` | server→ccw | 代理注册成功 |

---

## 外网访问（ngrok）

默认只能局域网访问。用 ngrok 可以把服务暴露到公网，从任何地方打开。

```bash
# 1. 启动服务
npm start

# 2. 另开终端，启动隧道
ngrok http 3456
```

ngrok 会输出一个 `https://xxxx.ngrok-free.app` 地址，直接用手机浏览器打开即可。WebSocket 自动走 `wss://`，无需修改任何代码。

**安全提示：** ngrok 地址公开可访问，建议加 Basic Auth：

```bash
ngrok http 3456 --basic-auth="user:yourpassword"
```

---

## 配置

| 环境变量 | 默认值 | 说明 |
|---------|-------|------|
| `PORT` | `3456` | 服务端口 |
| `CC_WORK_DIR` | `$HOME` | PTY 会话的初始工作目录 |
| `CC_REMOTE_URL` | `ws://localhost:3456/ws` | ccr.js 连接的服务器地址 |

## License

[MIT](LICENSE)
