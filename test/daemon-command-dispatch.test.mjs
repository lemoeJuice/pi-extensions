import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchRemoteCommand } from '../extensions/daemon/ui/command-dispatch.ts';

test('remote command acknowledges dispatch while a human UI decision is still pending', async () => {
  let finish;
  let settled = false;
  const failures = [];
  const pending = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  dispatchRemoteCommand(
    () => pending.then(value => { settled = true; return value; }),
    () => { assert.equal(settled, false); },
    error => failures.push(error.message),
  );

  assert.equal(settled, false);
  assert.deepEqual(failures, []);
  finish.reject(new Error('compaction rejected'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(failures, ['compaction rejected']);
});

test('remote command completion is also observed after an early acknowledgement', async () => {
  let settled = false;
  let acknowledged = false;
  dispatchRemoteCommand(
    async () => { await new Promise(resolve => setImmediate(resolve)); settled = true; },
    () => { acknowledged = true; },
    error => { throw error; },
  );

  assert.equal(acknowledged, true);
  assert.equal(settled, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, true);
});
