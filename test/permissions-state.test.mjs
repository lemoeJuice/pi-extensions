import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import { MODE_ENTRY, restoreMode, PermissionModes } from '../extensions/permissions/lib/mode-state.ts';
import { nativeUI } from './helpers/native-ui.mjs';
import { UIBroker } from '../extensions/daemon/ui/broker.ts';
import { installUIProxy } from '../extensions/daemon/ui/adapter.ts';

async function fixture(manager = SessionManager.inMemory()) {
  const loaded = await loadExtensions(['extensions/permissions/index.ts'], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0], prompts = [], notices = [], statuses = [], choices = [];
  let active = manager, reviews = 0;
  loaded.runtime.appendEntry = (type, data) => active.appendCustomEntry(type, data);
  const ctx = { cwd: process.cwd(), hasUI: true, get sessionManager() { return active; }, model: { provider: 'test', id: 'reviewer' },
    ui: { select: async (title, options) => { prompts.push({title, options}); return choices.shift(); }, notify: (message, type) => notices.push({message, type}), setStatus: (key, text) => statuses.push({key,text}) },
    modelRegistry: { streamSimple: () => { reviews++; return {result: async () => ({stopReason:'stop', content:[{type:'text',text:'APPROVE'}],usage:{input:1,output:1}})}; } },
  };
  const command = args => extension.commands.get('permissions').handler(args, ctx);
  const event = (name, reason = 'resume') => Promise.all((extension.handlers.get(name) ?? []).map(handler => handler({type:name,reason},ctx)));
  const call = () => extension.handlers.get('tool_call')[0]({toolName:'bash',input:{command:'npm test',intent:'Run the project tests'}},ctx);
  return { loaded, ctx, prompts, notices, statuses, choices, command, event, call, reviews: () => reviews, switchTo: value => { active = value; } };
}

const record = (sessionId, mode, schemaVersion = 1) => ({type:'custom',customType:MODE_ENTRY,data:{schemaVersion,sessionId,mode}});

test('saved mode is session-owned, session-wide and fail-closed for corrupt/future state', () => {
  assert.equal(restoreMode([record('a','auto')],'a').mode,'auto');
  assert.equal(restoreMode([record('a','auto')],'b').mode,'manual');
  assert.equal(restoreMode([record('a','auto'),record('a','manual')],'a').mode,'manual');
  for (const entry of [record('a','auto',2),record('a','invalid'),{type:'custom',customType:'permissions.config.v2',data:{sessionId:'a',mode:'auto'}},{type:'custom',customType:MODE_ENTRY,data:null}]) {
    const state = restoreMode([record('a','auto'),entry],'a'); assert.equal(state.mode,'manual'); assert.ok(state.diagnostic);
  }
});

test('Switch to auto asks its lifetime and temporary choice survives same-process reload but not a fresh run', async () => {
  const f = await fixture(); f.choices.push('Switch to auto','This TUI run only');
  assert.equal(await f.call(),undefined); assert.equal(f.reviews(),1);
  assert.deepEqual(f.prompts[1].options,['This TUI run only','Persist for this session']);
  assert.equal(f.ctx.sessionManager.getEntries().filter(entry=>entry.customType===MODE_ENTRY).length,0);
  const reloaded = await fixture(f.ctx.sessionManager); await reloaded.event('session_start');
  assert.equal(await reloaded.call(),undefined); assert.equal(reloaded.prompts.length,0);
  await reloaded.event('session_shutdown','reload'); await reloaded.command(''); assert.match(reloaded.notices.at(-1).message,/auto/);
  const fresh = new PermissionModes(new Map());
  assert.equal(fresh.get(f.ctx).mode,'manual');
  await reloaded.event('session_shutdown','quit'); await reloaded.command(''); assert.match(reloaded.notices.at(-1).message,/manual/);
});

test('session switches and tree navigation do not leak or rewind temporary mode; forks default manual', async () => {
  const a = SessionManager.inMemory(), b = SessionManager.inMemory(), f = await fixture(a);
  await f.command('auto run'); f.switchTo(b); await f.event('session_start');
  assert.match(f.statuses.at(-1).text,/manual/);
  f.switchTo(a); await f.event('session_start'); await f.event('session_tree');
  assert.match(f.statuses.at(-1).text,/auto/);
  const copied = SessionManager.inMemory(); copied.appendCustomEntry(MODE_ENTRY,{schemaVersion:1,sessionId:a.getSessionId(),mode:'auto'});
  f.switchTo(copied); await f.event('session_start'); assert.match(f.statuses.at(-1).text,/manual/);
});

test('persistent choice is saved in the actual session file and restores without another prompt', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(),'pi-permissions-mode-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const manager = SessionManager.create(process.cwd(),root); manager.appendMessage({role:'user',content:'Run tests',timestamp:Date.now()});
  const f = await fixture(manager); f.choices.push('Switch to auto','Persist for this session'); assert.equal(await f.call(),undefined);
  const entries = (await readFile(manager.getSessionFile(),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(entries.find(entry=>entry.customType===MODE_ENTRY).data.mode,'auto');
  const resumed = SessionManager.open(manager.getSessionFile()), fresh = new PermissionModes(new Map());
  assert.equal(fresh.get({...f.ctx,sessionManager:resumed}).mode,'auto');
  const restarted = await fixture(resumed); await restarted.event('session_start');
  assert.equal(await restarted.call(),undefined); assert.equal(restarted.prompts.length,0);
  const fork = SessionManager.forkFrom(manager.getSessionFile(),process.cwd(),root);
  assert.equal(fresh.get({...f.ctx,sessionManager:fork}).mode,'manual');
  await f.command('manual'); manager.branch(manager.getEntries()[0].id); await f.event('session_tree');
  assert.match(f.statuses.at(-1).text,/manual/);
  assert.equal(fresh.get({...f.ctx,sessionManager:SessionManager.open(manager.getSessionFile())}).mode,'manual');
});

test('cancelled scope, session change during selection and ephemeral persistence all block the current operation', async () => {
  const cancelled = await fixture(); cancelled.choices.push('Switch to auto',undefined);
  assert.equal((await cancelled.call()).block,true); assert.equal(cancelled.reviews(),0);
  await cancelled.command(''); assert.match(cancelled.notices.at(-1).message,/manual/);
  const moved = await fixture(); moved.choices.push('Switch to auto');
  const select = moved.ctx.ui.select;
  moved.ctx.ui.select = async (...args) => { const result = await select(...args); moved.switchTo(SessionManager.inMemory()); return result; };
  assert.equal((await moved.call()).block,true); assert.equal(moved.prompts.length,1);
  const ephemeral = await fixture(); ephemeral.choices.push('Switch to auto','Persist for this session');
  assert.equal((await ephemeral.call()).block,true); assert.equal(ephemeral.reviews(),0);
  await ephemeral.command('manual'); assert.match(ephemeral.notices.at(-1).message,/manual/);
});

test('failed persistence cannot leave an unflushed auto entry active in memory', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(),'pi-permissions-failure-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const manager = SessionManager.create(process.cwd(),root), f = await fixture(manager);
  f.loaded.runtime.appendEntry = (type,data) => { manager.appendCustomEntry(type,data); throw new Error('injected write failure'); };
  f.choices.push('Switch to auto','Persist for this session'); assert.equal((await f.call()).block,true);
  await f.command(''); assert.match(f.notices.at(-1).message,/manual/); assert.equal(f.reviews(),0);
  assert.equal(new PermissionModes(new Map()).get(f.ctx).mode,'manual');
});

test('headless auto requires explicit scope and manual revocation during model review blocks execution', async () => {
  const f = await fixture(); f.ctx.hasUI = false; await f.command('auto');
  assert.equal(f.prompts.length,0); assert.match(f.notices.at(-1).message,/unchanged/);
  await f.command('auto run');
  f.ctx.modelRegistry.streamSimple = () => ({result: async () => {await f.command('manual run');return {stopReason:'stop',content:[{type:'text',text:'APPROVE'}],usage:{input:1,output:1}};}});
  assert.match((await f.call()).reason,/revoked/);
});

test('automatic reviewer retries transient transport errors, then accepts only the exact verdict', async () => {
  const f = await fixture(); await f.command('auto run'); let attempts = 0, prompt;
  f.ctx.modelRegistry.streamSimple = (_model, request, options) => {
    attempts++; prompt = request;
    assert.equal(options.maxRetries, 0); // retryAssistantCall owns the bounded retry loop
    return {result: async () => attempts === 1
      ? ({stopReason:'error',errorMessage:'network error: connection reset',content:[],usage:{input:1,output:0}})
      : ({stopReason:'stop',content:[{type:'text',text:'APPROVE'}],usage:{input:1,output:1}})};
  };
  assert.equal(await f.call(),undefined); assert.equal(attempts,2);
  assert.match(prompt.messages[0].content,/Run the project tests/);
  assert.match(prompt.systemPrompt,/plain git push/);
});

test('reviewer technical failures are not called denials, exhaust bounded retries and redact secrets', async () => {
  const f = await fixture(); await f.command('auto run'); let attempts = 0;
  f.ctx.modelRegistry.streamSimple = () => ({result:async()=>{
    attempts++;return {stopReason:'error',errorMessage:'fetch failed Bearer supersecret sk-abcdefgh123456 api_key=hidden-secret',content:[],usage:{input:1,output:0}};
  }});
  const result=await f.call();assert.equal(attempts,3);assert.match(result.reason,/3 attempt\(s\)/);assert.match(result.reason,/unavailable|No security decision/i);
  assert.doesNotMatch(result.reason,/supersecret|abcdefgh123456|hidden-secret/);

  const nonTransient=await fixture();await nonTransient.command('auto run');let immediate=0;
  nonTransient.ctx.modelRegistry.streamSimple=()=>({result:async()=>{immediate++;return{stopReason:'error',errorMessage:'invalid API key',content:[],usage:{input:1,output:0}};}});
  const denied=await nonTransient.call();assert.equal(immediate,1);assert.match(denied.reason,/No security decision was made/);
});

test('the permission choice and lifetime choice are two ordinary native dialogs, both answerable by the generic proxy', async () => {
  const loaded = await loadExtensions(['extensions/permissions/index.ts'],process.cwd()); assert.deepEqual(loaded.errors,[]);
  const host = nativeUI(undefined,loaded);
  host.runner.getModel = () => ({provider:'test',id:'reviewer'});
  host.ctx = host.runner.createContext();
  host.ctx.modelRegistry.streamSimple = () => ({result: async () => ({stopReason:'stop',content:[{type:'text',text:'APPROVE'}],usage:{input:1,output:1}})});
  const broker = new UIBroker(()=>{}), restore = installUIProxy(host.ctx.ui,broker);
  try {
    const result = loaded.extensions[0].handlers.get('tool_call')[0]({toolName:'bash',input:{command:'npm test',intent:'Run tests'}},host.ctx);
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok(host.mode.extensionSelector);
    broker.respond(broker.uiEpoch,{id:broker.snapshot().pending[0].id,value:'Switch to auto'});
    await new Promise(resolve=>setImmediate(resolve));
    const scope = broker.snapshot().pending[0]; assert.deepEqual(scope.options,['This TUI run only','Persist for this session']);
    broker.respond(broker.uiEpoch,{id:scope.id,value:'This TUI run only'});
    assert.equal(await result,undefined); assert.equal(host.mode.extensionSelector,undefined);
  } finally { await broker.dispose(); restore(); }
});
