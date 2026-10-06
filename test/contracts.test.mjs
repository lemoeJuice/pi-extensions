import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkOptionalToolContract,
  DESIGN_INTENT_READ_CONTRACT,
  EDIT_PATCH_CONTRACT,
  PERMISSION_READ_CONTRACT,
  requireToolContract,
} from '../extensions/shared/contracts.ts';
import edit from '../extensions/edit/index.ts';
import rollingContext from '../extensions/rolling-context/index.ts';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';

function registry(tools) {
  return { getAllTools: () => tools };
}

test('required contracts fail initialization when the provider is missing or incompatible', () => {
  assert.throws(
    () => requireToolContract(registry([]), 'permissions', 'edit', EDIT_PATCH_CONTRACT),
    /PI_GUARDRAILS_DEPENDENCY_MISSING.*permissions.*edit/,
  );
  assert.throws(
    () => requireToolContract(registry([{ name: 'edit', parameters: {} }]), 'permissions', 'edit', EDIT_PATCH_CONTRACT),
    /PI_GUARDRAILS_DEPENDENCY_INCOMPATIBLE.*no contract marker/,
  );
  assert.throws(
    () => requireToolContract(registry([{ name: 'read', parameters: { 'x-pi-guardrails-contract': EDIT_PATCH_CONTRACT } }]), 'design-intent', 'read', PERMISSION_READ_CONTRACT),
    /PI_GUARDRAILS_DEPENDENCY_INCOMPATIBLE/,
  );
});

test('edit publishes its versioned contract on the parameter schema', () => {
  const tools = [];
  edit({ registerTool: (tool) => tools.push(tool) });
  assert.equal(tools[0].name, 'edit');
  assert.equal(tools[0].parameters['x-pi-guardrails-contract'], EDIT_PATCH_CONTRACT);
});

test('Rolling Context factories load with the real Pi runtime before tool actions are initialized', async () => {
  const rollingPath = 'extensions/rolling-context/index.ts';
  const designPath = 'extensions/design-intent/index.ts';
  for (const paths of [[rollingPath], [rollingPath, designPath], [designPath, rollingPath]]) {
    const result = await loadExtensions(paths, process.cwd());
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, paths.length);
    // Pi deliberately leaves actions unbound while factories register capabilities.
    assert.throws(() => result.runtime.getAllTools(), /runtime not initialized/);
    const tools = result.extensions.flatMap(extension => [...extension.tools.values()].map(tool => tool.definition));
    result.runtime.getAllTools = () => tools;
    const rolling = result.extensions.find(extension => extension.path === rollingPath);
    const ctx = { sessionManager: SessionManager.inMemory(process.cwd()), ui: { notify() {} } };
    for (const handler of rolling.handlers.get('session_start')) await handler({ type: 'session_start' }, ctx);
  }
});

test('incompatible optional providers fail at session start and cannot trigger context mutations', async () => {
  const result = await loadExtensions(['extensions/rolling-context/index.ts'], process.cwd());
  assert.deepEqual(result.errors, []);
  const rolling = result.extensions[0];
  const notices = [];
  const ctx = { sessionManager: SessionManager.inMemory(process.cwd()), ui: { notify: text => notices.push(text) } };
  for (const toolName of ['design_intent_query', 'design_intent_get']) {
    result.runtime.getAllTools = () => [{ name: toolName, parameters: {} }];
    const error = new RegExp(`PI_GUARDRAILS_DEPENDENCY_INCOMPATIBLE.*rolling-context.*${toolName}`);
    assert.throws(() => rolling.handlers.get('session_start')[0]({}, ctx), error);
    // session_start handler errors are reported by Pi, not a global runtime stop.
    await assert.rejects(rolling.handlers.get('turn_end')[0]({}, ctx), error);
    await assert.rejects(rolling.commands.get('rolling-context').handler('on', ctx), error);
    await assert.rejects(rolling.commands.get('rolling-context').handler('checkpoint', ctx), error);
    assert.equal(await rolling.handlers.get('session_before_compact')[0]({}, ctx), undefined);
    assert.match(notices.at(-1), error);
    await rolling.commands.get('rolling-context').handler('status', ctx);
    assert.match(notices.at(-1), /Rolling Context disabled/);
  }
});

test('optional contracts allow absence but reject a discovered incompatible provider', () => {
  assert.equal(checkOptionalToolContract(registry([]), 'rolling-context', 'design_intent_query', DESIGN_INTENT_READ_CONTRACT), false);
  assert.throws(
    () => checkOptionalToolContract(registry([{ name: 'design_intent_query', parameters: {} }]), 'rolling-context', 'design_intent_query', DESIGN_INTENT_READ_CONTRACT),
    /PI_GUARDRAILS_DEPENDENCY_INCOMPATIBLE/,
  );
  assert.equal(checkOptionalToolContract(registry([{ name: 'design_intent_query', parameters: { 'x-pi-guardrails-contract': DESIGN_INTENT_READ_CONTRACT } }]), 'rolling-context', 'design_intent_query', DESIGN_INTENT_READ_CONTRACT), true);
});
