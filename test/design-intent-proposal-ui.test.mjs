import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { emptyStore, serializeStore, rebuildProposals, sha } from '../extensions/design-intent/lib.ts';
import { nativeUI } from './helpers/native-ui.mjs';
import { UIBroker } from '../extensions/daemon/ui/broker.ts';
import { installUIProxy } from '../extensions/daemon/ui/adapter.ts';

const draft = {intent:'Preserve the public API',kind:'invariant',title:'Stable API',statement:'Keep the public API compatible',rationale:'Existing consumers depend on it.'};
async function fixture(t, choices = []) {
  const cwd = await mkdtemp(path.join(os.tmpdir(),'pi-proposal-ui-')); t.after(()=>rm(cwd,{recursive:true,force:true}));
  const manager = SessionManager.inMemory(cwd);
  const loaded = await loadExtensions(['extensions/design-intent/index.ts'],process.cwd()); assert.deepEqual(loaded.errors,[]);
  loaded.runtime.appendEntry = (type,data) => manager.appendCustomEntry(type,data);
  const tool = loaded.extensions[0].tools.get('design_intent_propose').definition;
  const prompts=[],notices=[];let aborted=0;
  const controller = new AbortController();
  const ctx = {cwd,sessionManager:manager,hasUI:true,isProjectTrusted:()=>true,hasPendingMessages:()=>false,get signal(){return controller.signal;},abort:()=>{aborted++;controller.abort();},
    ui:{select:async(title,options)=>{prompts.push({method:'select',title,options});return choices.shift();},confirm:async(title,message)=>{prompts.push({method:'confirm',title,message});return choices.shift();},input:()=>{throw new Error('Reject must not request an input dialog');},notify:(message,type)=>notices.push({message,type})},
  };
  return {cwd,manager,loaded,tool,ctx,prompts,notices,aborted:()=>aborted,call:(id='p1',params=draft)=>tool.execute(id,params,controller.signal,undefined,ctx)};
}
const storePath = f => path.join(f.cwd,'.pi/design-intent.json');
async function assertNoStore(f) { await assert.rejects(access(storePath(f)),/ENOENT/); }
async function waitPrompt(broker, method) {
  const end=Date.now()+5000;
  while(Date.now()<end){await new Promise(resolve=>setImmediate(resolve));const request=broker.snapshot().pending[0];if(request?.method===method)return request;}
  assert.fail(`Native ${method} prompt did not start`);
}

test('Later, dismissal, headless and Reject never create the project store; Reject aborts and asks naturally for a reason',async t=>{
  for(const choice of ['Later',undefined,'Reject']){
    const f=await fixture(t,[choice]);const result=await f.call();await assertNoStore(f);assert.equal(Check(f.tool.outputSchema,result.structuredContent),true);
    assert.deepEqual(f.prompts[0].options,['Accept','Reject','Later']);assert.match(f.prompts[0].title,/Accept opens the full candidate diff/);assert.doesNotMatch(f.prompts[0].title,/Keep the public API compatible|Existing consumers/);
    assert.equal(f.manager.getBranch().find(entry=>entry.customType==='design-intent.proposal.v1').data.proposalHash,result.details.proposalHash);
    assert.equal(rebuildProposals(f.manager.getBranch()).get(result.details.proposalId).proposalHash,result.details.proposalHash);
    assert.equal(f.prompts.length,1);
    if(choice==='Reject'){assert.equal(result.terminate,true);assert.equal(f.aborted(),1);assert.equal(result.details.review.status,'rejected_pending_reason');assert.match(result.content[0].text,/下一条普通消息.*reject 理由/);}
    else {assert.equal(result.terminate,undefined);assert.equal(f.aborted(),0);}
  }
  const headless=await fixture(t);headless.ctx.hasUI=false;const saved=await headless.call();assert.equal(saved.details.review.status,'pending');assert.equal(headless.prompts.length,0);await assertNoStore(headless);
  const stopped=await fixture(t);stopped.ctx.ui.select=async()=>{stopped.manager.appendCustomEntry('task-update',{});return 'Reject';};assert.equal((await stopped.call()).details.review.status,'rejected_pending_reason');assert.equal(stopped.aborted(),1);await assertNoStore(stopped);
  const switched=await fixture(t);switched.ctx.ui.select=async()=>{switched.ctx.sessionManager=SessionManager.inMemory(switched.cwd);return 'Reject';};assert.equal((await switched.call()).details.review.status,'cancelled');assert.equal(switched.aborted(),0);await assertNoStore(switched);
  const cancelled=await fixture(t);cancelled.ctx.ui.select=async()=>{cancelled.ctx.abort();return 'Accept';};assert.equal((await cancelled.call()).details.review.status,'cancelled');await assertNoStore(cancelled);
});

test('Accept requires exact-diff confirmation, creates revision one and does not wait for the running agent to become idle',async t=>{
  const cancelled=await fixture(t,['Accept',false]);assert.equal((await cancelled.call()).details.review.status,'cancelled');await assertNoStore(cancelled);
  const f=await fixture(t,['Accept',true]);f.ctx.waitForIdle=()=>{throw new Error('Inline review cannot wait for itself');};
  const result=await f.call();assert.equal(result.details.review.status,'committed');assert.equal(result.details.review.action,'accept');
  assert.equal(Check(f.tool.outputSchema,result.structuredContent),true);
  const store=JSON.parse(await readFile(storePath(f),'utf8'));assert.equal(store.revision,1);assert.equal(store.records[0].status,'accepted');assert.equal(store.records[0].review.note,'Approved by user through proposal UI');
  assert.match(f.prompts[1].message,/candidate=/);assert.match(f.prompts[1].message,/exclusive lock/);assert.equal(f.aborted(),0);
});

test('branch changes, stale file sources and trust revocation prevent inline commit',async t=>{
  for(const change of ['branch','source','trust']){
    const f=await fixture(t,['Accept']);
    f.ctx.ui.confirm=async()=>{
      if(change==='branch')f.manager.appendCustomEntry('other',{message:'branch changed'});
      if(change==='trust')f.ctx.isProjectTrusted=()=>false;
      if(change==='source'){await mkdir(path.dirname(storePath(f)));await writeFile(storePath(f),serializeStore(emptyStore()));}
      return true;
    };
    const result=await f.call();assert.equal(result.details.review.status,'failed');assert.equal(result.isError,true);
    if(change==='source')assert.equal(JSON.parse(await readFile(storePath(f),'utf8')).records.length,0);
    else await assertNoStore(f);
  }
  const changed=await fixture(t);changed.ctx.ui.select=async()=>{
    const saved=changed.manager.getBranch().find(entry=>entry.customType==='design-intent.proposal.v1').data;
    saved.draft.statement='A different statement after the prompt was displayed';const {proposalHash,...body}=saved;saved.proposalHash=sha(JSON.stringify(body));return 'Accept';
  };
  const result=await changed.call();assert.equal(result.details.review.status,'failed');assert.equal(result.details.draft.statement,draft.statement);await assertNoStore(changed);
});

test('committed project state remains committed if the session receipt cannot be saved',async t=>{
  const f=await fixture(t,['Accept',true]);const append=f.loaded.runtime.appendEntry;
  f.loaded.runtime.appendEntry=(type,data)=>{if(type==='design-intent.review.v1')throw new Error('receipt write failed');append(type,data);};
  const result=await f.call();assert.equal(result.details.review.status,'committed');assert.match(result.details.review.receiptWarning,/Project file was committed/);
  assert.equal(JSON.parse(await readFile(storePath(f),'utf8')).records.length,1);
});

test('a session-only Reject may later be explicitly recorded with a reason through the shared command path',async t=>{
  const f=await fixture(t,['Reject',true]);const proposal=await f.call();await assertNoStore(f);
  const ctx={...f.ctx,signal:new AbortController().signal,waitForIdle:async()=>{}};
  await f.loaded.extensions[0].commands.get('design-intent').handler(`reject ${proposal.details.proposalId} Conflicts with the existing API`,ctx);
  const store=JSON.parse(await readFile(storePath(f),'utf8'));assert.equal(store.records[0].status,'rejected');assert.equal(store.records[0].review.note,'Conflicts with the existing API');
  assert.equal(store.revision,1);assert.equal(f.prompts.length,2);assert.equal(f.prompts[1].method,'confirm');
});

test('the commit-point callback rechecks trust after the temp file is written but before publishing',async t=>{
  const f=await fixture(t,['Accept',true]);let checks=0;
  f.ctx.isProjectTrusted=()=>++checks<5;
  const result=await f.call();assert.equal(checks,5);assert.equal(result.details.review.status,'failed');await assertNoStore(f);
});

test('proposal choice and exact confirmation are the same native TUI dialogs mirrored through the generic broker',async t=>{
  const f=await fixture(t),native=nativeUI();native.restore();const broker=new UIBroker(()=>{}),restore=installUIProxy(native.ctx.ui,broker);f.ctx.ui=native.ctx.ui;
  try{
    const result=f.call();const request=await waitPrompt(broker,'select');assert.ok(native.mode.extensionSelector);
    broker.respond(broker.uiEpoch,{id:request.id,value:'Accept'});
    const confirmation=await waitPrompt(broker,'confirm');assert.match(confirmation.message,/candidate=/);
    broker.respond(broker.uiEpoch,{id:confirmation.id,confirmed:true});assert.equal((await result).details.review.status,'committed');assert.equal(native.mode.extensionSelector,undefined);
  }finally{await broker.dispose();restore();}
});

test('web Reject clears the local selector, returns the real choice and stops without another dialog',async t=>{
  const f=await fixture(t),native=nativeUI();native.restore();const broker=new UIBroker(()=>{}),restore=installUIProxy(native.ctx.ui,broker);f.ctx.ui=native.ctx.ui;
  try{
    const execution=f.call();const request=await waitPrompt(broker,'select');
    assert.equal(broker.respond(broker.uiEpoch,{id:request.id,value:'Reject'}),true);
    const result=await execution;assert.equal(result.details.review.status,'rejected_pending_reason');assert.equal(f.aborted(),1);assert.equal(result.terminate,true);
    assert.equal(native.mode.extensionSelector,undefined);assert.equal(broker.snapshot().pending.length,0);await assertNoStore(f);
  }finally{await broker.dispose();restore();}
});

test('real Agent preserves Reject output in the session, skips sibling tools and makes no follow-up model request',async t=>{
  const f=await fixture(t,['Reject']);let requests=0,preceding=0,following=0;
  f.manager=SessionManager.create(f.cwd,path.join(f.cwd,'sessions'));f.ctx.sessionManager=f.manager;
  f.loaded.runtime.appendEntry=(type,data)=>f.manager.appendCustomEntry(type,data);
  const model={id:'test',name:'test',provider:'test',api:'test',baseUrl:'',reasoning:false,input:['text'],contextWindow:10000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const tools=[{name:'before',description:'preceding operation',parameters:Type.Object({}),execute:async()=>{preceding++;return{content:[{type:'text',text:'done'}],details:{}};}},
    {...f.tool,execute:(id,args,signal,update)=>f.tool.execute(id,args,signal,update,f.ctx)},
    {name:'after',description:'must never run',parameters:Type.Object({}),execute:async()=>{following++;return{content:[{type:'text',text:'bad'}],details:{}};}}];
  const agent=new Agent({initialState:{model,systemPrompt:'Test',tools},streamFn:(_model,_context,options)=>{
    if(options.signal?.aborted){const stream=createAssistantMessageEventStream();const message={role:'assistant',api:'test',provider:'test',model:'test',timestamp:Date.now(),stopReason:'aborted',content:[],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};queueMicrotask(()=>stream.push({type:'error',reason:'aborted',error:message}));return stream;}
    requests++;if(requests>1)throw new Error(`Unexpected follow-up: ${JSON.stringify(agent.state.messages)}`);const stream=createAssistantMessageEventStream();const message={role:'assistant',api:'test',provider:'test',model:'test',timestamp:Date.now(),stopReason:'toolUse',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},content:[{type:'toolCall',id:'before-1',name:'before',arguments:{}},{type:'toolCall',id:'proposal-1',name:'design_intent_propose',arguments:draft},{type:'toolCall',id:'after-1',name:'after',arguments:{}}]};
    queueMicrotask(()=>{stream.push({type:'done',reason:'toolUse',message});});return stream;
  }});
  f.ctx.abort=()=>agent.abort();
  const select=f.ctx.ui.select;f.ctx.ui.select=(...args)=>{agent.followUp({role:'user',content:[{type:'text',text:'Queued follow-up must not cause a new model request after Reject'}],timestamp:Date.now()});return select(...args);};
  agent.subscribe(event=>{if(event.type==='message_end')f.manager.appendMessage(event.message);});
  await agent.prompt('Propose this invariant');
  assert.equal(preceding,1);assert.equal(following,0);assert.equal(requests,1);
  const output=f.manager.getEntries().find(entry=>entry.type==='message'&&entry.message.role==='toolResult'&&entry.message.toolName==='design_intent_propose').message;
  assert.equal(output.details.review.status,'rejected_pending_reason');assert.match(output.content[0].text,/下一条普通消息/);await assertNoStore(f);
  const restored=SessionManager.open(f.manager.getSessionFile());
  assert.ok(restored.getEntries().some(entry=>entry.type==='message'&&entry.message.details?.review?.status==='rejected_pending_reason'));
  assert.ok(rebuildProposals(restored.getBranch()).has(output.details.proposalId));
});
