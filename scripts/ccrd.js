#!/usr/bin/env node
'use strict';

/**
 * ccrd - CC Remote Host Daemon
 *
 * Runs on the host machine, connects to a (Docker) CC Remote server.
 * When the dashboard "新建" button is clicked, spawns a PTY on the host
 * and bridges it to the server via proxy WebSocket.
 *
 * Usage:
 *   node ccrd.js
 *   CC_REMOTE_URL=ws://localhost:3456/ws node ccrd.js
 */

const pty = require('../node_modules/node-pty');
const { WebSocket } = require('../node_modules/ws');
const os = require('os');

const SERVER = process.env.CC_REMOTE_URL || 'ws://localhost:3456/ws';
const SHELL = process.env.SHELL || '/bin/zsh';
const WORK_DIR = process.env.CC_WORK_DIR || os.homedir();
const NUL = '\x00';

let ws = null;
const children = new Set();

function connect() {
  ws = new WebSocket(SERVER);

  ws.on('open', () => {
    ws.send(NUL + JSON.stringify({ type: 'host_init' }));
    console.log('[ccrd] Connected to', SERVER);
  });

  ws.on('message', (raw) => {
    const str = raw.toString();
    if (str.charCodeAt(0) !== 0) return;
    try {
      const msg = JSON.parse(str.slice(1));
      if (msg.type === 'host_ready') {
        console.log('[ccrd] Registered as host bridge');
      }
      if (msg.type === 'spawn') {
        spawnPty(msg.id, msg.name);
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    console.log('[ccrd] Disconnected, reconnecting in 2s...');
    setTimeout(connect, 2000);
  });

  ws.on('error', () => {});
}

function spawnPty(sessionId, name) {
  console.log('[ccrd] Spawning PTY:', name, '→', sessionId);

  const p = pty.spawn(SHELL, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: WORK_DIR,
    env: { ...process.env, CLAUDECODE: undefined },
  });

  children.add(p);

  const proxyWs = new WebSocket(SERVER);

  proxyWs.on('open', () => {
    proxyWs.send(NUL + JSON.stringify({ type: 'proxy_init', id: sessionId }));
  });

  proxyWs.on('message', (raw) => {
    const str = raw.toString();
    if (str.charCodeAt(0) !== 0) return;
    try {
      const msg = JSON.parse(str.slice(1));
      if (msg.type === 'proxy_ready') {
        console.log('[ccrd] Proxy ready for', msg.id);
      } else if (msg.type === 'input') {
        p.write(msg.data);
      } else if (msg.type === 'resize') {
        try { p.resize(msg.cols, msg.rows); } catch (_) {}
      }
    } catch (_) {}
  });

  proxyWs.on('close', () => {
    try { p.kill(); } catch (_) {}
    children.delete(p);
  });

  proxyWs.on('error', () => {});

  p.onData((data) => {
    if (proxyWs.readyState === 1) proxyWs.send(data);
  });

  p.onExit(() => {
    children.delete(p);
    if (proxyWs.readyState === 1) proxyWs.close();
    console.log('[ccrd] PTY exited:', name);
  });
}

connect();

process.on('SIGINT', () => {
  console.log('\n[ccrd] Shutting down...');
  children.forEach((p) => { try { p.kill(); } catch (_) {} });
  if (ws) try { ws.close(); } catch (_) {}
  process.exit(0);
});
