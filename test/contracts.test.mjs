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

test('optional integration surfaces an incompatible provider during initialization', () => {
  assert.throws(
    () => rollingContext(registry([{ name: 'design_intent_query', parameters: {} }])),
    /PI_GUARDRAILS_DEPENDENCY_INCOMPATIBLE.*rolling-context.*design_intent_query/,
  );
});

test('optional contracts allow absence but reject a discovered incompatible provider', () => {
  assert.equal(checkOptionalToolContract(registry([]), 'rolling-context', 'design_intent_query', DESIGN_INTENT_READ_CONTRACT), false);
  assert.throws(
    () => checkOptionalToolContract(registry([{ name: 'design_intent_query', parameters: {} }]), 'rolling-context', 'design_intent_query', DESIGN_INTENT_READ_CONTRACT),
    /PI_GUARDRAILS_DEPENDENCY_INCOMPATIBLE/,
  );
  assert.equal(checkOptionalToolContract(registry([{ name: 'design_intent_query', parameters: { 'x-pi-guardrails-contract': DESIGN_INTENT_READ_CONTRACT } }]), 'rolling-context', 'design_intent_query', DESIGN_INTENT_READ_CONTRACT), true);
});
