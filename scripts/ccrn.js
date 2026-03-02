#!/usr/bin/env node
'use strict';

/**
 * ccrn - CC Remote + Ngrok
 *
 * One command to: start server → start ngrok → launch claude with proxy.
 * Phone-accessible public URL printed automatically.
 *
 * Usage:
 *   node ccrn.js [claude args...]
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const PORT = process.env.PORT || 3456;
const ROOT = path.join(__dirname, '..');

// ── Step 1: Start server.js (background, output to stderr) ──────────────────

const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), NGROK: '1' },
});

server.stdout.on('data', (d) => process.stderr.write(d));
server.stderr.on('data', (d) => process.stderr.write(d));

server.on('error', (err) => {
  process.stderr.write('\x1b[31m[ccrn] Failed to start server: ' + err.message + '\x1b[0m\n');
  process.exit(1);
});

// ── Step 2: Wait for server to be ready, then launch ccr ─────────────────────

function waitForServer(cb) {
  let attempts = 0;
  const check = () => {
    const req = http.get(`http://127.0.0.1:${PORT}/`, (res) => {
      res.resume();
      cb();
    });
    req.on('error', () => {
      if (++attempts > 30) {
        process.stderr.write('\x1b[31m[ccrn] Server did not start in time\x1b[0m\n');
        cleanup(1);
        return;
      }
      setTimeout(check, 200);
    });
  };
  check();
}

waitForServer(() => {
  // ── Step 3: Launch ccr.js (inherits full stdio for TTY passthrough) ────────
  const ccrArgs = process.argv.slice(2);
  const ccr = spawn(process.execPath, [path.join(ROOT, 'scripts', 'ccr.js'), ...ccrArgs], {
    stdio: 'inherit',
    env: { ...process.env, CC_REMOTE_URL: `ws://localhost:${PORT}/ws` },
  });

  ccr.on('exit', (code) => cleanup(code ?? 0));
  ccr.on('error', (err) => {
    process.stderr.write('\x1b[31m[ccrn] ccr error: ' + err.message + '\x1b[0m\n');
    cleanup(1);
  });
});

// ── Cleanup ──────────────────────────────────────────────────────────────────

let exiting = false;
function cleanup(code) {
  if (exiting) return;
  exiting = true;
  try { server.kill('SIGTERM'); } catch (_) {}
  // Give server a moment to clean up ngrok, then force kill
  setTimeout(() => {
    try { server.kill('SIGKILL'); } catch (_) {}
    process.exit(code);
  }, 500);
}

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));
