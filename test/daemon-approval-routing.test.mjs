import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Script } from 'node:vm';
import WebSocket from 'ws';

function frames(socket) {
  const queue = [], waiters = [];
  socket.on('message', raw => {
    const value = JSON.parse(raw.toString());
    const index = waiters.findIndex(waiter => waiter.predicate(value));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(value);
    else queue.push(value);
  });
  return {
    next(predicate = () => true) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket frame')), 5000);
        waiters.push({ predicate, resolve: value => { clearTimeout(timer); resolve(value); } });
      });
    },
  };
}

test('generic UI scripts parse and contain no plugin approval branches', async () => {
  const html = await readFile('extensions/daemon/web/index.html', 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(scripts.length, 2);
  for (const source of scripts) new Script(source);
  assert.match(html, /request.method==='select'/);
  assert.match(html, /textContent=request.title/);
  assert.doesNotMatch(html, /design-intent|rolling-context-checkpoint|approval_request|proposalId/);
});

test('generic UI is queued off-page, replayed on session entry and resynchronized after reconnect', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-approval-routing-'));
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ['extensions/daemon/daemon/main.js'], {
    env: { ...process.env, PI_REMOTE_HOST: '127.0.0.1', PI_REMOTE_PORT: String(port), PI_CODING_AGENT_DIR: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    if (child.exitCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('daemon startup timed out')), 5000);
    child.stdout.on('data', data => {
      if (String(data).includes('listening')) { clearTimeout(timeout); resolve(); }
    });
    child.on('exit', code => { clearTimeout(timeout); reject(new Error(`daemon exited ${code}`)); });
  });

  const home = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions`); sockets.push(home);
  const homeFrames = frames(home); await once(home, 'open');
  await homeFrames.next(frame => frame.type === 'sessions');

  const pi = new WebSocket(`ws://127.0.0.1:${port}/internal`); sockets.push(pi);
  const piFrames = frames(pi); await once(pi, 'open');
  pi.send(JSON.stringify({ type: 'register', instance: { instanceId: 'pi-1', sessionId: 'session-1', pid: 123, cwd: '/tmp/project', uiVersion: 1 } }));
  await piFrames.next(frame => frame.type === 'registered');
  const request = { id: 'prompt-1', method: 'confirm', title: 'An arbitrary extension asks', message: 'Full local prompt content' };
  const snapshot = { type: 'ui_snapshot', version: 1, uiEpoch: 'ui-epoch', revision: 1, pending: [request], status: {} };
  pi.send(JSON.stringify(snapshot));

  const session = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/session-1`); sockets.push(session);
  const sessionFrames = frames(session); await once(session, 'open');
  await sessionFrames.next(frame => frame.type === 'session_available');
  const queued = await sessionFrames.next(frame => frame.type === 'ui_snapshot');
  assert.deepEqual(queued.pending, [request]);
  assert.equal(queued.uiEpoch, 'ui-epoch');
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions/session-1/ui/responses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, uiEpoch: 'ui-epoch', response: { id: 'prompt-1', confirmed: true } }),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await piFrames.next(frame => frame.type === 'ui_response'), { type: 'ui_response', version: 1, uiEpoch: 'ui-epoch', response: { id: 'prompt-1', confirmed: true } });
  pi.send(JSON.stringify({ type: 'ui_response_ack', version: 1, uiEpoch: 'ui-epoch', id: 'prompt-1', accepted: true }));
  assert.equal((await sessionFrames.next(frame => frame.type === 'ui_response_ack')).accepted, true);
  pi.send(JSON.stringify({ ...snapshot, revision: 2, pending: [] }));
  assert.deepEqual((await sessionFrames.next(frame => frame.type === 'ui_snapshot' && frame.revision === 2)).pending, []);

  const pending = { id: 'pending-long', method: 'select', title: 'Waiting locally', options: ['Option'] };
  pi.send(JSON.stringify({ ...snapshot, revision: 3, pending: [pending] }));
  await sessionFrames.next(frame => frame.type === 'ui_snapshot' && frame.revision === 3);
  const closed = once(pi, 'close'); pi.close(); await closed;
  await sessionFrames.next(frame => frame.type === 'ui_unavailable');
  // Pi's live broker retains the same request; a fresh daemon registration receives its snapshot.
  const reconnected = new WebSocket(`ws://127.0.0.1:${port}/internal`); sockets.push(reconnected);
  const reconnectFrames = frames(reconnected); await once(reconnected, 'open');
  reconnected.send(JSON.stringify({ type: 'register', instance: { instanceId: 'pi-1', sessionId: 'session-1', pid: 123, cwd: '/tmp/project', uiVersion: 1 } }));
  await reconnectFrames.next(frame => frame.type === 'registered');
  reconnected.send(JSON.stringify({ ...snapshot, revision: 3, pending: [pending] }));
  assert.deepEqual((await sessionFrames.next(frame => frame.type === 'ui_snapshot' && frame.revision === 3)).pending, [pending]);
  const stale = await fetch(`http://127.0.0.1:${port}/api/sessions/session-1/ui/responses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, uiEpoch: 'old-epoch', response: { id: pending.id, value: 'Option' } }),
  });
  assert.equal(stale.status, 409);
  for (const envelope of [null, [], { version: 2, uiEpoch: 'ui-epoch', response: { id: pending.id, value: 'Option' } }]) {
    const invalid = await fetch(`http://127.0.0.1:${port}/api/sessions/session-1/ui/responses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope),
    });
    assert.equal(invalid.status, 400);
  }
  reconnected.send('null');
  assert.equal((await reconnectFrames.next(frame => frame.type === 'error')).error, 'Expected an object frame');
});
