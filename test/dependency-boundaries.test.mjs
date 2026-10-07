import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import edit from '../extensions/edit/index.ts';
import permissions from '../extensions/permissions/index.ts';
import rollingContext from '../extensions/rolling-context/index.ts';
import { consumeOutsideWorkingDirectoryGrant, grantOutsideWorkingDirectory } from '../extensions/shared/mutation-authorization.ts';
import { parseCodexPatch, patchPaths } from '../extensions/shared/patch/codex.ts';

test('Codex patch parsing and affected paths are neutral shared semantics', () => {
  const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: moved.txt
@@
-old
+new
*** End Patch`;
  assert.equal(parseCodexPatch(patch)[0].moveTo, 'moved.txt');
  assert.deepEqual(patchPaths(patch), ['source.txt', 'moved.txt']);
});

test('outside-workspace mutation authorization is invocation-scoped and one-shot', () => {
  const invocation = {};
  grantOutsideWorkingDirectory(invocation, '/workspace', 'reviewed patch');
  assert.equal(consumeOutsideWorkingDirectoryGrant(invocation, '/workspace', 'reviewed patch'), true);
  grantOutsideWorkingDirectory(invocation, '/workspace', 'reviewed patch');
  assert.equal(consumeOutsideWorkingDirectoryGrant(invocation, '/workspace', 'modified patch'), false);
  grantOutsideWorkingDirectory(invocation, '/workspace', 'reviewed patch');
  assert.equal(consumeOutsideWorkingDirectoryGrant(invocation, '/other', 'reviewed patch'), false);
  assert.equal(consumeOutsideWorkingDirectoryGrant(invocation, '/workspace', 'reviewed patch'), false);
  assert.equal(consumeOutsideWorkingDirectoryGrant({}, '/workspace', 'reviewed patch'), false);
});

test('Rolling Context starts without requiring Design Intent tool producer markers', () => {
  const handlers = new Map();
  const pi = {
    registerFlag() {}, registerTool() {}, registerCommand() {}, appendEntry() {},
    getFlag() { return undefined; },
    getAllTools() { return [{ name: 'design_intent_query', parameters: {} }, { name: 'design_intent_get', parameters: {} }]; },
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
  };
  rollingContext(pi);
  const ctx = { sessionManager: SessionManager.inMemory(process.cwd()) };
  assert.doesNotThrow(() => handlers.get('session_start')[0]({}, ctx));
});

test('permissions approves an outside edit without a hidden parameter and edit consumes that approval once', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-dependency-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace');
  await mkdir(cwd);
  const filename = `approved-${path.basename(root)}.txt`;
  const patch = `*** Begin Patch\n*** Add File: ../${filename}\n+approved\n*** End Patch`;
  const input = { intent: 'Create the specifically requested file', patch };

  const handlers = new Map();
  const permissionPi = {
    registerTool() {}, registerCommand() {}, registerFlag() {}, appendEntry() {},
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
  };
  permissions(permissionPi);
  const manager = SessionManager.inMemory(cwd);
  const permissionContext = {
    cwd, sessionManager: manager, hasUI: true,
    ui: { select: async () => 'Allow once' },
  };
  const reviewed = await handlers.get('tool_call')[0]({ toolName: 'edit', input }, permissionContext);
  assert.equal(reviewed, undefined);
  assert.equal(Object.hasOwn(input, '__allowOutsideWorkingDirectory'), false);

  let editTool;
  const editHandlers = new Map();
  let activeTools = ['read', 'edit', 'write'];
  edit({
    registerTool(tool) { editTool = tool; },
    on(name, handler) { const list = editHandlers.get(name) ?? []; list.push(handler); editHandlers.set(name, list); },
    getActiveTools() { return activeTools; },
    setActiveTools(names) { activeTools = names; },
  });
  await editTool.execute('authorized-call', input, undefined, undefined, { cwd });
  assert.equal(await readFile(path.join(root, filename), 'utf8'), 'approved\n');

  const nextInvocation = { ...input, patch: patch.replace(filename, `unapproved-${filename}`) };
  await assert.rejects(
    editTool.execute('unapproved-call', nextInvocation, undefined, undefined, { cwd }),
    /outside the working directory/,
  );
});

test('edit owns write loadout decisions and permissions does not inspect edit internals', async () => {
  const registered = [];
  let activeTools = ['read', 'edit', 'write'];
  const hooks = new Map();
  edit({
    registerTool(tool) { registered.push(tool); },
    on(name, handler) { const list = hooks.get(name) ?? []; list.push(handler); hooks.set(name, list); },
    getActiveTools() { return activeTools; },
    setActiveTools(names) { activeTools = names; },
  });
  assert.equal(registered[0].name, 'edit');
  await hooks.get('before_agent_start')[0]();
  assert.deepEqual(activeTools, ['read', 'edit']);

  const permissionHooks = new Map();
  permissions({
    registerTool() {}, registerCommand() {}, registerFlag() {}, appendEntry() {},
    on(name, handler) { const list = permissionHooks.get(name) ?? []; list.push(handler); permissionHooks.set(name, list); },
  });
  assert.equal(permissionHooks.has('before_agent_start'), false);
  const implementation = await readFile(new URL('../extensions/permissions/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(implementation, /\.\.\/edit\/lib\//);
  assert.doesNotMatch(implementation, /__allowOutsideWorkingDirectory/);
});
