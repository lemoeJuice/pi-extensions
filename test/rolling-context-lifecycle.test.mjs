import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { planTurn, rebuild, estimateProjection, ownedEdits, turnClock, TELEMETRY_TYPE, recallProjection, hash, contextComposition, serializedStateBytes, explicitUserConstraints } from '../extensions/rolling-context/lib.ts';
const cwd='/tmp/rolling-lifecycle';
const header={type:'session',version:3,id:'lifecycle',timestamp:new Date(0).toISOString(),cwd};
const config={mode:'on',targetTokens:8000,reserveTokens:0,minSavingTokens:1,minCheckpointTurns:8,minWarmTurns:4,minBatchSavingTokens:1000,recallMaxTokens:2000};
function manager(){const m=SessionManager.inMemory(cwd,{id:header.id},[header]);m.appendMessage({role:'user',content:'Inspect the module; preserve its public API.',timestamp:0});m.appendMessage({role:'toolResult',toolCallId:'note',toolName:'context_note',content:[{type:'text',text:'Recorded'}],details:{type:'rolling-context.note.v1',noteId:'note',taskId:`RC-T-${m.getBranch()[0].id}`,kind:'focus',text:'Inspect sources and verify changes before reporting.',paths:[]},isError:false,timestamp:0});return m;}
function read(m,i,length=4000){m.appendMessage({role:'assistant',content:[{type:'toolCall',id:`c${i}`,name:'read',arguments:{path:`src/file-${i%6}.ts`}}],stopReason:'toolUse',timestamp:0});m.appendMessage({role:'toolResult',toolCallId:`c${i}`,toolName:'read',content:[{type:'text',text:`evidence-${i}: `+'x'.repeat(length)}],isError:false,timestamp:0});m.appendMessage({role:'assistant',content:[{type:'text',text:`Inspected ${i}.`}],stopReason:'stop',timestamp:0});}
function apply(m,ds){for(const d of ds){if(d.type==='custom')m.appendCustomEntry(d.customType,d.data);else if(d.type==='context_edit')m.appendContextEdit(d.targetId,d.replacement);else if(d.type==='compaction')m.appendCompaction(d.summary,d.firstKeptEntryId,0,d.details,true);}}
function plan(m,turn,c=config,extra={}){return planTurn({entries:m.buildSessionProjection().entries,branch:m.getBranch(),eventEntries:[],baseLeaf:m.getLeafId(),config:c,state:rebuild(m.getBranch(),m.getSessionId()),sessionId:m.getSessionId(),turn,...extra});}
function tick(m,turn,ds){apply(m,ds);m.appendCustomEntry(TELEMETRY_TYPE,{turn,messageEntryId:m.getLeafId()});}

test('batch interval and cumulative saving defer prefix mutation; high cache raises normal batch threshold',()=>{
 const m=manager();for(let i=0;i<8;i++)read(m,i);
 const c={...config,targetTokens:100000,minBatchSavingTokens:2500};
 assert.equal(plan(m,1,c).filter(d=>d.type==='context_edit').length,0);
 assert.equal(plan(m,3,c).filter(d=>d.type==='context_edit').length,0);
 const ordinary=plan(m,4,c);assert.ok(ordinary.some(d=>d.type==='context_edit'));
 assert.equal(plan(m,4,c,{cache:{input:10,cacheRead:10000}}).filter(d=>d.type==='context_edit').length,0);
 tick(m,4,ordinary);read(m,9);
 assert.equal(plan(m,5,c).filter(d=>d.type==='context_edit').length,0);
});

test('checkpoint decision uses previewed after-warm size, not provider usage or raw size',()=>{
 const m=manager();for(let i=0;i<10;i++)read(m,i,7000);
 const c={...config,targetTokens:11000,minCheckpointTurns:1};
 assert.ok(estimateProjection(m.buildSessionProjection().entries)>c.targetTokens);
 const ds=plan(m,10,c,{currentTokens:1000000});assert.ok(ds.some(d=>d.type==='context_edit'));assert.equal(ds.some(d=>d.type==='compaction'),false);
 apply(m,ds);assert.ok(estimateProjection(m.buildSessionProjection().entries)<c.targetTokens);
});

test('warm capsules stay stable, checkpoint epochs are sparse, and memory does not copy the transcript',()=>{
 const m=manager(),warmHashes=new Map(),checkpoints=[],batches=[],sizes=[];
 for(let turn=1;turn<=100;turn++){
  read(m,turn);
  const before=m.getBranch(),owned=ownedEdits(before),clock=turnClock(before),ds=plan(m,turn);
  const cp=ds.find(d=>d.type==='compaction');
  if(cp){checkpoints.push(turn);assert.ok(turn-clock.lastCheckpointTurn>=config.minCheckpointTurns);const cut=before.findIndex(e=>e.id===cp.firstKeptEntryId);for(const e of before.slice(0,cut))if(owned.has(e.id))assert.ok(turn-owned.get(e.id).warmTurn>=config.minCheckpointTurns);}
  if(ds.some(d=>d.type==='context_edit'))batches.push(turn);
  for(const d of ds.filter(d=>d.type==='context_edit')){assert.ok(!warmHashes.has(d.targetId),'existing capsule must never be rewritten');warmHashes.set(d.targetId,hash(d.replacement.content));}
  tick(m,turn,ds);
  const s=rebuild(m.getBranch(),m.getSessionId());sizes.push(serializedStateBytes(s.envelope??s.snapshot));
  assert.ok(s.snapshot.items.length<50);assert.ok(s.snapshot.coverage.length<=64);assert.ok(s.snapshot.items.every(i=>!i.text.includes('x'.repeat(100))));
  assert.ok((s.envelope?.edits??[]).every(e=>!('replacement' in e)));
  const composition=contextComposition(m.buildSessionProjection().entries,new Set(ownedEdits(m.getBranch()).keys()));assert.equal(Object.values(composition).reduce((n,v)=>n+v,0),estimateProjection(m.buildSessionProjection().entries));
 }
 assert.ok(checkpoints.length>=2,JSON.stringify({checkpoints,batches,sizes:sizes.slice(-5)}));assert.ok(checkpoints.length<batches.length/2,JSON.stringify({checkpoints,batches}));
 assert.ok(sizes.at(-1)<30000);assert.ok(Math.max(...sizes)<40000);
 assert.equal(turnClock(m.getBranch()).turn,100);
 const recalled=recallProjection(cwd,m.getHeader(),m.getBranch(),m.buildSessionProjection().entries);
 assert.ok(recalled.some(e=>e.messages.some(msg=>msg.role==='toolResult'&&msg.content[0]?.text.includes('evidence-1:'))),'cold evidence survives repeated own checkpoints');
});

test('checkpoint clock uses committed complete-turn records, not metadata or planned epochs',()=>{
 const m=manager();for(let i=0;i<100;i++)m.appendCustomEntry('other.metadata',{i});
 assert.deepEqual(turnClock(m.getBranch()),{turn:0,lastWarmTurn:0,lastCheckpointTurn:0,epoch:0});
 m.appendCustomEntry(TELEMETRY_TYPE,{turn:7});assert.equal(turnClock(m.getBranch()).turn,7);
 const state=rebuild(m.getBranch(),m.getSessionId());m.appendCustomEntry('rolling-context.state.v1',{schemaVersion:1,revision:1,planId:'uncommitted',baseLeafId:m.getLeafId(),snapshot:state.snapshot,edits:[],checkpoint:{firstKeptEntryId:m.getBranch()[0].id,summaryHash:hash('not committed')}});
 assert.equal(turnClock(m.getBranch()).epoch,0);
 const branchPoint=m.getLeafId();m.appendCustomEntry(TELEMETRY_TYPE,{turn:12});assert.equal(turnClock(m.getBranch()).turn,12);m.branch(branchPoint);assert.equal(turnClock(m.getBranch()).turn,7);
});

test('own cold storage is recallable but foreign edits and foreign compactions remain authoritative',()=>{
 const m=manager();for(let i=0;i<12;i++)read(m,i);
 const warm=plan(m,10,{...config,targetTokens:100000,minWarmTurns:1,minBatchSavingTokens:1});tick(m,10,warm);
 const resultId=warm.find(d=>d.type==='context_edit').targetId;
 const summary='[Rolling checkpoint]';const state=rebuild(m.getBranch(),m.getSessionId()).envelope;
 const first=m.getBranch().find(e=>e.type==='message'&&e.message.role==='assistant'&&e.message.content[0]?.id==='c9').id;
 const envelope={...state,checkpoint:{firstKeptEntryId:first,summaryHash:hash(summary)}};
 m.appendCompaction(summary,first,1000,{type:'rolling-context.checkpoint.v1',turn:20,stateEnvelope:envelope,firstKeptEntryId:first,summaryHash:hash(summary)},true);
 let restored=recallProjection(cwd,m.getHeader(),m.getBranch(),m.buildSessionProjection().entries);assert.ok(restored.some(e=>e.sourceEntry.id===resultId&&e.messages.length));
 m.appendContextEdit(resultId,{content:[{type:'text',text:'[redacted by another extension]'}]});restored=recallProjection(cwd,m.getHeader(),m.getBranch(),m.buildSessionProjection().entries);
 assert.equal(ownedEdits(m.getBranch()).has(resultId),false);assert.equal(restored.find(e=>e.sourceEntry.id===resultId).messages[0].content[0].text,'[redacted by another extension]');
 m.appendContextEdit(resultId,null);restored=recallProjection(cwd,m.getHeader(),m.getBranch(),m.buildSessionProjection().entries);assert.equal(restored.find(e=>e.sourceEntry.id===resultId).messages.length,0);
 m.appendCompaction('foreign',first,1000,{},false);const live=m.buildSessionProjection().entries;assert.deepEqual(recallProjection(cwd,m.getHeader(),m.getBranch(),live),live);
});

test('hard pressure may checkpoint fresh capsules, but retains their ownership and precise recall',()=>{
 const m=manager();for(let i=0;i<12;i++)read(m,i);
 const ds=plan(m,1,{...config,targetTokens:4800,contextWindow:8000,minCheckpointTurns:16});
 const cp=ds.find(d=>d.type==='compaction');assert.ok(cp);assert.equal(cp.details.reason,'hard');
 const edits=ds.filter(d=>d.type==='context_edit');assert.ok(edits.length);tick(m,1,ds);
 const owned=ownedEdits(m.getBranch());for(const d of edits)assert.ok(owned.has(d.targetId),'same-turn cold edit must retain append-order provenance');
 const recovered=recallProjection(cwd,m.getHeader(),m.getBranch(),m.buildSessionProjection().entries);assert.ok(recovered.find(e=>e.sourceEntry.id===edits[0].targetId).messages.length);
 assert.equal(turnClock(m.getBranch()).lastCheckpointTurn,1);
});

test('soft pressure does not turn ordinary prefix maintenance into a per-turn rewrite',()=>{
 const m=manager(),turns=[];const c={...config,targetTokens:2000,minCheckpointTurns:1000};
 for(let turn=1;turn<=20;turn++){read(m,turn);const ds=plan(m,turn,c);if(ds.some(d=>d.type==='context_edit'))turns.push(turn);tick(m,turn,ds);}
 assert.ok(turns.length>1);for(let i=1;i<turns.length;i++)assert.ok(turns[i]-turns[i-1]>=2);
});

test('legacy warm capsules get one conservative clock annotation without a new context edit',()=>{
 const m=manager();for(let i=0;i<8;i++)read(m,i);
 const c={...config,targetTokens:100000,minWarmTurns:1,minBatchSavingTokens:1};const ds=plan(m,4,c);
 const envelope=ds.find(d=>d.type==='custom').data;for(const edit of envelope.edits){delete edit.warmTurn;edit.replacement='legacy duplicated capsule field';}
 tick(m,5,ds);const metadata=plan(m,6,{...c,minWarmTurns:100});assert.ok(metadata.some(d=>d.type==='custom'));assert.equal(metadata.some(d=>d.type==='context_edit'),false);
 apply(m,metadata);assert.ok([...ownedEdits(m.getBranch()).values()].every(e=>e.warmTurn===5));
 assert.equal(plan(m,7,{...c,minWarmTurns:100}).length,0);
});

test('small consumed safe evidence can move directly from hot to cold without a warm edit',()=>{
 const m=manager();for(let i=0;i<120;i++)read(m,i,48);
 const c={...config,targetTokens:700,minCheckpointTurns:1,minWarmTurns:100,minBatchSavingTokens:100000};const metrics={};
 const ds=plan(m,20,c,{metrics});
 assert.ok(metrics.afterWarmTokens>c.targetTokens);
 assert.equal(ds.some(d=>d.type==='context_edit'),false);
 assert.ok(ds.some(d=>d.type==='compaction'),JSON.stringify({metrics,drafts:ds.map(d=>d.type)}));
 assert.equal(metrics.checkpointCandidate,true);
 assert.ok(!metrics.checkpointBlockedBy.includes('WARM_REQUIRED'));
});

test('newly warmed valuable sources remain warm through the same-turn checkpoint boundary',()=>{
 const m=manager();for(let i=0;i<30;i++)read(m,i,48);for(let i=30;i<34;i++)read(m,i,12000);
 const c={...config,targetTokens:8000,minCheckpointTurns:1,minWarmTurns:1,minBatchSavingTokens:1,contextWindow:1000000};
 const ds=plan(m,10,c);const edits=ds.filter(d=>d.type==='context_edit'),checkpoint=ds.find(d=>d.type==='compaction');
 assert.ok(edits.length>0);
 if(checkpoint){const cut=m.getBranch().findIndex(entry=>entry.id===checkpoint.firstKeptEntryId);for(const edit of edits){const source=m.getBranch().findIndex(entry=>entry.id===edit.targetId);assert.ok(source>=cut,`fresh warm source ${edit.targetId} was made cold in its creating turn`);}}
});

test('continuity fallback runs only for checkpoint pressure and stays bounded with provenance',()=>{
 const quiet=SessionManager.inMemory(cwd,{id:'quiet-fallback'},[{...header,id:'quiet-fallback'}]);
 quiet.appendMessage({role:'user',content:'Inspect the current adapter.',timestamp:0});quiet.appendMessage({role:'assistant',content:[{type:'text',text:'I will inspect the adapter.'}],stopReason:'stop',timestamp:0});
 const noPressure={};const quietPlan=plan(quiet,1,{...config,targetTokens:100000,minCheckpointTurns:1},{metrics:noPressure});
 assert.equal(noPressure.checkpointWanted,false);assert.ok(!quietPlan.find(d=>d.type==='custom')?.data.snapshot.items.some(item=>item.id==='rc-fallback-continuity'));

 const missingUser=SessionManager.inMemory(cwd,{id:'missing-fallback-user'},[{...header,id:'missing-fallback-user'}]);for(let i=0;i<12;i++)read(missingUser,i,7000);
 const missingMetrics={};const missingPlan=plan(missingUser,20,{...config,targetTokens:1000,minCheckpointTurns:1},{metrics:missingMetrics});
 assert.equal(missingMetrics.checkpointWanted,true);assert.ok(missingMetrics.checkpointBlockedBy.includes('MISSING_CONTINUITY_STATE'));assert.equal(missingPlan.some(d=>d.type==='compaction'),false);

 const branchManager=SessionManager.inMemory(cwd,{id:'pressure-fallback'},[{...header,id:'pressure-fallback'}]);
 branchManager.appendMessage({role:'user',content:'Implement the adapter and preserve the public API.',timestamp:0});
 for(let i=0;i<12;i++)read(branchManager,i,7000);
 branchManager.appendMessage({role:'user',content:'Continue with the adapter.',timestamp:0});branchManager.appendMessage({role:'assistant',content:[{type:'text',text:'The adapter is still under review.'}],stopReason:'stop',timestamp:0});
 const pressured={};const pressureConfig={...config,targetTokens:1000,minCheckpointTurns:1,minWarmTurns:1,minBatchSavingTokens:1};
 const pressuredPlan=plan(branchManager,20,pressureConfig,{metrics:pressured});
 assert.equal(pressured.checkpointWanted,true);
 const fallback=pressuredPlan.find(d=>d.type==='custom')?.data.snapshot.items.find(item=>item.id==='rc-fallback-continuity');
 assert.ok(fallback);assert.equal(fallback.authority,'inference');assert.ok(fallback.text.includes('unverified'));
 const fallbackState=pressuredPlan.find(d=>d.type==='custom').data.snapshot;const request=fallbackState.items.find(item=>item.key==='latest-user-request');assert.equal(request.text,'Continue with the adapter.');assert.deepEqual(request.sourceSpan,{start:0,end:request.text.length});
 const recentIds=new Set(branchManager.buildSessionProjection().entries.slice(-12).map(entry=>entry.sourceEntry.id));assert.ok(fallback.sourceEntryIds.every(id=>recentIds.has(id)));
 assert.equal(pressuredPlan.find(d=>d.type==='custom').data.snapshot.focus.goal.authority,'user');
});

test('ordinary user follow-ups do not accumulate pinned transcript copies; explicit constraints remain sourced',()=>{
 const m=manager(),samples=[];let userIds=[];
 for(let turn=1;turn<=40;turn++){
  const text=turn===1?'Do not change public APIs. Preserve the existing configuration format.':['Continue','Look at this','This effect is not good'][turn%3];
  const userId=m.appendMessage({role:'user',content:text,timestamp:turn});userIds.push(userId);
  m.appendMessage({role:'assistant',content:[{type:'text',text:'I will continue the current task.'}],stopReason:'stop',timestamp:turn});
  const ds=plan(m,turn,{...config,targetTokens:100000,minCheckpointTurns:1000});apply(m,ds);
  const state=rebuild(m.getBranch(),m.getSessionId());samples.push(serializedStateBytes(state.envelope??state.snapshot));
  assert.ok(state.snapshot.items.filter(item=>item.key==='latest-user-request').length<=1);
  if(turn>1)assert.ok(!state.snapshot.items.some(item=>item.sourceEntryIds.includes(userIds[turn-2])&&item.pinReason==='current-request'));
  assert.ok(state.snapshot.items.length<8);tick(m,turn,[]);
 }
 const snapshot=rebuild(m.getBranch(),m.getSessionId()).snapshot;
 const constraints=snapshot.items.filter(item=>item.kind==='constraint'&&item.authority==='user');
 assert.ok(constraints.some(item=>item.text.includes('Do not change public APIs')));
 assert.ok(constraints.every(item=>item.pinned&&item.sourceEntryIds.length===1&&item.sourceSpan));
 assert.ok(Math.max(...samples)-Math.min(...samples)<5000,`working state grew with the transcript: ${samples.slice(0,3)} ... ${samples.slice(-3)}`);
 assert.ok(explicitUserConstraints('Continue').length===0);
});

test('warm batch records its earliest mutation, stable-prefix cost, and source-to-capsule delta',()=>{
 const m=manager();for(let i=0;i<10;i++)read(m,i,6000);const metrics={};
 const ds=plan(m,8,{...config,targetTokens:100000,minWarmTurns:1,minBatchSavingTokens:1}, {metrics});
 assert.ok(ds.some(d=>d.type==='context_edit'));
 assert.ok(Number.isSafeInteger(metrics.earliestMutationPosition));assert.ok(metrics.earliestMutationEntryId);
 assert.ok(metrics.projectedTokensBeforeMutation>=0);assert.ok(metrics.estimatedInvalidatedSuffixTokens>0);
 assert.ok(metrics.warmSourceTokens>metrics.warmCapsuleTokens);assert.ok(metrics.warmTokensSaved>0);
 assert.ok(Math.abs(metrics.projectedTokensBeforeMutation+metrics.estimatedInvalidatedSuffixTokens-estimateProjection(m.buildSessionProjection().entries))<100);
});

test('foreign/native compaction does not advance RC epoch; only a validated RC checkpoint does',()=>{
 const m=manager();const firstKept=m.getBranch().find(entry=>entry.type==='message').id;
 m.appendCompaction('host compact',firstKept,100,{},false);assert.equal(turnClock(m.getBranch()).epoch,0);
 const state=rebuild(m.getBranch(),m.getSessionId()),summary='[Rolling checkpoint]',summaryHash=hash(summary);
 const envelope={schemaVersion:1,revision:1,planId:'epoch',baseLeafId:m.getLeafId(),snapshot:{...state.snapshot,revision:1},edits:[],checkpoint:{firstKeptEntryId:firstKept,summaryHash}};
 m.appendCompaction(summary,firstKept,100,{type:'rolling-context.checkpoint.v1',turn:4,firstKeptEntryId:firstKept,summaryHash,stateEnvelope:envelope},true);
 assert.equal(turnClock(m.getBranch()).epoch,1);
});
