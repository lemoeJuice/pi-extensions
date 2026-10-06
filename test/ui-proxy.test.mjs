import test from 'node:test';
import assert from 'node:assert/strict';
import { UIBroker } from '../extensions/daemon/ui/broker.ts';
import { installUIProxy } from '../extensions/daemon/ui/adapter.ts';

const flush = () => new Promise(resolve => setImmediate(resolve));
import { nativeUI } from './helpers/native-ui.mjs';

test('a third-party select is mirrored verbatim and remote response closes the native TUI', async () => {
  const frames = [], { ctx, mode, broker, restore } = nativeUI(frame => frames.push(frame));
  const result = ctx.ui.select('Choose <a>\nFull intent', ['First', 'Second']);
  await flush();
  assert.ok(mode.extensionSelector);
  const request = broker.snapshot().pending[0];
  assert.equal(request.title, 'Choose <a>\nFull intent');
  assert.deepEqual(request.options, ['First', 'Second']);
  assert.equal(broker.respond('wrong-epoch', { id: request.id, value: 'Second' }), false);
  assert.equal(broker.respond(broker.uiEpoch, { id: request.id, value: 'invented' }), false);
  assert.equal(broker.respond(broker.uiEpoch, { id: request.id, value: 'Second' }), true);
  assert.equal(broker.respond(broker.uiEpoch, { id: request.id, value: 'First' }), false);
  assert.equal(await result, 'Second');
  assert.equal(mode.extensionSelector, undefined);
  assert.deepEqual(frames.at(-1).pending, []);
  restore();
});

test('local response continues offline, transport errors do not deny the native prompt', async () => {
  const { ctx, mode, broker, restore } = nativeUI(() => { throw new Error('daemon offline'); });
  const result = ctx.ui.confirm('Confirm locally', 'Full message');
  await flush();
  const request = broker.snapshot().pending[0];
  mode.extensionSelector.handleInput('\n');
  assert.equal(await result, true);
  assert.equal(broker.respond(broker.uiEpoch, { id: request.id, confirmed: false }), false);
  assert.equal(mode.extensionSelector, undefined);
  restore();
});

test('native input can be submitted remotely; cancellation returns original method defaults', async () => {
  const { ctx, mode, broker, restore } = nativeUI();
  const value = ctx.ui.input('Reason', 'Enter text');
  await flush();
  const request = broker.snapshot().pending[0];
  assert.ok(mode.extensionInput);
  assert.equal(broker.respond(broker.uiEpoch, { id: request.id, value: 'A precise reason' }), true);
  assert.equal(await value, 'A precise reason');
  assert.equal(mode.extensionInput, undefined);
  const confirmed = ctx.ui.confirm('Cancel', 'No default timeout');
  await flush();
  assert.equal(broker.respond(broker.uiEpoch, { id: broker.snapshot().pending[0].id, cancelled: true }), true);
  assert.equal(await confirmed, false);
  restore();
});

test('a no-timeout native prompt survives clock advance and can be re-advertised after daemon loss', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctx, broker, restore } = nativeUI();
  let finished = false;
  const value = ctx.ui.select('Wait as long as needed', ['Continue']).then(result => { finished = true; return result; });
  await flush();
  const snapshot = broker.snapshot();
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  await flush();
  assert.equal(finished, false);
  assert.deepEqual(broker.snapshot(), snapshot);
  assert.equal('timeout' in snapshot.pending[0], false);
  broker.respond(snapshot.uiEpoch, { id: snapshot.pending[0].id, value: 'Continue' });
  assert.equal(await value, 'Continue');
  restore();
});

test('the broker serializes native prompts and propagates AbortSignal without a remote decision', async () => {
  const { ctx, mode, broker, restore } = nativeUI();
  const controller = new AbortController();
  const first = ctx.ui.select('First', ['A'], { signal: controller.signal });
  const second = ctx.ui.confirm('Second', 'Does not replace First');
  await flush();
  assert.equal(broker.snapshot().pending[0].title, 'First');
  controller.abort();
  assert.equal(await first, undefined);
  await flush();
  assert.equal(broker.snapshot().pending[0].title, 'Second');
  mode.extensionSelector.handleInput('\n');
  assert.equal(await second, true);
  restore();
});

test('runtime invalidation finishes native cleanup before a fresh UI epoch is installed', async () => {
  const { ctx, mode, broker, restore } = nativeUI();
  const value = ctx.ui.select('Old runtime', ['A']);
  await flush();
  await broker.dispose();
  assert.equal(await value, undefined);
  assert.equal(mode.extensionSelector, undefined);
  restore();
  const fresh = new UIBroker(() => {}), undo = installUIProxy(ctx.ui, fresh);
  const next = ctx.ui.confirm('New runtime', 'Fresh');
  await flush();
  assert.notEqual(fresh.uiEpoch, broker.uiEpoch);
  fresh.respond(fresh.uiEpoch, { id: fresh.snapshot().pending[0].id, confirmed: true });
  assert.equal(await next, true);
  undo();
});

test('oversized approval contents are not truncated or offered for remote response', async () => {
  const { ctx, mode, broker, restore } = nativeUI();
  const title = 'x'.repeat(70000), value = ctx.ui.select(title, ['A']);
  await flush();
  assert.equal(broker.snapshot().pending[0].method, 'local-only');
  assert.equal(mode.extensionSelector.baseTitle, title);
  assert.equal(broker.respond(broker.uiEpoch, { id: broker.snapshot().pending[0].id, value: 'A' }), false);
  mode.extensionSelector.handleInput('\n');
  assert.equal(await value, 'A');
  restore();
});

test('custom/editor remain genuinely local and their arbitrary results are preserved', async () => {
  let done;
  const { ctx, runner, broker, restore } = nativeUI();
  restore();
  runner.setUIContext({ ...runner.getUIContext(), custom: () => new Promise(resolve => { done = resolve; }),
    editor: () => new Promise(resolve => { done = resolve; }) }, 'tui');
  const undo = installUIProxy(ctx.ui, broker);
  const value = ctx.ui.custom(() => {});
  await flush();
  const prompt = broker.snapshot().pending[0];
  assert.equal(prompt.kind, 'custom');
  assert.equal(broker.respond(broker.uiEpoch, { id: prompt.id, cancelled: true }), false);
  const object = { arbitrary: ['component', 'result'] }; done(object);
  assert.equal(await value, object);
  const edit = ctx.ui.editor('Edit text', 'prefill');
  await flush();
  assert.equal(broker.snapshot().pending[0].kind, 'editor');
  done('multiline\ntext'); assert.equal(await edit, 'multiline\ntext');
  undo();
});

test('restoration never overwrites another owner and failed installation rolls back', () => {
  const { ctx, restore } = nativeUI();
  const anotherOwner = () => Promise.resolve('other');
  ctx.ui.select = anotherOwner;
  restore();
  assert.equal(ctx.ui.select, anotherOwner);
  const frozen = Object.freeze({ ...ctx.ui });
  assert.throws(() => installUIProxy(frozen, new UIBroker(() => {})), /cannot wrap/);
});

test('caller-specified timeout retains native behavior; only absent timeouts wait indefinitely', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { ctx, broker, mode, restore } = nativeUI();
  const value = ctx.ui.select('Caller timeout', ['A'], { timeout: 2000 });
  await flush();
  assert.equal(broker.snapshot().pending[0].timeout, 2000);
  t.mock.timers.tick(2000);
  assert.equal(await value, undefined);
  assert.equal(mode.extensionSelector, undefined);
  restore();
});

test('local-only custom factories can invoke another ordinary UI dialog without deadlock', async () => {
  const { ctx, runner, mode, broker, restore } = nativeUI(); restore();
  runner.setUIContext({ ...runner.getUIContext(), custom: factory => factory() }, 'tui');
  const undo = installUIProxy(ctx.ui, broker);
  const value = ctx.ui.custom(async () => ({ chosen: await ctx.ui.confirm('Nested UI', 'Same local API') }));
  await flush();
  assert.equal(broker.snapshot().pending[0].method, 'confirm');
  mode.extensionSelector.handleInput('\n');
  assert.deepEqual(await value, { chosen: true });
  assert.deepEqual(broker.snapshot().pending, []); undo();
});
