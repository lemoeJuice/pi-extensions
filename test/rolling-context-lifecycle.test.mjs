import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { planTurn, rebuild, estimateProjection, ownedEdits, turnClock, TELEMETRY_TYPE, recallProjection, hash, contextComposition, serializedStateBytes } from '../extensions/rolling-context/lib.ts';
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
