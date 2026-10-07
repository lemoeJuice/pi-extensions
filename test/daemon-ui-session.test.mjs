import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import { nativeUI } from './helpers/native-ui.mjs';

function inbox(socket) {
  const messages = [], waiters = [];
  socket.on('message', data => {
    const frame = JSON.parse(data.toString()), index = waiters.findIndex(item => item.match(frame));
    if (index < 0) messages.push(frame);
    else waiters.splice(index, 1)[0].done(frame);
  });
  return match => {
    const index = messages.findIndex(match);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('UI frame did not arrive')), 10000);
      waiters.push({ match, done: frame => { clearTimeout(timer); resolve(frame); } });
    });
  };
}

test('session composer places mirrored extension status above input and aligns it right', async () => {
  const html=await readFile('extensions/daemon/web/index.html','utf8');
  assert.match(html,/<form class="composer"[^>]*><div id="ui-status"[^>]*><\/div><div class="composer-inner">/);
  assert.match(html,/#ui-status\{[^}]*text-align:right/);
  assert.match(html,/status\.hidden=statusItems\.length===0/);
});

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
}

test('real daemon extension decorates shared native UI and replays the same pending prompt after daemon restart', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-ui-proxy-session-'));
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const children = [], sockets = [];
  const oldEnv = { host: process.env.PI_REMOTE_HOST, port: process.env.PI_REMOTE_PORT };
  process.env.PI_REMOTE_HOST = '127.0.0.1'; process.env.PI_REMOTE_PORT = String(port);
  let host;
  t.after(async () => {
    if (host) await host.runner.emit({ type: 'session_shutdown' });
    for (const socket of sockets) socket.close();
    for (const child of children) await stop(child);
    if (oldEnv.host === undefined) delete process.env.PI_REMOTE_HOST; else process.env.PI_REMOTE_HOST = oldEnv.host;
    if (oldEnv.port === undefined) delete process.env.PI_REMOTE_PORT; else process.env.PI_REMOTE_PORT = oldEnv.port;
    await rm(root, { recursive: true, force: true });
  });
  async function startDaemon() {
    const child = spawn(process.execPath, ['extensions/daemon/daemon/main.js'], { env: { ...process.env, PI_CODING_AGENT_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Daemon startup timed out')), 5000);
      child.stdout.on('data', chunk => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } });
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`Daemon exited ${code}`)); });
    });
    return child;
  }
  const firstDaemon = await startDaemon();
  const loaded = await loadExtensions(['extensions/daemon/index.ts'], process.cwd());
  assert.deepEqual(loaded.errors, []);
  loaded.runtime.getCommands = () => [];
  loaded.runtime.getThinkingLevel = () => 'off';
  host = nativeUI(undefined, loaded);
  const errors = [];
  host.runner.onError(error => errors.push(error));
  const sid = host.ctx.sessionManager.getSessionId();
  await host.runner.emit({ type: 'session_start', reason: 'new' });
  assert.deepEqual(errors, []);
  host.ctx.ui.setStatus('permissions','Permission mode: manual · default');
  // No plugin/approval event: an arbitrary caller uses the original local UI API.
  const confirmed = host.ctx.ui.confirm('Third-party confirmation', 'This is the full local message');
  const browser = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sid}`); sockets.push(browser);
  const next = inbox(browser); await once(browser, 'open');
  const snapshot = await next(frame => frame.type === 'ui_snapshot' && frame.pending?.[0]?.method === 'confirm').catch(error => {
    throw new Error(`${error.message}: ${JSON.stringify(host.mode.statuses)}; ${JSON.stringify(errors)}`);
  });
  assert.equal(snapshot.pending[0].message, 'This is the full local message');
  assert.equal(snapshot.status.permissions,'Permission mode: manual · default');
  assert.ok(host.mode.extensionSelector);
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${sid}/ui/responses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, uiEpoch: snapshot.uiEpoch, response: { id: snapshot.pending[0].id, confirmed: true } }),
  });
  assert.equal(response.status, 202);
  assert.equal(await confirmed, true);
  assert.equal(host.mode.extensionSelector, undefined);

  await host.runner.emit({ type: 'session_tree' });
  const navigated = await next(frame => frame.type === 'ui_snapshot' && frame.uiEpoch !== snapshot.uiEpoch);
  assert.deepEqual(navigated.pending, []);

  const pending = host.ctx.ui.select('Survive daemon restart', ['Continue']);
  const waiting = await next(frame => frame.type === 'ui_snapshot' && frame.pending?.[0]?.method === 'select');
  assert.equal(waiting.uiEpoch, navigated.uiEpoch);
  const disconnected = once(browser, 'close');
  await stop(firstDaemon); await disconnected;
  assert.ok(host.mode.extensionSelector);
  const secondDaemon = await startDaemon();
  const freshBrowser = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sid}`); sockets.push(freshBrowser);
  const freshFrames = inbox(freshBrowser); await once(freshBrowser, 'open');
  const replay = await freshFrames(frame => frame.type === 'ui_snapshot' && frame.pending?.[0]?.id === waiting.pending[0].id);
  assert.equal(replay.uiEpoch, waiting.uiEpoch);
  assert.deepEqual(replay.pending, waiting.pending);
  // Offline local completion must not wait for daemon acknowledgement or inject Deny.
  await stop(secondDaemon);
  host.mode.extensionSelector.handleInput('\n');
  assert.equal(await pending, 'Continue');
});
