import test from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../extensions/daemon/daemon/registry.js';

function socket() {
  const frames = [];
  return { readyState: 1, frames, send(frame) { frames.push(JSON.parse(frame)); } };
}
function setup() {
  const registry = new Registry(), pi = socket();
  registry.register(pi, { sessionId: 's', instanceId: 'pi-1', pid: 1, cwd: '/tmp', uiVersion: 1 });
  return { registry, pi };
}
const snapshot = (pending = [{ id: 'prompt-1', method: 'select', title: 'Arbitrary third-party UI', options: ['A', 'B'] }], revision = 1) =>
  ({ version: 1, uiEpoch: 'epoch-1', revision, pending, status: {} });

test('queues a UI snapshot off-page and replays it without any expiry timer', () => {
  const { registry, pi } = setup();
  assert.equal(registry.uiSnapshot('s', 'pi-1', snapshot()), true);
  const stored = registry.sessions.get('s').uiSnapshots.get('pi-1');
  assert.equal('timer' in stored, false);
  const browser = socket(); registry.subscribe(browser, 's');
  assert.deepEqual(browser.frames.map(frame => frame.type), ['session_available', 'ui_snapshot']);
  assert.deepEqual(browser.frames[1].pending[0].options, ['A', 'B']);
  assert.deepEqual(registry.respondUI('s', 'epoch-1', { id: 'prompt-1', value: 'B' }), {});
  assert.deepEqual(pi.frames.at(-1), { type: 'ui_response', version: 1, uiEpoch: 'epoch-1', response: { id: 'prompt-1', value: 'B' } });
  // Only a Pi state update closes the prompt, not successful transmission.
  assert.equal(registry.sessions.get('s').uiSnapshots.get('pi-1').pending.length, 1);
  registry.uiSnapshot('s', 'pi-1', snapshot([], 2));
  assert.deepEqual(browser.frames.at(-1).pending, []);
});

test('routes generic confirm/input and rejects wrong epochs, response types and unknown versions', () => {
  const { registry, pi } = setup();
  assert.equal(registry.uiSnapshot('s', 'pi-1', { ...snapshot(), version: 2 }), false);
  assert.equal(registry.uiSnapshot('s', 'pi-1', snapshot([{ id: 'x', method: 'business-approval', title: 'Unsupported' }])), false);
  registry.uiSnapshot('s', 'pi-1', snapshot([{ id: 'yes', method: 'confirm', title: 'Confirm', message: 'Exact content' }]));
  assert.ok(registry.respondUI('s', 'old', { id: 'yes', confirmed: true }).error);
  assert.ok(registry.respondUI('s', 'epoch-1', { id: 'yes', value: 'true' }).error);
  assert.deepEqual(registry.respondUI('s', 'epoch-1', { id: 'yes', confirmed: false }), {});
  registry.uiSnapshot('s', 'pi-1', snapshot([{ id: 'text', method: 'input', title: 'Reason' }], 2));
  assert.deepEqual(registry.respondUI('s', 'epoch-1', { id: 'text', value: 'A reason' }), {});
  assert.equal(pi.frames.at(-1).response.value, 'A reason');
  assert.equal(registry.uiSnapshot('s', 'pi-1', snapshot([], 1)), false);
  registry.uiSnapshot('s', 'pi-1', snapshot([{ id: 'only', method: 'local-only', title: 'Terminal component', kind: 'custom' }], 3));
  assert.ok(registry.respondUI('s', 'epoch-1', { id: 'only', cancelled: true }).error);
});

test('disconnect clears only the daemon display copy and emits no artificial UI decision', () => {
  const { registry, pi } = setup(), browser = socket();
  registry.subscribe(browser, 's'); registry.uiSnapshot('s', 'pi-1', snapshot());
  registry.unregister('s', 'pi-1');
  assert.equal(pi.frames.length, 0);
  assert.equal(browser.frames.at(-1).type, 'ui_unavailable');
  registry.register(pi, { sessionId: 's', instanceId: 'pi-1', pid: 1, cwd: '/tmp', uiVersion: 1 });
  registry.uiSnapshot('s', 'pi-1', snapshot());
  assert.equal(browser.frames.at(-1).pending[0].id, 'prompt-1');
});

test('responses cannot cross sessions or target a non-writable competing instance', () => {
  const { registry, pi } = setup(), second = socket();
  registry.register(second, { sessionId: 's', instanceId: 'pi-2', pid: 2, cwd: '/tmp', uiVersion: 1 });
  registry.uiSnapshot('s', 'pi-2', { ...snapshot(), uiEpoch: 'second' });
  assert.ok(registry.respondUI('s', 'second', { id: 'prompt-1', value: 'A' }).error);
  assert.ok(registry.respondUI('another-session', 'epoch-1', { id: 'prompt-1', value: 'A' }).error);
  assert.equal(pi.frames.length, 0); assert.equal(second.frames.length, 0);
});

test('notifies a page opened before Pi registers and forwards generic notifications/acknowledgements', () => {
  const registry = new Registry(), browser = socket(); registry.subscribe(browser, 's');
  registry.register(socket(), { sessionId: 's', instanceId: 'pi-1', pid: 1, cwd: '/tmp', uiVersion: 1 });
  assert.equal(browser.frames.at(-1).type, 'session_available');
  registry.uiSnapshot('s', 'pi-1', snapshot());
  registry.uiNotification('s', 'pi-1', { version: 1, uiEpoch: 'epoch-1', message: 'Operation completed', notifyType: 'info' });
  assert.equal(browser.frames.at(-1).message, 'Operation completed');
  registry.uiResponseAck('s', 'pi-1', { version: 1, uiEpoch: 'epoch-1', id: 'prompt-1', accepted: true });
  assert.equal(browser.frames.at(-1).type, 'ui_response_ack');
  assert.equal(browser.frames.at(-1).accepted, true);
});

test('an old socket cannot unregister its replacement or retain its UI snapshot', () => {
  const { registry, pi } = setup(), replacement = socket();
  registry.uiSnapshot('s', 'pi-1', snapshot());
  registry.register(replacement, { sessionId: 's', instanceId: 'pi-1', pid: 1, cwd: '/tmp', uiVersion: 1 });
  registry.unregister('s', 'pi-1', pi);
  assert.equal(registry.sessions.get('s').instances.get('pi-1').ws, replacement);
  assert.equal(registry.sessions.get('s').uiSnapshots.size, 0);
  assert.ok(registry.respondUI('s', 'epoch-1', { id: 'prompt-1', value: 'A' }).error);
});
