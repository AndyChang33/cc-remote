#!/usr/bin/env node
'use strict';

/**
 * ccw - CC Remote Wrapper
 *
 * Run claude in iTerm2 while streaming full TTY output to CC Remote server.
 * Allows viewing and interacting with the session from any browser/phone.
 *
 * Usage:
 *   node ccw.js [claude args...]
 *   # or add to PATH and run: ccw [claude args...]
 */

const pty = require('../node_modules/node-pty');
const { WebSocket } = require('../node_modules/ws');
const os = require('os');

const SERVER = process.env.CC_REMOTE_URL || 'ws://localhost:3456/ws';
const args = process.argv.slice(2);

const sessionName = [
  'Claude',
  process.env.TERM_PROGRAM || os.hostname().split('.')[0],
  new Date().toTimeString().slice(0, 5),
].join(' @ ');

// ── Start PTY immediately ──────────────────────────────────────────────────

const cols = (process.stdout.columns || 120);
const rows = (process.stdout.rows || 40);

const p = pty.spawn('claude', args, {
  name: 'xterm-256color',
  cols, rows,
  cwd: process.cwd(),
  env: { ...process.env, CLAUDECODE: undefined },
});

// Pass-through stdin
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (data) => p.write(data.toString('utf8')));

// Handle terminal resize — skip when web viewer controls dimensions
let _remoteResize = false;
process.on('SIGWINCH', () => {
  if (_remoteResize) return;
  try { p.resize(process.stdout.columns, process.stdout.rows); } catch (_) {}
});

// ── Connect to CC Remote server (best-effort) ──────────────────────────────

let ws = null;
let proxyReady = false;
const pending = [];

function connectServer() {
  try {
    ws = new WebSocket(SERVER);

    ws.on('open', () => {
      ws.send('\x00' + JSON.stringify({ type: 'proxy_init', name: sessionName }));
    });

    ws.on('message', (raw) => {
      const str = raw.toString();
      if (str.charCodeAt(0) !== 0) return;
      try {
        const msg = JSON.parse(str.slice(1));
        if (msg.type === 'proxy_ready') {
          proxyReady = true;
          process.stderr.write('\r\n\x1b[90m[ccw] Connected to CC Remote — ' + msg.id + '\x1b[0m\r\n');
          // Flush buffered output
          for (const chunk of pending) ws.send(chunk);
          pending.length = 0;
        } else if (msg.type === 'input') {
          // Keyboard input forwarded from a web viewer
          p.write(msg.data);
        } else if (msg.type === 'resize') {
          _remoteResize = true;
          try { p.resize(msg.cols, msg.rows); } catch (_) {}
        }
      } catch (_) {}
    });

    ws.on('error', () => { ws = null; proxyReady = false; _remoteResize = false; });
    ws.on('close', () => { ws = null; proxyReady = false; _remoteResize = false; });
  } catch (_) {
    ws = null;
  }
}

connectServer();

// ── Forward PTY output → stdout + server ──────────────────────────────────

p.onData((data) => {
  process.stdout.write(data);
  if (!ws || ws.readyState !== 1) return;
  if (proxyReady) {
    ws.send(data);
  } else {
    pending.push(data);
    // Cap buffer at 500KB to avoid memory leak if server never connects
    if (pending.length > 500) pending.shift();
  }
});

p.onExit(({ exitCode }) => {
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch (_) {}
  }
  if (ws) try { ws.close(); } catch (_) {}
  process.exit(exitCode ?? 0);
});
