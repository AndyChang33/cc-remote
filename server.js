const http = require("http");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");
const os = require("os");
const { spawn } = require("child_process");

const PORT = process.env.PORT || 3456;
const WORK_DIR = process.env.CC_WORK_DIR || os.homedir();
const SHELL = process.env.SHELL || "zsh";
const NO_PTY = process.env.NO_PTY === "1";
const MAX_SCROLLBACK = 200_000;

// Host bridge (ccrd.js on the host connects here)
let _hostWs = null;

// Claude Code 确认提示特征：(y/n) 变体、Allow X?、Do you want to、› 结尾
const CONFIRM_RE = /\(y\/n\)|\(Y\/n\)|\(Y\/N\)|Allow .+\?|Do you want to|\u203a\s*$/;

// ── Sessions ──────────────────────────────────────────────────────────────────

const sessions = new Map();
let nextId = 1;

function createSession(name) {
  const id = String(nextId++);
  const s = {
    id,
    name: name || "Shell " + id,
    ptyProcess: null,
    scrollback: "",
    clients: new Set(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
    preview: "",
    waiting: false,
    _updateTimer: null,
  };
  sessions.set(id, s);
  startPty(s);
  broadcastCtrl({ type: "sessions", data: getSessionList() });
  return s;
}

function startPty(s, cols = 120, rows = 40) {
  s.ptyProcess = pty.spawn(SHELL, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: WORK_DIR,
    env: { ...process.env, CLAUDECODE: undefined },
  });

  s.ptyProcess.onData((data) => {
    s.scrollback += data;
    if (s.scrollback.length > MAX_SCROLLBACK)
      s.scrollback = s.scrollback.slice(-MAX_SCROLLBACK);
    s.lastActivity = Date.now();
    updatePreview(s, data);
    s.clients.forEach((ws) => ws.readyState === 1 && ws.send(data));
    // 检测确认提示
    if (!s.waiting && CONFIRM_RE.test(stripAnsi(data))) {
      s.waiting = true;
    }
    scheduleUpdate(s);
  });

  s.ptyProcess.onExit(() => {
    s.ptyProcess = null;
    broadcastCtrl({ type: "session_update", session: sessionInfo(s) });
    setTimeout(() => { if (sessions.has(s.id)) startPty(s); }, 3000);
  });
}

function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b./g, "");
}

function updatePreview(s, data) {
  const lines = stripAnsi(data).split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length) s.preview = lines[lines.length - 1].slice(0, 80);
}

function scheduleUpdate(s) {
  if (s._updateTimer) return;
  s._updateTimer = setTimeout(() => {
    broadcastCtrl({ type: "session_update", session: sessionInfo(s) });
    s._updateTimer = null;
  }, 300);
}

function sessionInfo(s) {
  return {
    id: s.id,
    name: s.name,
    source: "pty",
    active: !!s.ptyProcess,
    waiting: s.waiting || false,
    createdAt: s.createdAt,
    lastActivity: s.lastActivity,
    preview: s.preview,
    archived: s.archived || false,
  };
}

// ── Monitor sessions (hook-based, read-only) ──────────────────────────────────

const monitors = new Map(); // hookSessionId → monitor object

function getOrCreateMonitor(hookSid) {
  if (!monitors.has(hookSid)) {
    monitors.set(hookSid, {
      id: "mon-" + hookSid,
      name: "Claude " + hookSid.slice(0, 6),
      source: "monitor",
      waiting: false,
      preview: "",
      scrollback: "",
      clients: new Set(),
      ptyProcess: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });
  }
  return monitors.get(hookSid);
}

function fmtEvent(data) {
  const t = new Date().toTimeString().slice(0, 8);
  const dim = "\x1b[90m", cyan = "\x1b[36m", yellow = "\x1b[33m",
        green = "\x1b[32m", red = "\x1b[31m", reset = "\x1b[0m";

  function fmtDiffLines(str, color, prefix, maxLines = 6) {
    if (!str) return "";
    const lines = str.split("\n");
    const shown = lines.slice(0, maxLines);
    const more = lines.length > maxLines ? `\r\n  ${dim}  ... (${lines.length - maxLines} more lines)${reset}` : "";
    return shown.map(l => `\r\n  ${color}${prefix} ${l}${reset}`).join("") + more;
  }

  switch (data.hook_event_name) {
    case "PreToolUse": {
      const tool = data.tool_name || "Tool";
      const inp = data.tool_input || {};

      if (tool === "Edit" && inp.file_path) {
        const header = `\r\n${dim}[${t}]${reset} ${cyan}✏️  Edit${reset} ${dim}${inp.file_path}${reset}`;
        const removed = fmtDiffLines(inp.old_string, red, "-");
        const added   = fmtDiffLines(inp.new_string, green, "+");
        return header + removed + added;
      }

      if (tool === "Write" && inp.file_path) {
        const header = `\r\n${dim}[${t}]${reset} ${cyan}📝 Write${reset} ${dim}${inp.file_path}${reset}`;
        const lines = fmtDiffLines(inp.content, green, " ", 8);
        return header + lines;
      }

      if (tool === "MultiEdit" && inp.file_path) {
        const edits = Array.isArray(inp.edits) ? inp.edits : [];
        const header = `\r\n${dim}[${t}]${reset} ${cyan}✏️  MultiEdit${reset} ${dim}${inp.file_path} (${edits.length} edits)${reset}`;
        const diff = edits.slice(0, 3).map(e =>
          fmtDiffLines(e.old_string, red, "-", 3) +
          fmtDiffLines(e.new_string, green, "+", 3)
        ).join(`\r\n  ${dim}···${reset}`);
        return header + diff;
      }

      if (tool === "Bash" && inp.command) {
        return `\r\n${dim}[${t}]${reset} ${cyan}🔧 Bash${reset}\r\n  ${inp.command.slice(0, 300)}`;
      }

      // Default: show first meaningful value
      let detail = "";
      const v = Object.values(inp)[0];
      if (v) detail = "\r\n  " + String(v).slice(0, 200);
      return `\r\n${dim}[${t}]${reset} ${cyan}🔧 ${tool}${reset}${detail}`;
    }
    case "Notification":
      return `\r\n${dim}[${t}]${reset} ${yellow}💬 ${data.message || "等待输入"}${reset}`;
    case "UserPromptSubmit": {
      const raw = data.prompt || "";
      // Claude Code TUI 会把 ⏺/● 开头的 Claude 回答也带进来，截掉
      const userOnly = raw.split(/\n(?=⏺|●)/)[0];
      const lines = userOnly.split(/\r?\n/)
        .map(l => l.replace(/^❯\s*/, "").trim())  // 去掉 shell 提示符 ❯
        .filter(l => l);
      const first = (lines[0] || "").slice(0, 200);
      const rest = lines.slice(1).map(l => `\r\n  ${green}  ${l.slice(0, 200)}${reset}`).join("");
      return `\r\n${dim}[${t}]${reset} ${green}▶ ${first}${reset}` + rest;
    }
    case "PostToolUse": {
      const tool = data.tool_name || "";
      if (tool === "Read") return "";
      const resp = data.tool_response;
      if (!resp) return "";

      // Extract text: Bash returns {stdout, stderr, ...}, others may return string
      let txt = "";
      if (typeof resp === "object" && resp !== null) {
        const out = (resp.stdout || "").trim();
        const err = (resp.stderr || "").trim();
        txt = out + (out && err ? "\n" : "") + err;
      } else {
        txt = String(resp).trim();
      }

      // Edit/Write already show diff in PreToolUse, just confirm silently
      if (!txt || tool === "Edit" || tool === "Write" || tool === "MultiEdit") return "";

      // Strip blank lines + \r, strip leading whitespace uniformly, add 4-space indent
      const normLines = txt.split("\n").map(l => l.trim()).filter(l => l);
      const shown = normLines.slice(0, 15);
      const more = normLines.length > 15 ? `\r\n    ${dim}… +${normLines.length - 15} lines${reset}` : "";
      const body = shown.map(l => `\r\n    ${dim}${l.slice(0, 160)}${reset}`).join("");
      return `\r\n  ${dim}↳${reset}` + body + more;
    }
    case "Stop":
      return `\r\n${dim}[${t}]${reset} ${green}✓ 任务结束${reset}\r\n${dim}${"─".repeat(40)}${reset}`;
    default:
      return "";
  }
}

function monitorInfo(m) {
  return {
    id: m.id,
    name: m.name,
    source: "monitor",
    active: true,
    waiting: m.waiting,
    createdAt: m.createdAt,
    lastActivity: m.lastActivity,
    preview: m.preview,
    proxyConnected: !!(m._proxyWs && m._proxyWs.readyState === 1),
    archived: m.archived || false,
  };
}

function handleHook(data) {
  const hookSid = data.session_id;
  if (!hookSid) return;
  const m = getOrCreateMonitor(hookSid);
  m.lastActivity = Date.now();
  switch (data.hook_event_name) {
    case "PreToolUse": {
      const tool = data.tool_name || "Tool";
      const inp = data.tool_input || {};
      if ((tool === "Edit" || tool === "MultiEdit") && inp.file_path) {
        const fname = inp.file_path.split("/").pop();
        const snippet = (inp.new_string || "").split("\n")[0].trim().slice(0, 40);
        m.preview = "✏️  " + fname + (snippet ? " → " + snippet : "");
      } else if (tool === "Write" && inp.file_path) {
        const fname = inp.file_path.split("/").pop();
        const lines = (inp.content || "").split("\n").length;
        m.preview = "📝 " + fname + " (" + lines + " lines)";
      } else if (tool === "Bash" && inp.command) {
        m.preview = "🔧 " + inp.command.slice(0, 60);
      } else {
        const v = Object.values(inp)[0];
        m.preview = "🔧 " + tool + (v ? ": " + String(v).slice(0, 50) : "");
      }
      m.waiting = false;
      break;
    }
    case "Notification":
      m.preview = "💬 " + (data.message || "等待输入");
      m.waiting = true;
      break;
    case "UserPromptSubmit": {
      const p = (data.prompt || "").split(/\n(?=⏺|●)/)[0]
        .replace(/^❯\s*/m, "").trim();
      if (p) m.preview = "▶ " + p.slice(0, 60);
      m.waiting = false;
      break;
    }
    case "Stop":
      m.preview = "✅ 等待下一步指令";
      m.waiting = true;
      break;
  }
  // Append formatted event to scrollback and broadcast to connected clients
  const text = fmtEvent(data);
  if (text) {
    m.scrollback += text;
    if (m.scrollback.length > MAX_SCROLLBACK) m.scrollback = m.scrollback.slice(-MAX_SCROLLBACK);
    m.clients.forEach((ws) => ws.readyState === 1 && ws.send(text));
  }
  broadcastCtrl({ type: "session_update", session: monitorInfo(m) });
}

function findMonitorById(id) {
  for (const m of monitors.values()) if (m.id === id) return m;
  return null;
}

function getSessionList() {
  const list = Array.from(sessions.values()).map(sessionInfo);
  const monList = Array.from(monitors.values()).map(monitorInfo);
  return [...list, ...monList];
}

// ── WebSocket server (forward-declared for broadcastCtrl) ─────────────────────

let wss;

function broadcastCtrl(msg) {
  if (!wss) return;
  const data = "\x00" + JSON.stringify(msg);
  wss.clients.forEach((ws) => ws.readyState === 1 && ws.send(data));
}

// ── Shared CSS ────────────────────────────────────────────────────────────────

const COMMON_CSS = `
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #0a0a0f; --surface: #12121a; --surface2: #1a1a26;
    --border: #2a2a3a; --text: #e0e0e8; --text-dim: #6a6a80;
    --accent: #6c5ce7; --green: #00e676; --red: #ff5252;
  }
  html, body { height: 100%; background: var(--bg); color: var(--text);
    font-family: system-ui, sans-serif; overflow: hidden;
    -webkit-tap-highlight-color: transparent; }
  .app { display: flex; flex-direction: column; height: 100dvh; max-width: 700px; margin: 0 auto; }
  .header { display: flex; align-items: center; gap: 10px; padding: 12px 16px;
    background: var(--surface); border-bottom: 1px solid var(--border); flex-shrink: 0; }
  .logo { width: 28px; height: 28px; background: linear-gradient(135deg,var(--accent),#a78bfa);
    border-radius: 7px; display: flex; align-items: center; justify-content: center;
    font-family: monospace; font-weight: 700; font-size: 11px; color: white; flex-shrink: 0; }
  .header-title { font-weight: 700; font-size: 15px; flex: 1; }
  .conn-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--red); flex-shrink: 0; transition: background .3s; }
  .conn-dot.on { background: var(--green); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  @keyframes spin { to{transform:rotate(360deg)} }
  .overlay { position:fixed; inset:0; background:rgba(10,10,15,.92);
    display:flex; align-items:center; justify-content:center; z-index:100; backdrop-filter:blur(8px); }
  .overlay-inner { text-align:center; color:var(--text-dim); }
  .spinner { width:32px; height:32px; border:2px solid var(--border); border-top-color:var(--accent);
    border-radius:50%; animation:spin 1s linear infinite; margin:0 auto 12px; }
  .overlay-inner p { font-size:13px; }
  .hidden { display:none!important; }
  .badge { background:#ff9100; color:#0a0a0f; border-radius:20px;
    padding:2px 8px; font-size:11px; font-weight:700; display:none; }
  .badge.show { display:inline-block; }
`;


// ── Dashboard HTML ────────────────────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>CC Remote</title>
<style>
${COMMON_CSS}
  .btn-new { padding: 6px 14px; border: none; border-radius: 20px;
    background: linear-gradient(135deg,var(--accent),#7c6cf0); color: #fff;
    font-size: 13px; font-weight: 600; cursor: pointer; }
  .btn-new:active { opacity: .8; }
  .list { flex: 1; overflow-y: auto; }
  .list::-webkit-scrollbar { width: 4px; }
  .list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
  .empty { display:flex; flex-direction:column; align-items:center;
    justify-content:center; height:100%; color:var(--text-dim); gap:12px; }
  .empty-icon { font-size:40px; }
  .empty p { font-size:14px; }
  .card { display:flex; align-items:center; gap:12px; padding:14px 16px;
    border-bottom:1px solid var(--border); cursor:pointer; transition:background .12s; }
  .card:active { background:var(--surface); }
  .card-dot { width:8px; height:8px; border-radius:50%; background:var(--text-dim); flex-shrink:0; }
  .card-dot.on { background:var(--green); animation:pulse 2s infinite; }
  .card-dot.waiting { background:#ff9100; animation:pulse 0.8s infinite;
    box-shadow:0 0 6px 2px rgba(255,145,0,.6); }
  .card-tag { font-size:10px; background:var(--surface2); color:var(--text-dim);
    padding:1px 6px; border-radius:4px; margin-left:4px; vertical-align:middle; }
  .card-body { flex:1; min-width:0; }
  .card-name { font-weight:600; font-size:14px; margin-bottom:3px; }
  .card-preview { font-family:monospace; font-size:12px; color:var(--text-dim);
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .card-meta { text-align:right; flex-shrink:0; }
  .card-time { font-size:11px; color:var(--text-dim); margin-bottom:4px; }
  .card-arrow { font-size:18px; color:var(--text-dim); }
  .edit-btn { background:transparent; border:none; font-size:14px;
    cursor:pointer; padding:2px 6px; color:var(--text-dim);
    opacity:0.5; flex-shrink:0; line-height:1; }
  .edit-btn:active { opacity:1; transform:scale(1.2); }
  .card-tag.dialog { background:#1e88e5; color:#fff; }
  .card-actions { display:flex; gap:2px; margin-top:4px; justify-content:flex-end; }
  .card-act-btn { background:transparent; border:none; font-size:13px;
    cursor:pointer; padding:2px 6px; color:var(--text-dim);
    opacity:0.5; line-height:1; }
  .card-act-btn:active { opacity:1; transform:scale(1.2); }
  .archive-section { border-top:1px solid var(--border); }
  .archive-toggle { display:flex; align-items:center; gap:8px; padding:12px 16px;
    font-size:13px; color:var(--text-dim); cursor:pointer; background:transparent;
    border:none; width:100%; text-align:left; }
  .archive-toggle:active { background:var(--surface); }
  .archive-toggle .arrow { transition:transform .2s; display:inline-block; }
  .archive-toggle .arrow.open { transform:rotate(90deg); }
  .archive-list { display:none; }
  .archive-list.open { display:block; }
  .archive-list .card { opacity:0.6; }
</style>
</head>
<body>
<div class="app">
  <div class="overlay" id="overlay">
    <div class="overlay-inner"><div class="spinner"></div><p>连接中...</p></div>
  </div>
  <div class="header">
    <div class="logo">CC</div>
    <span class="header-title">CC Remote</span>
    <div class="conn-dot" id="dot"></div>
    <span class="badge" id="badge"></span>
    <button id="soundBtn" style="background:none;border:none;font-size:18px;cursor:pointer;padding:4px;" onclick="toggleSound()"></button>
    <button class="btn-new" id="newBtn">+ 新建</button>
  </div>
  <div style="padding:8px 16px;font-size:12px;color:var(--text-dim);border-bottom:1px solid var(--border);font-family:monospace;display:flex;align-items:center;gap:6px;flex-shrink:0;">
    <span style="opacity:.5;">📡</span>
    <span id="lanAddr"></span>
    <button onclick="navigator.clipboard.writeText(document.getElementById('lanAddr').textContent).then(function(){this.textContent='已复制';var b=this;setTimeout(function(){b.textContent='复制'},1000)}.bind(this))" style="background:none;border:1px solid var(--border);border-radius:4px;color:var(--text-dim);font-size:11px;padding:2px 8px;cursor:pointer;">复制</button>
  </div>
  <script>document.getElementById('lanAddr').textContent=location.protocol+'//'+location.host;</script>
  <div class="list" id="list">
    <div class="empty" id="empty">
      <div class="empty-icon">🖥️</div>
      <p>${NO_PTY ? '运行 ccrd 后点击「新建」在宿主机创建终端' : '点击「新建」创建终端会话'}</p>
    </div>
    <div id="activeList"></div>
    <div class="archive-section hidden" id="archiveSection">
      <button class="archive-toggle" id="archiveToggle">
        <span class="arrow" id="archiveArrow">▸</span> 已归档
        <span id="archiveCount" style="font-size:11px;opacity:0.6;"></span>
      </button>
      <div class="archive-list" id="archiveList"></div>
    </div>
  </div>
</div>
<script>
(function() {
  var NUL = String.fromCharCode(0);
  var allSessions = {};
  var ws;
  var $overlay = document.getElementById('overlay');
  var $dot     = document.getElementById('dot');
  var $list    = document.getElementById('list');
  var $empty   = document.getElementById('empty');

  // ── localStorage title storage ──
  var titles = {};
  try { titles = JSON.parse(localStorage.getItem('cc-titles') || '{}'); } catch(_) {}
  function saveTitles() { try { localStorage.setItem('cc-titles', JSON.stringify(titles)); } catch(_) {} }
  function displayName(s) { return titles[s.id] || s.name; }

  function renameSession(s) {
    var cur = titles[s.id] || s.name;
    var n = prompt('重命名会话', cur);
    if (n !== null && n.trim()) {
      titles[s.id] = n.trim();
      saveTitles();
      if (ws && ws.readyState === 1) ws.send(NUL + JSON.stringify({ type: 'rename', id: s.id, name: n.trim() }));
      render();
    }
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');
    ws.onopen = function() {
      $overlay.classList.add('hidden');
      $dot.classList.add('on');
    };
    ws.onmessage = function(e) {
      var str = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data);
      if (str.charCodeAt(0) === 0) {
        try { handle(JSON.parse(str.slice(1))); } catch(_) {}
      }
    };
    ws.onclose = function() {
      $overlay.classList.remove('hidden');
      $dot.classList.remove('on');
      setTimeout(connect, 2000);
    };
    ws.onerror = function() { ws.close(); };
  }

  // Request notification permission early
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  function handle(msg) {
    if (msg.type === 'sessions') {
      allSessions = {};
      msg.data.forEach(function(s) { allSessions[s.id] = s; });
      render(); updateBadge();
    } else if (msg.type === 'session_update') {
      var prev = allSessions[msg.session.id];
      var wasWaiting = prev && prev.waiting;
      allSessions[msg.session.id] = Object.assign(prev || {}, msg.session);
      if (!wasWaiting && msg.session.waiting) notify(msg.session.name);
      render(); updateBadge();
    } else if (msg.type === 'created') {
      location.href = '/terminal?id=' + msg.session.id;
    } else if (msg.type === 'error') {
      alert(msg.message);
    }
  }

  function playDing() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.5);
    } catch(e) {}
  }

  var soundOn = localStorage.getItem('cc-sound') !== '0';
  var $soundBtn = document.getElementById('soundBtn');
  $soundBtn.textContent = soundOn ? '🔔' : '🔕';
  window.toggleSound = function() {
    soundOn = !soundOn;
    localStorage.setItem('cc-sound', soundOn ? '1' : '0');
    $soundBtn.textContent = soundOn ? '🔔' : '🔕';
  };

  function notify(name) {
    if (soundOn) playDing();
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('CC Remote — 需要输入', { body: name, silent: false });
    }
    var orig = document.title;
    document.title = '🔔 ' + orig;
    setTimeout(function() { document.title = orig; }, 4000);
  }

  function updateBadge() {
    var count = Object.values(allSessions).filter(function(s) { return s.waiting && !s.archived; }).length;
    var $badge = document.getElementById('badge');
    $badge.textContent = count;
    $badge.classList.toggle('show', count > 0);
  }

  function sendAction(type, id) {
    if (ws && ws.readyState === 1) ws.send(NUL + JSON.stringify({ type: type, id: id }));
  }

  function buildCard(s, isArchived) {
    var el = document.createElement('div');
    el.className = 'card';
    var dotClass = s.waiting ? 'waiting' : (s.active ? 'on' : '');
    var tag = '';
    if (s.source === 'monitor') {
      tag = s.proxyConnected
        ? '<span class="card-tag dialog">对话</span>'
        : '<span class="card-tag">监控</span>';
    }
    var arrow = s.source === 'monitor' ? '' : '<div class="card-arrow">›</div>';
    el.innerHTML =
      '<div class="card-dot ' + dotClass + '"></div>' +
      '<div class="card-body">' +
        '<div class="card-name">' + esc(displayName(s)) + tag + '</div>' +
        '<div class="card-preview">' + esc(s.preview || '—') + '</div>' +
      '</div>' +
      '<div class="card-meta">' +
        '<div class="card-time">' + ago(s.lastActivity) + '</div>' +
        '<div class="card-actions">' +
          '<button class="edit-btn" title="重命名">✏️</button>' +
          (isArchived
            ? '<button class="card-act-btn" title="恢复">♻️</button>'
            : '<button class="card-act-btn" title="归档">📦</button>') +
          '<button class="card-act-btn" title="删除">🗑</button>' +
        '</div>' +
        arrow +
      '</div>';
    el.querySelector('.edit-btn').onclick = function(e) { e.stopPropagation(); renameSession(s); };
    var actBtns = el.querySelectorAll('.card-act-btn');
    if (isArchived) {
      actBtns[0].onclick = function(e) { e.stopPropagation(); sendAction('unarchive', s.id); };
      actBtns[1].onclick = function(e) { e.stopPropagation(); if (confirm('确定删除？')) sendAction('delete', s.id); };
    } else {
      actBtns[0].onclick = function(e) { e.stopPropagation(); sendAction('archive', s.id); };
      actBtns[1].onclick = function(e) { e.stopPropagation(); if (confirm('确定删除？')) sendAction('delete', s.id); };
    }
    el.onclick = function() { location.href = '/terminal?id=' + s.id; };
    return el;
  }

  function render() {
    var all = Object.values(allSessions).sort(function(a, b) {
      return b.lastActivity - a.lastActivity;
    });
    var active = all.filter(function(s) { return !s.archived; });
    var archived = all.filter(function(s) { return s.archived; });

    var $active = document.getElementById('activeList');
    var $archSec = document.getElementById('archiveSection');
    var $archList = document.getElementById('archiveList');
    var $archCount = document.getElementById('archiveCount');

    if (!all.length) {
      $active.innerHTML = '';
      $archSec.classList.add('hidden');
      $empty.classList.remove('hidden');
      return;
    }
    $empty.classList.add('hidden');

    $active.innerHTML = '';
    active.forEach(function(s) { $active.appendChild(buildCard(s, false)); });

    if (archived.length) {
      $archSec.classList.remove('hidden');
      $archCount.textContent = '(' + archived.length + ')';
      $archList.innerHTML = '';
      archived.forEach(function(s) { $archList.appendChild(buildCard(s, true)); });
    } else {
      $archSec.classList.add('hidden');
    }
  }

  function ago(ts) {
    var d = Date.now() - ts;
    if (d < 60000) return '刚才';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    return Math.floor(d / 3600000) + ' 小时前';
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  document.getElementById('newBtn').onclick = function() {
    if (ws && ws.readyState === 1) ws.send(NUL + JSON.stringify({ type: 'create' }));
  };

  document.getElementById('archiveToggle').onclick = function() {
    var $list = document.getElementById('archiveList');
    var $arrow = document.getElementById('archiveArrow');
    $list.classList.toggle('open');
    $arrow.classList.toggle('open');
  };

  connect();
})();
<\/script>
</body>
</html>`;

// ── Terminal HTML ─────────────────────────────────────────────────────────────

const TERMINAL_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Terminal — CC Remote</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"><\/script>
<style>
${COMMON_CSS}
  .btn-back { padding: 5px 10px; border: 1px solid var(--border); border-radius: 8px;
    background: transparent; color: var(--text-dim); font-size: 13px; cursor: pointer; flex-shrink: 0; }
  .btn-back:active { background: var(--surface2); }
  #term { flex: 1; overflow: hidden; background: var(--bg); padding: 4px; }
  .xterm { height: 100%; }
  .quick-bar { display:flex; gap:6px; padding:8px 12px;
    padding-bottom:max(8px,env(safe-area-inset-bottom));
    border-top:1px solid var(--border); background:var(--surface);
    overflow-x:auto; flex-shrink:0; }
  .quick-bar::-webkit-scrollbar { display:none; }
  .qbtn { padding:6px 14px; border:1px solid var(--border); border-radius:20px;
    background:var(--surface2); color:var(--text); font-size:13px;
    font-family:monospace; cursor:pointer; white-space:nowrap; flex-shrink:0; }
  .qbtn:active { background:var(--border); transform:scale(.94); }
  .qbtn.danger { color:var(--red); border-color:rgba(255,82,82,.35); }
  .rename-btn { background:transparent; border:none; font-size:14px;
    cursor:pointer; padding:2px 6px; color:var(--text-dim); opacity:0.5;
    flex-shrink:0; line-height:1; }
  .rename-btn:active { opacity:1; }
  .waiting-banner { background:linear-gradient(90deg,#ff9100,#ffb347,#ff9100,#ffb347);
    background-size:300% 100%; color:#0a0a0f; text-align:center;
    padding:8px 16px; font-size:13px; font-weight:600; flex-shrink:0;
    animation:shimmer 2s linear infinite; display:flex; align-items:center;
    justify-content:center; gap:8px; }
  @keyframes shimmer { 0%{background-position:100% 0} 100%{background-position:-100% 0} }
</style>
</head>
<body>
<div class="app">
  <div class="overlay" id="overlay">
    <div class="overlay-inner"><div class="spinner"></div><p>连接中...</p></div>
  </div>
  <div class="header">
    <button class="btn-back" id="backBtn">← 返回</button>
    <div class="logo">CC</div>
    <span class="header-title" id="sessionName">Terminal</span>
    <button class="rename-btn" id="renameBtn" title="重命名">✏️</button>
    <div class="conn-dot" id="dot"></div>
  </div>
  <div id="term"></div>
  <div class="quick-bar" id="qbar"></div>
</div>
<script>
(function() {
  var params    = new URLSearchParams(location.search);
  var sessionId = params.get('id');
  if (!sessionId) { location.href = '/'; return; }

  var NUL   = String.fromCharCode(0);
  var CR    = String.fromCharCode(13);
  var CTRLC = String.fromCharCode(3);
  var CTRLD = String.fromCharCode(4);

  var $overlay = document.getElementById('overlay');
  var $dot     = document.getElementById('dot');
  var $name    = document.getElementById('sessionName');

  // ── localStorage titles ──
  var termTitles = {};
  try { termTitles = JSON.parse(localStorage.getItem('cc-titles') || '{}'); } catch(_) {}
  function saveTermTitles() { try { localStorage.setItem('cc-titles', JSON.stringify(termTitles)); } catch(_) {} }

  var currentSessionName = 'Terminal';
  function applyTitle(name) {
    currentSessionName = name;
    $name.textContent = name;
    document.title = name + ' — CC Remote';
  }

  document.getElementById('renameBtn').onclick = function() {
    var cur = termTitles[sessionId] || currentSessionName;
    var n = prompt('重命名会话', cur);
    if (n !== null && n.trim()) {
      termTitles[sessionId] = n.trim();
      saveTermTitles();
      applyTitle(n.trim());
      sendCtrl({ type: 'rename', name: n.trim() });
    }
  };

  // ── xterm.js ──
  var term = new Terminal({
    cursorBlink: true, fontSize: 13,
    fontFamily: '"JetBrains Mono","Menlo","Courier New",monospace',
    scrollback: 5000,
    theme: {
      background:'#0a0a0f', foreground:'#e0e0e8', cursor:'#6c5ce7',
      black:'#1a1a26',   red:'#ff5252',   green:'#00e676',  yellow:'#ff9100',
      blue:'#448aff',    magenta:'#a78bfa', cyan:'#00b4d8',  white:'#e0e0e8',
      brightBlack:'#6a6a80', brightRed:'#ff6b6b',   brightGreen:'#69ff96',
      brightYellow:'#ffd166', brightBlue:'#74b9ff',  brightMagenta:'#c3a0ff',
      brightCyan:'#48cae4',   brightWhite:'#ffffff',
    },
  });
  var fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('term'));

  // ── Quick actions ──
  var ACTIONS = [
    { label:'✓ Yes', data:'y'+CR },
    { label:'✗ No',  data:'n'+CR },
    { label:'继续',   data:'continue'+CR },
    { label:'⌃C',    data:CTRLC, danger:true },
    { label:'⌃D',    data:CTRLD, danger:true },
  ];
  var $qbar = document.getElementById('qbar');
  ACTIONS.forEach(function(a) {
    var btn = document.createElement('button');
    btn.className = 'qbtn' + (a.danger ? ' danger' : '');
    btn.textContent = a.label;
    btn.onclick = function() { ws && ws.readyState===1 && ws.send(a.data); term.focus(); };
    $qbar.appendChild(btn);
  });

  // ── Sound ──
  function playDing() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.5);
    } catch(e) {}
  }

  // ── Waiting state ──
  function setWaiting(waiting) {
    var existing = document.getElementById('waitingBanner');
    if (waiting && !existing) {
      if (localStorage.getItem('cc-sound') !== '0') playDing();
      var banner = document.createElement('div');
      banner.id = 'waitingBanner';
      banner.className = 'waiting-banner';
      banner.innerHTML = '💬 等待输入';
      var header = document.querySelector('.header');
      header.insertAdjacentElement('afterend', banner);
      $dot.style.background = '#ff9100';
    } else if (!waiting && existing) {
      existing.remove();
      $dot.style.background = '';
    }
  }

  // ── WebSocket ──
  var ws;

  function sendCtrl(obj) {
    if (ws && ws.readyState === 1) ws.send(NUL + JSON.stringify(obj));
  }

  function fit() {
    fitAddon.fit();
    sendCtrl({ type: 'resize', cols: term.cols, rows: term.rows });
  }

  new ResizeObserver(fit).observe(document.getElementById('term'));

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');

    ws.onopen = function() {
      $overlay.classList.add('hidden');
      $dot.classList.add('on');
      fit();
      sendCtrl({ type: 'join', id: sessionId, cols: term.cols, rows: term.rows });
    };

    ws.onmessage = function(e) {
      var str = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data);
      if (str.charCodeAt(0) === 0) {
        try {
          var msg = JSON.parse(str.slice(1));
          if (msg.type === 'joined') {
            var storedTitle = termTitles[sessionId];
            applyTitle(storedTitle || msg.session.name);
            if (msg.session.source === 'monitor') {
              if (msg.session.proxyConnected) {
                // Interactive proxy session — keep input enabled
              } else {
                term.options.disableStdin = true;
                document.getElementById('renameBtn').style.display = 'none';
                document.getElementById('qbar').innerHTML =
                  '<span style="color:var(--text-dim);font-size:12px;padding:6px 4px;">只读监控 · 在 iTerm2 中操作</span>';
              }
            }
          }
          if (msg.type === 'session_update' && msg.session.id === sessionId) {
            // Proxy connected/disconnected → toggle input
            if (msg.session.source === 'monitor') {
              term.options.disableStdin = !msg.session.proxyConnected;
            }
          }
          if (msg.type === 'session_update' && msg.session.id === sessionId) {
            setWaiting(msg.session.waiting);
          }
          if (msg.type === 'error') location.href = '/';
        } catch(_) {}
      } else {
        term.write(str);
      }
    };

    ws.onclose = function() {
      $overlay.classList.remove('hidden');
      $dot.classList.remove('on');
      setTimeout(connect, 2000);
    };

    ws.onerror = function() { ws.close(); };
  }

  // IME fix: xterm drops keyCode=229 events; intercept compositionend directly
  var _imeText = null;
  setTimeout(function() {
    var ta = document.querySelector('#term .xterm-helper-textarea');
    if (!ta) return;
    ta.addEventListener('compositionend', function(e) {
      if (!e.data) return;
      _imeText = e.data;
      if (ws && ws.readyState === 1) ws.send(e.data);
      setTimeout(function() { _imeText = null; }, 50);
    });
  }, 200);

  term.onData(function(data) {
    // Skip if xterm also fires onData for the same IME text (avoid double-send)
    if (_imeText !== null && data === _imeText) { _imeText = null; return; }
    if (ws && ws.readyState === 1) ws.send(data);
  });

  document.getElementById('backBtn').onclick = function() {
    sendCtrl({ type: 'leave' });
    location.href = '/';
  };

  connect();
})();
<\/script>
</body>
</html>`;

// ── HTTP Server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const path = req.url.split("?")[0];
  if (path === "/" || path === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(DASHBOARD_HTML);
  } else if (path === "/terminal") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(TERMINAL_HTML);
  } else if (path === "/hook" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { handleHook(JSON.parse(body)); } catch (_) {}
      res.writeHead(200);
      res.end("ok");
    });
  } else if (path === "/api/discover") {
    const sessionCount = sessions.size + monitors.size;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      name: "CC Remote",
      hostname: os.hostname(),
      platform: process.platform,
      port: Number(PORT),
      sessions: sessionCount,
    }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

// ── WebSocket Server ──────────────────────────────────────────────────────────

wss = new WebSocketServer({ noServer: true });

const clientSessions = new Map(); // ws → sessionId | null

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  clientSessions.set(ws, null);
  // Send current session list to new client
  ws.send("\x00" + JSON.stringify({ type: "sessions", data: getSessionList() }));

  ws.on("message", (raw) => {
    const str = raw.toString();
    if (str.charCodeAt(0) === 0) {
      try { handleControl(ws, JSON.parse(str.slice(1))); } catch (e) { console.error("handleControl error:", e); }
      return;
    }
    const sid = clientSessions.get(ws);
    if (!sid) return;

    // ── Proxy client: streaming raw PTY output to server ──
    if (ws._isProxy) {
      const m = findMonitorById(sid);
      if (m) {
        m.scrollback += str;
        if (m.scrollback.length > MAX_SCROLLBACK) m.scrollback = m.scrollback.slice(-MAX_SCROLLBACK);
        m.lastActivity = Date.now();
        // Forward to all viewing clients
        m.clients.forEach((c) => c.readyState === 1 && c.send(str));
        // Waiting detection via CONFIRM_RE
        const clean = stripAnsi(str);
        if (!m.waiting && CONFIRM_RE.test(clean)) {
          m.waiting = true;
          scheduleUpdate(m);
        } else if (m.waiting && clean.trim() && !CONFIRM_RE.test(clean)) {
          m.waiting = false;
          scheduleUpdate(m);
        }
      }
      return;
    }

    // ── Web viewer of a proxy monitor: forward input to proxy client ──
    const m = findMonitorById(sid);
    if (m && m._proxyWs && m._proxyWs.readyState === 1) {
      m._proxyWs.send("\x00" + JSON.stringify({ type: "input", data: str }));
      if (m.waiting) { m.waiting = false; scheduleUpdate(m); }
      return;
    }

    // ── Regular PTY session ──
    const s = sessions.get(sid);
    if (s && s.ptyProcess) {
      s.ptyProcess.write(str);
      if (s.waiting) { s.waiting = false; scheduleUpdate(s); }
    }
  });

  ws.on("close", () => {
    if (ws._isHost) _hostWs = null;
    const sid = clientSessions.get(ws);
    if (sid) {
      const s = sessions.get(sid) || findMonitorById(sid);
      if (s) s.clients.delete(ws);
      // Clean up proxy reference
      if (ws._isProxy) {
        const m = findMonitorById(sid);
        if (m) {
          m._proxyWs = null;
          broadcastCtrl({ type: "session_update", session: monitorInfo(m) });
        }
      }
    }
    clientSessions.delete(ws);
  });
});

function handleControl(ws, ctrl) {
  switch (ctrl.type) {
    case "list":
      ws.send("\x00" + JSON.stringify({ type: "sessions", data: getSessionList() }));
      break;

    case "create": {
      if (NO_PTY) {
        if (!_hostWs || _hostWs.readyState !== 1) {
          ws.send("\x00" + JSON.stringify({ type: "error", message: "ccrd 未连接，请先在宿主机运行 ccrd" }));
          break;
        }
        const hookSid = "host-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
        const m = getOrCreateMonitor(hookSid);
        m.name = ctrl.name || "Shell " + hookSid.slice(-4);
        _hostWs.send("\x00" + JSON.stringify({ type: "spawn", id: m.id, name: m.name }));
        ws.send("\x00" + JSON.stringify({ type: "created", session: monitorInfo(m) }));
        break;
      }
      const s = createSession(ctrl.name);
      ws.send("\x00" + JSON.stringify({ type: "created", session: sessionInfo(s) }));
      break;
    }

    case "join": {
      const oldSid = clientSessions.get(ws);
      if (oldSid) {
        const old = sessions.get(oldSid) || findMonitorById(oldSid);
        if (old) old.clients.delete(ws);
      }
      const s = sessions.get(ctrl.id) || findMonitorById(ctrl.id);
      if (s) {
        clientSessions.set(ws, s.id);
        s.clients.add(ws);
        if (s.scrollback) ws.send(s.scrollback);
        const info = s.source === "monitor" ? monitorInfo(s) : sessionInfo(s);
        ws.send("\x00" + JSON.stringify({ type: "joined", session: info }));
        if (ctrl.cols && ctrl.rows) {
          if (s.ptyProcess) s.ptyProcess.resize(ctrl.cols, ctrl.rows);
          if (s._proxyWs && s._proxyWs.readyState === 1)
            s._proxyWs.send("\x00" + JSON.stringify({ type: "resize", cols: ctrl.cols, rows: ctrl.rows }));
        }
      } else {
        ws.send("\x00" + JSON.stringify({ type: "error", message: "Session not found" }));
      }
      break;
    }

    case "resize": {
      const sid = clientSessions.get(ws);
      if (sid) {
        const s = sessions.get(sid);
        if (s && s.ptyProcess) s.ptyProcess.resize(ctrl.cols, ctrl.rows);
        const m = findMonitorById(sid);
        if (m && m._proxyWs && m._proxyWs.readyState === 1)
          m._proxyWs.send("\x00" + JSON.stringify({ type: "resize", cols: ctrl.cols, rows: ctrl.rows }));
      }
      break;
    }

    case "leave": {
      const sid = clientSessions.get(ws);
      if (sid) {
        const s = sessions.get(sid) || findMonitorById(sid);
        if (s) s.clients.delete(ws);
        clientSessions.set(ws, null);
      }
      break;
    }

    case "proxy_init": {
      let m;
      if (ctrl.id) {
        // Connect to existing session (from ccrd.js host daemon)
        m = findMonitorById(ctrl.id);
        if (!m) break;
      } else {
        // Create new proxy session (from ccr.js)
        const hookSid = "prx-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
        m = getOrCreateMonitor(hookSid);
        if (ctrl.name) m.name = ctrl.name.slice(0, 50);
      }
      m._proxyWs = ws;
      clientSessions.set(ws, m.id);
      ws._isProxy = true;
      ws.send("\x00" + JSON.stringify({ type: "proxy_ready", id: m.id, name: m.name }));
      broadcastCtrl({ type: "session_update", session: monitorInfo(m) });
      break;
    }

    case "host_init": {
      _hostWs = ws;
      ws._isHost = true;
      ws.send("\x00" + JSON.stringify({ type: "host_ready" }));
      break;
    }

    case "rename": {
      const s = ctrl.id
        ? (sessions.get(ctrl.id) || findMonitorById(ctrl.id))
        : (() => { const sid = clientSessions.get(ws); return sid ? (sessions.get(sid) || findMonitorById(sid)) : null; })();
      if (s && ctrl.name) {
        s.name = String(ctrl.name).slice(0, 50);
        broadcastCtrl({ type: "session_update", session: s.source === "monitor" ? monitorInfo(s) : sessionInfo(s) });
      }
      break;
    }

    case "delete": {
      const id = ctrl.id;
      if (!id) break;
      // Try PTY session
      const s = sessions.get(id);
      if (s) {
        if (s.ptyProcess) { try { s.ptyProcess.kill(); } catch (_) {} }
        if (s._updateTimer) clearTimeout(s._updateTimer);
        s.clients.forEach((c) => { clientSessions.delete(c); });
        sessions.delete(id);
        broadcastCtrl({ type: "sessions", data: getSessionList() });
        break;
      }
      // Try monitor session
      const m = findMonitorById(id);
      if (m) {
        if (m._proxyWs && m._proxyWs.readyState === 1) {
          try { m._proxyWs.close(); } catch (_) {}
        }
        m.clients.forEach((c) => { clientSessions.delete(c); });
        // Find hookSid key in monitors map
        for (const [key, val] of monitors) {
          if (val === m) { monitors.delete(key); break; }
        }
        broadcastCtrl({ type: "sessions", data: getSessionList() });
      }
      break;
    }

    case "archive": {
      const id = ctrl.id;
      if (!id) break;
      const s = sessions.get(id) || findMonitorById(id);
      if (s) {
        s.archived = true;
        broadcastCtrl({ type: "sessions", data: getSessionList() });
      }
      break;
    }

    case "unarchive": {
      const id = ctrl.id;
      if (!id) break;
      const s = sessions.get(id) || findMonitorById(id);
      if (s) {
        s.archived = false;
        broadcastCtrl({ type: "sessions", data: getSessionList() });
      }
      break;
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name in nets)
    for (const iface of nets[name])
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
  return "localhost";
}

// ── ngrok integration ─────────────────────────────────────────────────────────

function startNgrok() {
  const ngrok = spawn("ngrok", ["http", String(PORT), "--log=stdout", "--log-format=json"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  ngrok.on("error", (err) => {
    console.log("  \x1b[31m[ngrok] Failed to start: " + err.message + "\x1b[0m");
  });

  ngrok.on("close", (code) => {
    if (code) console.log("  \x1b[31m[ngrok] Exited with code " + code + "\x1b[0m");
  });

  // Parse URL from ngrok's JSON log output
  ngrok.stdout.on("data", (data) => {
    for (const line of data.toString().split("\n")) {
      if (!line.trim()) continue;
      try {
        const log = JSON.parse(line);
        if (log.url && log.url.startsWith("https://")) {
          console.log("  ╔══════════════════════════════════════════════════════════╗");
          console.log("  ║  \x1b[32m[ngrok]\x1b[0m  " + log.url + padR("", 42 - log.url.length) + "  ║");
          console.log("  ╚══════════════════════════════════════════════════════════╝");
          console.log("");
        }
      } catch (_) {}
    }
  });

  ngrok.stderr.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg) console.log("  \x1b[31m[ngrok] " + msg + "\x1b[0m");
  });

  // Clean up ngrok on exit
  process.on("exit", () => { try { ngrok.kill(); } catch (_) {} });
  process.on("SIGINT", () => { try { ngrok.kill(); } catch (_) {} process.exit(0); });
  process.on("SIGTERM", () => { try { ngrok.kill(); } catch (_) {} process.exit(0); });
}

function padR(s, n) { return s + " ".repeat(Math.max(0, n)); }

server.listen(PORT, "0.0.0.0", () => {
  const ip = getLocalIP();
  console.log("");
  console.log("  ╔══════════════════════════════════════════╗");
  console.log("  ║       CC Remote - Web Terminal           ║");
  console.log("  ╠══════════════════════════════════════════╣");
  console.log("  ║                                          ║");
  console.log(`  ║  本机: http://localhost:${PORT}              ║`);
  console.log(`  ║  手机: http://${ip}:${PORT}    ║`);
  console.log("  ║                                          ║");
  console.log("  ╚══════════════════════════════════════════╝");
  console.log("");

  // Start ngrok if NGROK=1 or --ngrok flag
  if (process.env.NGROK === "1" || process.argv.includes("--ngrok")) {
    startNgrok();
  }
});
