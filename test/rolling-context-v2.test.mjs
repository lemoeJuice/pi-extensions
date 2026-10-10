import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, ExtensionRunner } from '@earendil-works/pi-coding-agent';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import rollingContext from '../extensions/rolling-context/index.ts';
import { DEFAULT_CONFIG, STATE_V2, SNAPSHOT_V2, TELEMETRY_V2, CONTENT_V2 } from '../extensions/rolling-context/projection/types.ts';
import { restoreProjectionState, restoreMode, stateDelta } from '../extensions/rolling-context/projection/state.ts';
import { evidenceRegistry } from '../extensions/rolling-context/projection/evidence.ts';
import { ageEvidence, capacity } from '../extensions/rolling-context/projection/aging.ts';
import { materialize, compressionCandidates } from '../extensions/rolling-context/projection/materialize.ts';
import { planCommit } from '../extensions/rolling-context/projection/planner.ts';
import { reduceEvidence, semanticReducer } from '../extensions/rolling-context/projection/reducer.ts';
import { projectionSnapshot } from '../extensions/rolling-context/projection/snapshot.ts';
import { hash, tokens, bytes } from '../extensions/rolling-context/projection/common.ts';
import codec from '../extensions/rolling-context/projection/snapshot-codec.js';
import { readProjection, readTelemetry } from '../extensions/daemon/daemon/history.js';
import graph from '../extensions/daemon/web/context-graph.js';
import view from '../extensions/daemon/web/context-projection.js';

function harness(manager=SessionManager.inMemory('/tmp',{id:'v2'},[]),flags={}){
 const handlers=new Map(),tools=new Map(),commands=new Map(),definitions=new Map();
 const pi={registerFlag:(k,v)=>definitions.set(k,v),getFlag:k=>flags[k]??definitions.get(k)?.default,
  registerTool:t=>tools.set(t.name,t),registerCommand:(k,v)=>commands.set(k,v),on:(k,v)=>handlers.set(k,v),
  appendEntry:(k,v)=>manager.appendCustomEntry(k,v)};
 rollingContext(pi);
 const ctx={cwd:'/tmp',sessionManager:manager,model:{contextWindow:272000},getContextUsage:()=>undefined,ui:{notify(){}},hasUI:false};
 async function request(){const incoming=structuredClone(manager.buildSessionProjection().messages);const partial=await handlers.get('context')({messages:incoming},ctx);
  // Real Pi preserves chronological system messages when identity is unchanged. Our
  // unit harness has no system stripping; ExtensionRunner is covered separately below.
  const final=await handlers.get('context_with_system')({messages:partial.messages},ctx);return final.messages;}
 async function boundary(){const last=[...manager.getBranch()].reverse().find(e=>e.type==='message'&&e.message.role==='assistant');
  const event={outcome:'completed',messageEntryId:last.id,message:last.message,entries:[],context:{contextEntries:manager.buildSessionProjection().entries}};
  const result=await handlers.get('turn_end')(event,ctx);for(const d of result?.entries??[]){assert.equal(d.type,'custom','normal v2 never edits or compacts transcript');manager.appendCustomEntry(d.customType,d.data);}return result;}
 return {manager,handlers,tools,commands,definitions,ctx,request,boundary};
}
function addTurn(manager,n,toolName='read',long=true){
 manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:`call-${n}`,name:toolName,arguments:toolName==='bash'?{command:'npm test | tail -100'}:{path:`src/file-${n}.ts`}}],stopReason:'toolUse',timestamp:n});
 const id=manager.appendMessage({role:'toolResult',toolCallId:`call-${n}`,toolName,content:[{type:'text',text:long?`Result ${n}: inspected src/file-${n}.ts\n${'stable execution output: success\n'.repeat(450)}`:`Result ${n}`}],isError:false,timestamp:n,details:toolName==='edit'?{changes:[{path:`src/file-${n}.ts`,kind:'update'}]}:undefined});
 manager.appendMessage({role:'assistant',content:[{type:'text',text:`Finished ${n}; next source.`}],stopReason:'stop',timestamp:n,usage:{input:100+n,cacheRead:2000+n*50,cacheWrite:30,output:10}});return id;
}
function registry(manager,state){return evidenceRegistry(manager.getBranch(),manager.buildSessionProjection().entries,manager.getSessionId(),state);}
function candidate(position,saving,sourceId,futureRequests=10){return{position,saving,sourceId,current:'EXACT',desired:'CAPSULE',rawTokens:saving+100,projectedTokens:saving+100,semanticRisk:0,futureRequests,compressionTokens:0,recallRisk:0};}

async function fileFixture(t,manager){
 const root=await mkdtemp(path.join(os.tmpdir(),'rc-v2-'));const old=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=root;
 t.after(async()=>{if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;await rm(root,{recursive:true,force:true});});
 const dir=path.join(root,'sessions','project');await mkdir(dir,{recursive:true});const filename=path.join(dir,`session-${manager.getSessionId()}.jsonl`);
 const save=()=>writeFile(filename,[manager.getHeader(),...manager.getBranch()].map(JSON.stringify).join('\n')+'\n');await save();return{filename,save};
}

test('v2 defaults on; exposes only recall and normal commands; honors explicit migrated modes',async()=>{
 const h=harness();assert.equal(h.definitions.get('rolling-context-mode').default,'on');assert.deepEqual([...h.tools.keys()],['context_recall']);
 assert.deepEqual(h.commands.get('rolling-context').getArgumentCompletions('').map(v=>v.value),['status','on','off','observe','inspect']);
 const config=mode=>({type:'custom',customType:'rolling-context.config.v1',data:{mode}});
 assert.equal(restoreMode([config('observe')],'on'),'observe');assert.equal(restoreMode([config('off')],'on'),'off');
 assert.equal(restoreMode([{...config('observe'),data:{mode:'observe',explicit:false,origin:'default'}}],'on'),'on');
 assert.equal(restoreMode([],'on'),'on');
 await h.commands.get('rolling-context').handler('off',h.ctx);assert.equal(restoreMode(h.manager.getBranch(),'on'),'off');
});

test('Pi actual ExtensionRunner context hook compresses and preserves system chronology without touching raw',async()=>{
 const m=SessionManager.inMemory('/tmp',{id:'runner-v2'},[]);m.appendMessage({role:'system',content:'Stable prompt',timestamp:0});m.appendMessage({role:'user',content:'Inspect sources',timestamp:0});
 for(let i=0;i<7;i++)addTurn(m,i);
 m.appendCustomEntry(TELEMETRY_V2,{turn:8});
 const setup=harness(m);await setup.boundary();
 const loaded=await loadExtensions(['extensions/rolling-context/index.ts'],process.cwd());assert.deepEqual(loaded.errors,[]);
 const runner=new ExtensionRunner(loaded.extensions,loaded.runtime,'/tmp',m,{});
 runner.bindCore({appendEntry:(k,v)=>m.appendCustomEntry(k,v),getThinkingLevel:()=> 'off'}, {getModel:()=>({contextWindow:272000}),getScopedModels:()=>[],isIdle:()=>true,isProjectTrusted:()=>true,getSignal:()=>undefined,abort(){},hasPendingMessages:()=>false,shutdown(){},getContextUsage:()=>undefined,compact(){},getSystemPrompt:()=>''});
 const errors=[];runner.onError(e=>errors.push(e));const before=m.getBranch().filter(e=>e.type==='message');
 const incoming=m.buildSessionProjection().messages;const actual=await runner.emitContext(incoming);
 assert.deepEqual(errors,[]);assert.ok(actual.some(msg=>msg.role==='toolResult'&&msg.content[0].text.includes('Historical evidence')));
 assert.deepEqual(m.getBranch().filter(e=>e.type==='message'),before);assert.deepEqual(actual.filter(msg=>msg.role==='system'),incoming.filter(msg=>msg.role==='system'));
 const snapshot=codec.replaySnapshots(m.getBranch());assert.equal(snapshot.outputHash,hash(actual));assert.equal(snapshot.messageCount,actual.length);
 assert.equal(snapshot.totals.rawTokens,before.reduce((n,e)=>n+tokens(e.message),0),'raw system messages are counted once');
});

test('specialized and generic extractive reducers retain facts, unresolved labels, paths and source refs',async()=>{
 const h=harness();const a=addTurn(h.manager,1,'read'),b=addTurn(h.manager,2,'mcp_unknown');
 const state=restoreProjectionState(h.manager.getBranch()),sources=registry(h.manager,state);
 const known=await reduceEvidence(sources.get(a)),unknown=await reduceEvidence(sources.get(b));
 assert.equal(known.reducer,'specialized');assert.equal(unknown.reducer,'generic-extractive');
 for(const capsule of [known,unknown]){assert.match(capsule.text,/What happened:|Facts|Unresolved|Relevant paths/);assert.match(capsule.text,/source=/);assert.ok(capsule.text.length<1500);}
});

test('generic semantic reducer uses Pi runtime for schema-free unknown tools and long assistant messages',async()=>{
 const h=harness();const id=addTurn(h.manager,1,'custom_mcp');
 const entry=h.manager.getBranch().find(e=>e.id===id);entry.message.content=[{type:'text',text:Array.from({length:80},(_,i)=>`Unique observation ${i}: entity_${i} has value ${i*3}.`).join('\n')}];
 const sources=registry(h.manager,restoreProjectionState(h.manager.getBranch()));let calls=0;
 const ctx={model:{id:'reducer'},modelRegistry:{streamSimple(_model,prompt,opts){calls++;assert.equal(prompt.messages.length,1);assert.match(prompt.systemPrompt,/untrusted data/);assert.equal(opts.maxTokens,1200);return {result:async()=>({stopReason:'stop',content:[{type:'text',text:JSON.stringify({whatHappened:'Queried entity state',facts:['80 observations were returned'],unresolved:['Verify values before use'],entities:['entity_1'],semanticRisk:.1,coldSafe:false})}],usage:{input:1000,output:80}})};}}};
 const capsule=await reduceEvidence(sources.get(id),semanticReducer(ctx));assert.equal(capsule.reducer,'generic-semantic');assert.equal(capsule.compressionTokens,1080);assert.equal(capsule.coldSafe,false);assert.equal(calls,1);
 const assistant={...sources.get(id),message:{role:'assistant',content:[{type:'text',text:entry.message.content[0].text}],timestamp:0},sourceId:'assistant-report'};
 assert.equal((await reduceEvidence(assistant,semanticReducer(ctx))).reducer,'generic-semantic');
});

test('unknown reducer failure or images stay exact without blocking unrelated reduction',async()=>{
 const h=harness();const good=addTurn(h.manager,1),bad=addTurn(h.manager,2,'unknown');
 const e=h.manager.getBranch().find(e=>e.id===bad);e.message.content=[{type:'image',data:'image',mimeType:'image/png'}];
 const state=restoreProjectionState(h.manager.getBranch());state.turn=5;const sources=registry(h.manager,state);
 await ageEvidence(sources,state,DEFAULT_CONFIG,10000,async()=>{throw new Error('unavailable');});
 assert.equal(state.sources.get(good).desiredRepresentation,'CAPSULE');assert.equal(materialize([e.message],sources,state,'on').rows[0].representation,'EXACT');
 const s=sources.get(good);assert.equal(await reduceEvidence({...s,message:{...s.message,content:[{type:'text',text:'unique content '+Array.from({length:1000},(_,i)=>`word${i}`).join(' ')}]}},async()=>{throw new Error('no compressor');}),undefined);
 assert.ok(!('checkpointBlockedBy' in state));
});

test('desired and committed differ; EXACT→CAPSULE and CAPSULE→COLD commit independently',async()=>{
 const h=harness(),id=addTurn(h.manager,1);const state=restoreProjectionState(h.manager.getBranch());state.turn=4;
 const sources=registry(h.manager,state);await ageEvidence(sources,state,DEFAULT_CONFIG,10000);
 assert.equal(state.sources.get(id).desiredRepresentation,'CAPSULE');assert.equal(state.sources.get(id).committedRepresentation,'EXACT');
 const m=h.manager.buildSessionProjection().messages,cs=compressionCandidates(m,sources,state,DEFAULT_CONFIG);
 const deferred=planCommit(cs,200000,{...DEFAULT_CONFIG,minBatchSavingTokens:999999});assert.equal(deferred.changes.length,0);
 const r=state.sources.get(id);r.committedRepresentation='CAPSULE';r.generation=1;state.generation=1;state.turn=20;
 await ageEvidence(sources,state,DEFAULT_CONFIG,10000);assert.equal(r.committedRepresentation,'CAPSULE');assert.equal(state.sources.get(id).desiredRepresentation,'COLD');
 assert.equal(state.sources.get(id).committedRepresentation,'CAPSULE');
});

test('planner chooses earliest mutation frontier and pays suffix KV cost once for all changes behind it',()=>{
 const cs=[candidate(20000,2000,'early'),candidate(70000,8000,'middle'),{...candidate(95000,400,'late'),current:'CAPSULE',desired:'COLD'}];
 const p=planCommit(cs,100000,DEFAULT_CONFIG);
 assert.deepEqual(p.changes.map(c=>c.sourceId),['middle','late']);assert.equal(p.earliestMutationPosition,70000);assert.equal(p.estimatedInvalidatedSuffixTokens,30000);assert.equal(p.savingPerRequest,8400);
 const one=planCommit(cs.slice(1,2),100000,DEFAULT_CONFIG);assert.equal(one.estimatedInvalidatedSuffixTokens,p.estimatedInvalidatedSuffixTokens);
});

test('chronological source sequence and tool call/result protocol remain stable',async()=>{
 const h=harness();h.manager.appendMessage({role:'user',content:'Preserve all constraints',timestamp:0});for(let i=0;i<8;i++)addTurn(h.manager,i);
 h.manager.appendCustomEntry(TELEMETRY_V2,{turn:10});await h.boundary();const state=restoreProjectionState(h.manager.getBranch()),sources=registry(h.manager,state);
 const result=materialize(h.manager.buildSessionProjection().messages,sources,state,'on');
 assert.deepEqual(result.rows.map(r=>r.sourceEntryId),h.manager.buildSessionProjection().entries.flatMap(e=>e.messages.map(()=>e.sourceEntry.id)));
 const calls=result.messages.filter(m=>m.role==='assistant').flatMap(m=>m.content.filter(p=>p.type==='toolCall').map(p=>p.id));
 assert.deepEqual(result.messages.filter(m=>m.role==='toolResult').map(m=>m.toolCallId),calls);
});

test('high occupancy increases aging urgency and capacity reserve; there is no 32k target',async()=>{
 const h=harness(),id=addTurn(h.manager,1);const a=restoreProjectionState(h.manager.getBranch());a.turn=1;const sources=registry(h.manager,a),b=structuredClone(a);
 await ageEvidence(sources,a,DEFAULT_CONFIG,80000);await ageEvidence(sources,b,DEFAULT_CONFIG,capacity(DEFAULT_CONFIG)*.96);
 assert.equal(a.sources.has(id),false);assert.equal(b.sources.get(id).desiredRepresentation,'CAPSULE');
 assert.equal(DEFAULT_CONFIG.targetTokens,undefined);assert.equal(capacity(DEFAULT_CONFIG),272000-16384-13600);
 const plan=planCommit([candidate(230000,1000,'urgent',1)],capacity(DEFAULT_CONFIG),DEFAULT_CONFIG);assert.equal(plan.changes.length,1);
});

test('state deltas restore actual generations; desired updates do not advance generation; capsules are not repeated',async()=>{
 const h=harness(),id=addTurn(h.manager,1),before=restoreProjectionState(h.manager.getBranch()),after=structuredClone(before);after.turn=5;
 await ageEvidence(registry(h.manager,after),after,DEFAULT_CONFIG,10000);const desired=stateDelta(before,after);h.manager.appendCustomEntry(desired.customType,desired.data);
 assert.equal(restoreProjectionState(h.manager.getBranch()).generation,0);
 const resident=structuredClone(after);resident.sources.get(id).committedRepresentation='CAPSULE';resident.sources.get(id).generation=1;resident.generation=1;
 const committed=stateDelta(after,resident);assert.equal(committed.data.changes[0].capsule,undefined);h.manager.appendCustomEntry(committed.customType,committed.data);
 assert.equal(restoreProjectionState(h.manager.getBranch()).generation,1);assert.ok(restoreProjectionState(h.manager.getBranch()).sources.get(id).capsule);
 const branchPoint=h.manager.getLeafId();h.manager.appendCustomEntry(STATE_V2,{schemaVersion:2,parentGeneration:1,generation:20,changes:[]});
 assert.equal(restoreProjectionState(h.manager.getBranch()).generation,1);h.manager.branch(branchPoint);assert.equal(restoreProjectionState(h.manager.getBranch()).generation,1);
});

test('snapshots archive actual hook output and Mapping/Rendered replay never run planner',async t=>{
 const h=harness();h.manager.appendMessage({role:'user',content:'Inspect',timestamp:0});for(let i=0;i<6;i++)addTurn(h.manager,i);
 h.manager.appendCustomEntry(TELEMETRY_V2,{turn:8});await h.boundary();const actual=await h.request();
 const {filename}=await fileFixture(t,h.manager),result=await readProjection(filename,h.manager.getSessionId());
 assert.equal(result.verified,true);assert.deepEqual(result.rows.map(r=>r.message),JSON.parse(JSON.stringify(actual)));assert.equal(result.snapshot.outputHash,hash(actual));
 assert.ok(result.rows.some(r=>r.representation==='CAPSULE'));
 const target={innerHTML:''};view.render(target,result);assert.match(target.innerHTML,/Projection · Turn|CAPSULE|Recall raw/);
 const daemon=await readFile(new URL('../extensions/daemon/daemon/history.js',import.meta.url),'utf8');assert.doesNotMatch(daemon,/planCommit|ageEvidence|reduceEvidence/);
});

test('changing leading prompts reuse mapping segments; content-addressed fragments are archived once',()=>{
 const h=harness();for(let i=0;i<12;i++)addTurn(h.manager,i,false);
 const state=restoreProjectionState(h.manager.getBranch()),sources=registry(h.manager,state),m=h.manager.buildSessionProjection().messages;
 const append=snapshot=>snapshot.drafts.forEach(d=>h.manager.appendCustomEntry(d.customType,d.data));
 const first=projectionSnapshot([{role:'system',content:'prompt A',timestamp:0},...m],[],sources,state,h.manager.getBranch(),272000,'on');append(first);
 const second=projectionSnapshot([{role:'system',content:'prompt B',timestamp:0},...m],[],sources,state,h.manager.getBranch(),272000,'on');append(second);
 const data=second.drafts.at(-1).data;assert.ok(data.segments.some(s=>s.count>=m.length));assert.ok(bytes(data)<3000);
 const replay=codec.replaySnapshots(h.manager.getBranch());assert.equal(replay.rows.length,m.length+1);
 const third=projectionSnapshot([{role:'system',content:'prompt B',timestamp:0},...m],[],sources,state,h.manager.getBranch(),272000,'on');assert.equal(third.drafts.filter(d=>d.customType===CONTENT_V2).length,0);
});

test('legacy v1 notes, context edits and own checkpoints remain restorable and recallable',async()=>{
 const h=harness();const user=h.manager.appendMessage({role:'user',content:'Keep API',timestamp:0}),result=addTurn(h.manager,1),kept=h.manager.getBranch().find(e=>e.type==='message'&&e.message.role==='assistant').id;
 const original=h.manager.getBranch().find(e=>e.id===result).message.content[0].text,capsule='Legacy capsule';
 const snapshot={schemaVersion:1,revision:1,coveredThroughEntryId:result,items:[],intentRefs:[],focus:{taskId:`RC-T-${user}`,nextSteps:[],openQuestions:[]},coverage:[]};
 const state={schemaVersion:1,revision:1,planId:'legacy',baseLeafId:kept,snapshot,edits:[{targetId:result,originalHash:hash(original),replacementHash:hash(capsule)}]};
 h.manager.appendCustomEntry('rolling-context.state.v1',state);h.manager.appendContextEdit(result,{content:[{type:'text',text:capsule}]});
 const summary='Legacy checkpoint',cp={...state,checkpoint:{firstKeptEntryId:kept,summaryHash:hash(summary)}};
 h.manager.appendCompaction(summary,kept,100,{type:'rolling-context.checkpoint.v1',stateEnvelope:cp,firstKeptEntryId:kept,summaryHash:hash(summary)},true);
 const recall=await h.tools.get('context_recall').execute('recall',{entryId:result,intent:'Recall old evidence'},undefined,undefined,h.ctx);assert.match(recall.content[0].text,/Result 1/);
 const actual=await h.request();assert.ok(actual.length);assert.equal(restoreProjectionState(h.manager.getBranch()).generation,0);
});

test('cold recall is independent of residency; foreign edits and native compaction remain authoritative',async t=>{
 const h=harness(),id=addTurn(h.manager,1);const state=restoreProjectionState(h.manager.getBranch());state.turn=20;await ageEvidence(registry(h.manager,state),state,DEFAULT_CONFIG,10000);
 const r=state.sources.get(id);r.committedRepresentation='COLD';r.generation=1;state.generation=1;const delta=stateDelta(restoreProjectionState(h.manager.getBranch()),state);h.manager.appendCustomEntry(delta.customType,delta.data);
 const actual=await h.request();assert.match(actual.find(m=>m.role==='toolResult').content[0].text,/Cold evidence/);
 const recall=()=>h.tools.get('context_recall').execute('q',{entryId:id,intent:'Recall raw'},undefined,undefined,h.ctx);
 assert.match((await recall()).content[0].text,/Result 1/);
 const {filename,save}=await fileFixture(t,h.manager);assert.match((await readProjection(filename,h.manager.getSessionId(),undefined,{sourceId:id})).messages[0].content[0].text,/Result 1/);
 h.manager.appendContextEdit(id,{content:[{type:'text',text:'[redacted]'}]});assert.match((await recall()).content[0].text,/redacted/);assert.doesNotMatch((await recall()).content[0].text,/Result 1/);
 await save();const historical=await readProjection(filename,h.manager.getSessionId());assert.ok(historical.rows.find(r=>r.sourceEntryId===id).unavailable);assert.equal(historical.rows.find(r=>r.sourceEntryId===id).preview,'');
 h.manager.appendContextEdit(id,null);assert.equal((await recall()).details.denied,true);
 await save();await assert.rejects(readProjection(filename,h.manager.getSessionId(),undefined,{sourceId:id}),e=>e.status===403);
 const kept=h.manager.getBranch().find(e=>e.type==='message'&&e.message.role==='assistant'&&e.message.stopReason==='stop').id;
 h.manager.appendCompaction('Foreign summary',kept,100,{},false);assert.equal((await recall()).details.denied,true);
 const foreign=await h.tools.get('context_recall').execute('q',{entryId:'foreign-session-source',intent:'Recall'},undefined,undefined,h.ctx);assert.equal(foreign.details.returned,0);
});

test('120-turn zero-cooperation run keeps raw evidence, ages independently, emits generations and observable next-request cache usage',async t=>{
 let h=harness();const m=h.manager;m.appendMessage({role:'user',content:'Inspect and implement without changing public interfaces.',timestamp:0});
 await h.handlers.get('session_start')({},h.ctx);const raw=new Map(),requests=[];
 for(let turn=1;turn<=120;turn++){
  const actual=await h.request();requests.push({hash:hash(actual),snapshot:codec.replaySnapshots(m.getBranch()).requestId});
  const id=addTurn(m,turn,['read','edit','bash','test','unknown_mcp'][turn%5]);raw.set(id,hash(m.getBranch().find(e=>e.id===id).message));
  const result=await h.boundary();assert.ok(result.entries.every(d=>d.type==='custom'));assert.ok(!JSON.stringify(result).includes('checkpointBlocked'));
  if(turn%30===0)h=harness(m); // restart/rebuild from persisted branch
 }
 const state=restoreProjectionState(m.getBranch()),telemetry=m.getBranch().filter(e=>e.type==='custom'&&e.customType===TELEMETRY_V2).map(e=>e.data),latest=telemetry.at(-1);
 assert.equal(state.turn,120);assert.ok(state.generation>5);assert.ok(telemetry.filter(r=>r.capsulesCreated>0).length>5);assert.ok(telemetry.filter(r=>r.sourcesCold>0).length>2);
 assert.ok(latest.effectiveTokens<latest.rawTokens*.3,JSON.stringify(latest));assert.ok([...state.sources.values()].some(r=>r.committedRepresentation==='COLD'));
 assert.ok(!m.getBranch().some(e=>e.type==='context_edit'||e.type==='compaction'));assert.ok(!m.getBranch().some(e=>e.type==='message'&&e.message.toolName==='context_note'));
 for(const [id,originalHash] of raw)assert.equal(hash(m.getBranch().find(e=>e.id===id).message),originalHash);
 const commit=telemetry.find(r=>r.generationCommitted&&r.turn<120),next=telemetry.find(r=>r.turn===commit.turn+1);assert.equal(next.requestGeneration,commit.generation);assert.ok(next.cacheRead>0&&next.uncachedInput>0);
 const cold=[...state.sources.values()].find(r=>r.committedRepresentation==='COLD');const recalled=await h.tools.get('context_recall').execute('q',{entryId:cold.sourceId,intent:'Inspect historical source'},undefined,undefined,h.ctx);assert.match(recalled.content[0].text,/stable execution output/);
 const rawChars=m.getBranch().filter(e=>e.type==='message').reduce((n,e)=>n+bytes(e.message),0);
 const metadata=m.getBranch().filter(e=>e.type==='custom'&&e.customType!==TELEMETRY_V2);const metadataBytes=metadata.reduce((n,e)=>n+bytes(e.data),0);
 assert.ok(metadataBytes<rawChars*.6,JSON.stringify({metadataBytes,rawChars,types:Object.fromEntries([STATE_V2,SNAPSHOT_V2,CONTENT_V2].map(type=>[type,metadata.filter(e=>e.customType===type).reduce((n,e)=>n+bytes(e.data),0)]))}));
 const snapshots=metadata.filter(e=>e.customType===SNAPSHOT_V2);assert.ok(bytes(snapshots.at(-1).data)<10000);assert.ok(metadata.filter(e=>e.customType===STATE_V2).every(e=>!JSON.stringify(e).includes('stable execution output: success\\nstable execution output')));
 const {filename}=await fileFixture(t,m);const archived=await readProjection(filename,m.getSessionId(),undefined,{requestId:requests[83].snapshot});assert.equal(archived.verified,true);assert.equal(hash(archived.rows.map(r=>r.message)),requests[83].hash);
 const measured=await readTelemetry(filename,m.getSessionId());const nodes=new Map();graph.render({querySelector(id){if(!nodes.has(id))nodes.set(id,{innerHTML:''});return nodes.get(id);}},measured);
 assert.match(nodes.get('#overview').innerHTML,/Projected \/ window|Generation|Cold equivalent/);assert.doesNotMatch(nodes.get('#overview').innerHTML,/32k|target|Blocked/);
 assert.match(nodes.get('#event-log').innerHTML,/GENERATION COMMIT|RESIDENT → COLD|NEXT REQUEST CACHE IMPACT/);
});

test('v2 Turn 0 is measured; observe/off return exact messages and never commit reduction',async()=>{
 for(const mode of ['observe','off']){
  const h=harness(undefined,{'rolling-context-mode':mode});h.manager.appendMessage({role:'user',content:'Keep this goal',timestamp:0});
  await h.handlers.get('session_start')({},h.ctx);const initial=h.manager.getBranch().find(e=>e.type==='custom'&&e.customType===TELEMETRY_V2).data;
  assert.equal(initial.turn,0);assert.equal(initial.timelineKind,'initial');assert.equal(initial.mode,mode);assert.equal(initial.cacheRead,null);
  for(let i=0;i<6;i++)addTurn(h.manager,i);h.manager.appendCustomEntry(TELEMETRY_V2,{turn:8});await h.boundary();
  const actual=await h.request();assert.deepEqual(actual, h.manager.buildSessionProjection().messages);
  assert.equal(restoreProjectionState(h.manager.getBranch()).generation,0);assert.ok(!h.manager.getBranch().some(e=>e.type==='custom'&&e.customType===STATE_V2));
 }
});

test('high semantic loss risk keeps only that unknown source exact while other sources compress',async()=>{
 const h=harness();const good=addTurn(h.manager,1),bad=addTurn(h.manager,2,'novel_tool');
 h.manager.getBranch().find(e=>e.id===bad).message.content=[{type:'text',text:Array.from({length:400},(_,i)=>`unique fact${i}: ${i*i}`).join('\n')}];
 const state=restoreProjectionState(h.manager.getBranch());state.turn=8;
 await ageEvidence(registry(h.manager,state),state,DEFAULT_CONFIG,10000,async()=>({text:'unsafe summary',semanticRisk:.9,compressionTokens:0,coldSafe:true,reducer:'generic-semantic'}));
 assert.equal(state.sources.get(good).desiredRepresentation,'CAPSULE');assert.equal(state.sources.get(bad).committedRepresentation,'EXACT');assert.equal(state.sources.get(bad).capsule,undefined);
});

test('native threshold delegates only real capacity pressure; manual/overflow remain native',async()=>{
 const h=harness();h.manager.appendMessage({role:'user',content:'small useful context',timestamp:0});const handler=h.handlers.get('session_before_compact');
 assert.deepEqual(await handler({reason:'threshold'},h.ctx),{cancel:true});
 assert.equal(await handler({reason:'manual'},h.ctx),undefined);assert.equal(await handler({reason:'overflow'},h.ctx),undefined);
 h.manager.appendMessage({role:'user',content:'uncompressible instructions '.repeat(500),timestamp:0});h.ctx.model.contextWindow=4000;
 assert.equal(await handler({reason:'threshold'},h.ctx),undefined);
 h.manager.appendMessage({role:'assistant',content:[{type:'text',text:'Done'}],timestamp:0,stopReason:'stop'});await h.boundary();
 const data=h.manager.getBranch().at(-1).data;assert.equal(data.capacityStatus,'BUDGET_INFEASIBLE');assert.ok(!('checkpointBlockedBy' in data));
});

test('context capacity preflight commits representation without editing raw, and unauthorized edits invalidate old capsules',async()=>{
 const h=harness();for(let i=0;i<6;i++)addTurn(h.manager,i);h.manager.appendCustomEntry(TELEMETRY_V2,{turn:8});h.ctx.model.contextWindow=10000;
 const before=hash(h.manager.getBranch().filter(e=>e.type==='message'));const actual=await h.request();assert.ok(restoreProjectionState(h.manager.getBranch()).generation>0);assert.equal(hash(h.manager.getBranch().filter(e=>e.type==='message')),before);
 assert.ok(actual.some(m=>m.role==='toolResult'&&/Historical evidence|Cold evidence/.test(m.content[0].text)));
 const state=restoreProjectionState(h.manager.getBranch()),id=[...state.sources.keys()][0];h.manager.appendContextEdit(id,{content:[{type:'text',text:'redacted by foreign policy'}]});
 const after=await h.request();assert.ok(after.some(m=>m.role==='toolResult'&&m.content[0].text==='redacted by foreign policy'));
});

test('v2 recall usage keeps immediate pagination valid and updates last use independently of residency',async()=>{
 const h=harness();for(let i=0;i<5;i++)addTurn(h.manager,i);h.manager.appendCustomEntry(TELEMETRY_V2,{turn:8});await h.boundary();
 const tool=h.tools.get('context_recall');const first=await tool.execute('q1',{intent:'Inspect history',limit:2},undefined,undefined,h.ctx);assert.ok(first.details.nextCursor);
 const second=await tool.execute('q2',{intent:'Inspect history',limit:2,cursor:first.details.nextCursor},undefined,undefined,h.ctx);assert.equal(second.details.returned,2);
 const id=[...restoreProjectionState(h.manager.getBranch()).sources.keys()][0];await tool.execute('q3',{intent:'Inspect source',entryId:id},undefined,undefined,h.ctx);
 assert.equal(restoreProjectionState(h.manager.getBranch()).sources.get(id).lastUseTurn,9);
});

test('daemon HTTP serves actual projection, mapping script and authorized raw recall',async t=>{
 const net=await import('node:net'),{spawn}=await import('node:child_process'),{once}=await import('node:events');
 const h=harness(SessionManager.inMemory('/tmp',{id:'v2-http'},[]));h.manager.appendMessage({role:'user',content:'Inspect',timestamp:0});for(let i=0;i<6;i++)addTurn(h.manager,i);
 h.manager.appendCustomEntry(TELEMETRY_V2,{turn:8});await h.boundary();const actual=await h.request();const {filename}=await fileFixture(t,h.manager);
 const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 const child=spawn(process.execPath,['extensions/daemon/daemon/main.js'],{env:{...process.env,PI_REMOTE_HOST:'127.0.0.1',PI_REMOTE_PORT:String(port)},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('daemon startup timeout')),5000);child.stdout.on('data',d=>{if(String(d).includes('listening')){clearTimeout(timer);resolve();}});child.on('exit',code=>{clearTimeout(timer);reject(new Error(`daemon exited ${code}`));});});
 const base=`http://127.0.0.1:${port}`,response=await fetch(base+'/api/sessions/v2-http/context-projection');assert.equal(response.status,200);const result=await response.json();assert.equal(hash(result.rows.map(r=>r.message)),hash(actual));assert.equal(result.verified,true);
 assert.equal((await fetch(base+'/context-projection.js')).status,200);assert.match(await (await fetch(base+'/s/v2-http/context')).text(),/Graph|Projection|Rendered|Mapping \/ Diff/);
 assert.equal((await fetch(base+'/api/sessions/v2-http/context-projection?sourceId=foreign')).status,403);
 assert.equal((await readProjection(filename,'v2-http')).verified,true);
});

test('Graph marks significant measured cache rebuild after generation while quiet reuse stays unmarked',()=>{
 const rows=[{schemaVersion:2,turn:0,timelineKind:'initial',generation:0,contextWindow:272000},
 {schemaVersion:2,turn:1,generation:1,generationCommitted:true,representationChanges:2,capsulesCreated:2,cacheRead:9900,uncachedInput:100,cacheReuseRatio:.99,effectiveTokens:10000},
 {schemaVersion:2,turn:2,generation:1,requestGeneration:1,cacheRead:1000,uncachedInput:8000,cacheReuseRatio:1/9,effectiveTokens:9000}];
 const nodes=new Map(),doc={querySelector(id){if(!nodes.has(id))nodes.set(id,{innerHTML:''});return nodes.get(id);}};graph.render(doc,{turns:rows,checkpoints:[]});
 assert.match(nodes.get('#event-log').innerHTML,/NEXT REQUEST CACHE IMPACT|uncached 8,000/);
 rows[2]={...rows[2],cacheRead:9900,uncachedInput:100,cacheReuseRatio:.99};graph.render(doc,{turns:rows,checkpoints:[]});assert.doesNotMatch(nodes.get('#event-log').innerHTML,/NEXT REQUEST CACHE IMPACT/);
});

test('cold raw remains available beyond the first excerpt; full authorized text is searchable and offset-pageable',async()=>{
 const h=harness(),id=addTurn(h.manager,1,'unknown_tool');
 const source=h.manager.getBranch().find(e=>e.id===id);source.message.content=[{type:'text',text:'prefix '.repeat(1000)+'unique-tail-fact: 42'}];
 const tool=h.tools.get('context_recall'),call=params=>tool.execute('q',{intent:'Inspect long historical evidence',...params},undefined,undefined,h.ctx);
 const first=await call({entryId:id});assert.equal(first.details.truncated,true);assert.ok(first.details.nextOffset>0);
 const searched=await call({query:'unique-tail-fact'});assert.match(searched.content[0].text,/unique-tail-fact: 42/);
 let offset=0,body='';for(let page=0;page<20;page++){const result=await call({entryId:id,offset});body+=result.content[0].text;if(result.details.nextOffset===undefined)break;offset=result.details.nextOffset;}
 assert.match(body,/unique-tail-fact: 42/);
 h.manager.appendContextEdit(id,{content:[{type:'text',text:'redacted'}]});assert.equal((await call({query:'unique-tail-fact'})).details.returned,0);
 const foreign=await call({entryId:'foreign-source',offset:6000});assert.equal(foreign.details.denied,true);
});

test('ordinary source/path references refresh relevance without primary-agent maintenance',async()=>{
 const h=harness(),id=addTurn(h.manager,1),state=restoreProjectionState(h.manager.getBranch());state.turn=18;
 await ageEvidence(registry(h.manager,state),state,DEFAULT_CONFIG,10000);assert.equal(state.sources.get(id).desiredRepresentation,'COLD');
 h.manager.appendCustomEntry(TELEMETRY_V2,{turn:18});h.manager.appendMessage({role:'assistant',content:[{type:'text',text:'I am using src/file-1.ts for the current implementation.'}],stopReason:'stop',timestamp:18});state.turn=19;
 await ageEvidence(registry(h.manager,state),state,DEFAULT_CONFIG,10000);assert.equal(state.sources.get(id).lastUseTurn,18);assert.equal(state.sources.get(id).desiredRepresentation,'CAPSULE');
});
