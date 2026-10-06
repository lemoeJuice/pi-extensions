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

test('session approval UI scripts parse and render proposal fields as text', async () => {
  const html = await readFile('extensions/daemon/web/index.html', 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(scripts.length, 2);
  for (const source of scripts) new Script(source);
  assert.match(html, /Design Intent approval/);
  assert.match(html, /textContent=design\?\(approval\.statement/);
  assert.match(html, /approval-reject-reason/);
});

test('approval is queued off-page, replayed on the session page, and routed to Pi', async t => {
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
  pi.send(JSON.stringify({ type: 'register', instance: { instanceId: 'pi-1', sessionId: 'session-1', pid: 123, cwd: '/tmp/project' } }));
  await piFrames.next(frame => frame.type === 'registered');
  pi.send(JSON.stringify({ type: 'approval_request', kind: 'design-intent', requestId: 'review-1', proposalId: 'DIP-123', proposalHash: 'proposal-hash', storePath: '/tmp/project/.pi/design-intent.json', baseRevision: 2, sourceHash: 'source-hash', candidateHash: 'candidate-hash', statement: 'Keep the API stable', rationale: 'Existing users depend on it', acceptDiff: '+ DI-0003' }));
  assert.equal((await piFrames.next(frame => frame.type === 'approval_delivery')).delivered, true);

  const session = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/session-1`); sockets.push(session);
  const sessionFrames = frames(session); await once(session, 'open');
  await sessionFrames.next(frame => frame.type === 'session_available');
  const queued = await sessionFrames.next(frame => frame.type === 'approval_request');
  assert.equal(queued.requestId, 'review-1');
  assert.equal(queued.kind, 'design-intent');
  assert.equal(queued.candidateHash, 'candidate-hash');

  const response = await fetch(`http://127.0.0.1:${port}/api/sessions/session-1/approvals`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'review-1', choice: 'Accept' }),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await piFrames.next(frame => frame.type === 'approval_choice'), { type: 'approval_choice', requestId: 'review-1', choice: 'Accept' });
  assert.equal((await sessionFrames.next(frame => frame.type === 'approval_resolved')).choice, 'Accept');
  pi.send(JSON.stringify({ type: 'approval_outcome', requestId: 'review-1', outcome: { ok: true, message: 'Accepted DI-0003' } }));
  assert.deepEqual((await sessionFrames.next(frame => frame.type === 'approval_resolved' && frame.outcome)).outcome, { ok: true, message: 'Accepted DI-0003' });
});
