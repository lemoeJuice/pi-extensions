import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import { SessionManager } from '@earendil-works/pi-coding-agent';

test('the package manifest loads all extensions through the real Pi loader', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const result = await loadExtensions(manifest.pi.extensions, process.cwd());
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, manifest.pi.extensions.length);
  assert.throws(() => result.runtime.getAllTools(), /runtime not initialized/);
});

test('Pi-loaded permissions can invoke automatic review using the public pi-ai entrypoint', async () => {
  const result = await loadExtensions(['extensions/permissions/index.ts'], process.cwd());
  assert.deepEqual(result.errors, []);
  const permissions = result.extensions[0];
  let verdict = 'APPROVE';
  let reviews = 0;
  const ctx = {
    cwd: process.cwd(),
    sessionManager: SessionManager.inMemory(),
    model: { provider: 'test', id: 'reviewer' },
    signal: new AbortController().signal,
    ui: { notify() {} },
    modelRegistry: {
      streamSimple(_model, prompt) {
        reviews++;
        assert.match(prompt.systemPrompt, /permission reviewer/);
        return { result: async () => ({
          stopReason: 'stop', content: [{ type: 'text', text: verdict }],
          usage: { input: 1, output: 1 },
        }) };
      },
    },
  };
  await permissions.commands.get('permissions').handler('auto run', ctx);
  const event = { toolName: 'bash', input: { command: 'npm test', intent: 'Run project tests' } };
  const handler = permissions.handlers.get('tool_call')[0];
  assert.equal(await handler(event, ctx), undefined);
  verdict = 'DENY';
  assert.equal((await handler(event, ctx)).block, true);
  assert.equal(reviews, 2);
});

test('Pi-loaded manual permissions without UI never wait for a daemon event subscriber', { timeout: 1000 }, async () => {
  const result = await loadExtensions(['extensions/permissions/index.ts'], process.cwd());
  assert.deepEqual(result.errors, []);
  const handler = result.extensions[0].handlers.get('tool_call')[0];
  const blocked = await handler({ toolName: 'read', input: { path: '/outside/workspace/file', intent: 'Inspect the exact external file' } }, {
    cwd: process.cwd(), sessionManager: SessionManager.inMemory(), hasUI: false, ui: { select() { throw new Error('No UI must not prompt'); } },
  });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /no approval UI was available/);
});
