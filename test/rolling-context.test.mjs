import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { analyzeGroups, effectiveTarget, emptySnapshot, groups, hash, makeCapsule, planTurn, rebuild, renderCheckpoint } from '../extensions/rolling-context/lib.ts';

const assistant=(id,stopReason,content)=>({type:'message',id,parentId:null,timestamp:'',message:{role:'assistant',content,stopReason,timestamp:0}});
const tool=(id,callId,text)=>({type:'message',id,parentId:null,timestamp:'',message:{role:'toolResult',toolCallId:callId,toolName:'read',content:[{type:'text',text}],isError:false,timestamp:0}});
const user=(id,text)=>({type:'message',id,parentId:null,timestamp:'',message:{role:'user',content:text,timestamp:0}});
const call={type:'toolCall',id:'c1',name:'read',arguments:{path:'src/a.ts'}};

test('tool group is consumable only after a later successful assistant response',()=>{
 const es=[assistant('a1','toolUse',[call]),tool('r1','c1','x'.repeat(3000)),assistant('a2','stop',[{type:'text',text:'read complete'}])];
 const projection=es.map(e=>({sourceEntry:e,messages:[e.message]}));
 const [group]=groups(projection);assert.equal(group.complete,true);assert.equal(group.consumed,true);assert.ok(makeCapsule(group,es));
 const noFollow=[assistant('a1','toolUse',[call]),tool('r1','c1','x'.repeat(3000))].map(e=>({sourceEntry:e,messages:[e.message]}));
 assert.equal(groups(noFollow)[0].consumed,false);
});

test('incomplete tool groups are protected',()=>{
 const projection=[assistant('a1','toolUse',[call])].map(e=>({sourceEntry:e,messages:[e.message]}));
 const [g]=groups(projection);assert.equal(g.complete,false);assert.equal(g.consumed,false);assert.equal(makeCapsule(g,[]),undefined);
});

function repeatedReadHistory(count=4){
 const branch=[user('u0','Inspect files carefully')];
 for(let i=0;i<count;i++){
  const call=assistant(`call-${i}`,'toolUse',[{type:'toolCall',id:`read-${i}`,name:'read',arguments:{path:`src/${i}.ts`}}]);call.parentId=branch.at(-1).id;branch.push(call);
  const result=tool(`result-${i}`,`read-${i}`,`content-${i}: ${'x'.repeat(3000)}`);result.parentId=branch.at(-1).id;branch.push(result);
  const done=assistant(`done-${i}`,'stop',[{type:'text',text:`Inspected ${i}`} ]);done.parentId=branch.at(-1).id;branch.push(done);
 }
 return branch;
}

test('planner preserves the three newest groups and pinned/path-dependent evidence',()=>{
 const branch=repeatedReadHistory(6);const entries=branch.map(e=>({sourceEntry:e,messages:[e.message]}));const state=rebuild(branch,'s');
 state.snapshot.items.push({id:'decision-path',key:'decision-path',kind:'task-decision',text:'Need exact source',status:'active',authority:'agent-report',sourceEntryIds:['note'],taskId:'RC-T-u0',dependencies:[{path:'src/0.ts'}],observedAtEntryId:'note',pinned:false});
 state.snapshot.items.push({id:'pinned-source',key:'pin',kind:'project',text:'Keep this result',status:'active',authority:'tool-evidence',sourceEntryIds:['result-1'],taskId:'RC-T-u0',dependencies:[],observedAtEntryId:'result-1',pinned:true});
 const plan=planTurn({entries,branch,eventEntries:[],baseLeaf:branch.at(-1).id,config:{mode:'on',targetTokens:100000,reserveTokens:0,minSavingTokens:1,minWarmTurns:1,minBatchSavingTokens:1,minCheckpointTurns:100,recallMaxTokens:2000},state,sessionId:'s'});
 assert.deepEqual(plan.filter(x=>x.type==='context_edit').map(x=>x.targetId),['result-2']);
});

test('observe can inspect candidates without changing the off-mode invariant',()=>{
 const branch=repeatedReadHistory(4);const entries=branch.map(e=>({sourceEntry:e,messages:[e.message]}));const state=rebuild(branch,'s');
 const base={entries,branch,eventEntries:[],baseLeaf:branch.at(-1).id,config:{mode:'observe',targetTokens:100000,reserveTokens:0,minSavingTokens:1,minWarmTurns:1,minBatchSavingTokens:1,minCheckpointTurns:100,recallMaxTokens:2000},state,sessionId:'s'};
 const observed=planTurn(base);assert.ok(observed.some(x=>x.type==='context_edit'));assert.ok(analyzeGroups(entries,state.snapshot).some(g=>g.reasons.includes('RECENT_GROUP')));
 assert.deepEqual(planTurn({...base,config:{...base.config,mode:'off'}}),[]);
});

test('effective context budget honors model window, reserve, and unknown-window fallback',()=>{
 const config={mode:'on',targetTokens:32768,reserveTokens:16000,minSavingTokens:256,minCheckpointTurns:8,recallMaxTokens:2000};
 assert.equal(effectiveTarget({...config,contextWindow:128000}),32768);
 assert.equal(effectiveTarget({...config,contextWindow:32000}),13952);
 assert.equal(effectiveTarget({...config,contextWindow:1000}),0);
 assert.equal(effectiveTarget(config),32768);
});

test('oversized task state causes the complete boundary plan to be rejected',()=>{
 const branch=[user('large-user','x'.repeat(140000)),assistant('large-assistant','stop',[{type:'text',text:'response'}])];const entries=branch.map(e=>({sourceEntry:e,messages:[e.message]}));
 const plan=planTurn({entries,branch,eventEntries:[],baseLeaf:'large-assistant',config:{mode:'on',targetTokens:1000000,reserveTokens:0,contextWindow:2000000,minSavingTokens:1,minWarmTurns:1,minBatchSavingTokens:1,minCheckpointTurns:100,recallMaxTokens:2000},state:rebuild(branch,'s'),sessionId:'s'});
 assert.deepEqual(plan,[]);
});

test('rebuild reconciles planned edits against the active branch projection',()=>{
 const cwd='/tmp/rolling-context-reconcile-test';const header={type:'session',version:3,id:'reconcile-session',timestamp:new Date().toISOString(),cwd};
 const branch=repeatedReadHistory(4);const entries=branch.map(e=>({sourceEntry:e,messages:[e.message]}));const state=rebuild(branch,'reconcile-session');
 const plan=planTurn({entries,branch,eventEntries:[],baseLeaf:branch.at(-1).id,config:{mode:'on',targetTokens:100000,reserveTokens:0,minSavingTokens:1,minWarmTurns:1,minBatchSavingTokens:1,minCheckpointTurns:100,recallMaxTokens:2000},state,sessionId:'reconcile-session'});
 const stateDraft=plan.find(x=>x.type==='custom'),editDraft=plan.find(x=>x.type==='context_edit');assert.ok(stateDraft&&editDraft);
 const partial=SessionManager.inMemory(cwd,{id:header.id},[header,...branch]);partial.appendCustomEntry(stateDraft.customType,stateDraft.data);
 const partialState=rebuild(partial.getBranch(),'reconcile-session');assert.equal(partialState.envelope.edits.length,0);assert.ok(partialState.diagnostics.some(x=>x.includes('not active')));
 const committed=SessionManager.inMemory(cwd,{id:header.id},[header,...branch]);committed.appendCustomEntry(stateDraft.customType,stateDraft.data);committed.appendContextEdit(editDraft.targetId,editDraft.replacement);
 const committedState=rebuild(committed.getBranch(),'reconcile-session');assert.equal(committedState.envelope.edits.length,1);
 const projection=committed.buildSessionProjection().entries.find(entry=>entry.sourceEntry.id===editDraft.targetId);assert.equal(projection.messages[0].role,'toolResult');assert.ok(Array.isArray(projection.messages[0].content));
 const replayBranch=committed.getBranch();const replayState=rebuild(replayBranch,'reconcile-session');
 const replayPlan=planTurn({entries:committed.buildSessionProjection().entries,branch:replayBranch,eventEntries:[],baseLeaf:committed.getLeafId(),config:{mode:'on',targetTokens:100000,reserveTokens:0,minSavingTokens:1,minWarmTurns:1,minBatchSavingTokens:1,minCheckpointTurns:100,recallMaxTokens:2000},state:replayState,sessionId:'reconcile-session'});assert.equal(replayPlan.length,0,JSON.stringify(replayPlan.map(x=>({type:x.type,targetId:x.targetId,customType:x.customType}))));
 committed.appendContextEdit(editDraft.targetId,{content:[{type:'text',text:'replacement by another extension'}]});
 const overwritten=rebuild(committed.getBranch(),'reconcile-session');assert.equal(overwritten.envelope.edits.length,0);assert.ok(overwritten.diagnostics.some(x=>x.includes('not active')));
});

test('rebuild does not advance a planned checkpoint until its compaction entry exists',()=>{
 const cwd='/tmp/rolling-context-checkpoint-test';const header={type:'session',version:3,id:'checkpoint-session',timestamp:new Date().toISOString(),cwd};
 const branch=[user('u','Keep this request'),assistant('a','stop',[{type:'text',text:'Done'}])];const base=rebuild(branch,'checkpoint-session');
 const summary=renderCheckpoint(base.snapshot);const summaryHash=hash(summary);
 const data={schemaVersion:1,revision:1,planId:'p1',baseLeafId:'a',snapshot:{...base.snapshot,revision:1},edits:[],checkpoint:{firstKeptEntryId:'a',summaryHash:summaryHash}};
 const missing=SessionManager.inMemory(cwd,{id:header.id},[header,...branch]);missing.appendCustomEntry('rolling-context.state.v1',data);
 const beforeCommit=rebuild(missing.getBranch(),'checkpoint-session');assert.equal(beforeCommit.envelope.checkpoint,undefined);assert.ok(beforeCommit.diagnostics.some(x=>x.includes('no matching committed compaction')));
 const committed=SessionManager.inMemory(cwd,{id:header.id},[header,...branch]);committed.appendCustomEntry('rolling-context.state.v1',data);
 committed.appendCompaction(summary,'a',100,{type:'rolling-context.checkpoint.v1',planId:'p1',stateEnvelope:data,firstKeptEntryId:'a',summaryHash},true);
 const afterCommit=rebuild(committed.getBranch(),'checkpoint-session');assert.equal(afterCommit.envelope.checkpoint.firstKeptEntryId,'a');assert.equal(afterCommit.envelope.checkpoint.summaryHash,summaryHash);
});

test('unknown tool outputs and shell composition are not capsule candidates',()=>{
 const callMessage=assistant('u','toolUse',[{type:'toolCall',id:'c',name:'unknown_tool',arguments:{}}]);
 const result={type:'message',id:'r',parentId:'u',timestamp:'',message:{role:'toolResult',toolCallId:'c',toolName:'unknown_tool',content:[{type:'text',text:'x'.repeat(3000)}],isError:false,timestamp:0}};
 const group=groups([callMessage,result,assistant('done','stop',[{type:'text',text:'consumed'}])].map(e=>({sourceEntry:e,messages:[e.message]})))[0];assert.equal(makeCapsule(group,[callMessage,result]),undefined);
 const bashCall=assistant('b','toolUse',[{type:'toolCall',id:'bash-call',name:'bash',arguments:{command:'rg needle src | head'}}]);
 const bashResult={type:'message',id:'br',parentId:'b',timestamp:'',message:{role:'toolResult',toolCallId:'bash-call',toolName:'bash',content:[{type:'text',text:'needle'}],isError:false,timestamp:0}};
 const bashGroup=groups([bashCall,bashResult,assistant('bdone','stop',[{type:'text',text:'consumed'}])].map(e=>({sourceEntry:e,messages:[e.message]})))[0];assert.equal(makeCapsule(bashGroup,[bashCall,bashResult]),undefined);
});

test('rolling task notes rebuild only from branch and checkpoint distinguishes intent/task decisions',()=>{
 const branch=[user('u1','Please preserve the API'),{type:'message',id:'note',parentId:'u1',timestamp:'',message:{role:'toolResult',toolCallId:'n1',toolName:'context_note',content:[{type:'text',text:'Recorded'}],isError:false,timestamp:0,details:{type:'rolling-context.note.v1',noteId:'n1',taskId:'RC-T-u1',kind:'task-decision',text:'Use an adapter for this task',paths:[]}}}];
 const state=rebuild(branch,'session');assert.equal(state.snapshot.focus.taskId,'RC-T-u1');assert.equal(state.snapshot.items[0].kind,'task-decision');
 state.snapshot.intentRefs.push({storePath:'/p/.pi/design-intent.json',storeRevision:3,sourceHash:'abcdef123456',id:'DI-0001',projection:'Preserve invariants'});
 const cp=renderCheckpoint(state.snapshot);assert.match(cp,/Design Intent/);assert.match(cp,/task-decision/);assert.match(cp,/DI-0001/);
});

test('a replacement supersedes only a task-local note',()=>{
 const branch=[user('u1','Keep behavior'),
  {type:'message',id:'n1',parentId:'u1',timestamp:'',message:{role:'toolResult',toolCallId:'c1',toolName:'context_note',content:[{type:'text',text:'Recorded'}],isError:false,timestamp:0,details:{type:'rolling-context.note.v1',noteId:'c1',taskId:'RC-T-u1',kind:'task-decision',text:'Approach A',replaces:[]}}},
  {type:'message',id:'n2',parentId:'n1',timestamp:'',message:{role:'toolResult',toolCallId:'c2',toolName:'context_note',content:[{type:'text',text:'Recorded'}],isError:false,timestamp:0,details:{type:'rolling-context.note.v1',noteId:'c2',taskId:'RC-T-u1',kind:'task-decision',text:'Approach B',replaces:['c1']}}},
 ];
 const state=rebuild(branch,'s').snapshot;assert.equal(state.items.find(x=>x.id==='c1').status,'superseded');assert.equal(state.items.find(x=>x.id==='c2').status,'active');
});

test('checkpoint planning stores complete user instruction separately from task decision',()=>{
 const u=user('u1','Do not change public interfaces');const a=assistant('a1','stop',[{type:'text',text:'I will inspect.'}]);
 const branch=[u,a];const entries=branch.map(e=>({sourceEntry:e,messages:[e.message]}));
 const state=rebuild(branch,'s');const plan=planTurn({entries,branch,eventEntries:[],baseLeaf:'a1',config:{mode:'on',targetTokens:1,reserveTokens:0,minSavingTokens:1,minCheckpointTurns:1,recallMaxTokens:2000},state,sessionId:'s'});
 const envelope=plan.find(x=>x.type==='custom')?.data;
 assert.ok(envelope);assert.ok(envelope.snapshot.items.some(i=>i.authority==='user'&&i.text==='Do not change public interfaces'));
});

test('edit evidence invalidates prior file observations and matching tests',()=>{
 const editCall={type:'toolCall',id:'edit-call',name:'edit',arguments:{intent:'change file',patch:'patch'}};
 const e0=assistant('a1','toolUse',[editCall]);
 const editResult={type:'message',id:'r1',parentId:'a1',timestamp:'',message:{role:'toolResult',toolCallId:'edit-call',toolName:'edit',content:[{type:'text',text:'Applied update'}],details:{changes:[{path:'src/a.ts',kind:'update'}]},isError:false,timestamp:0}};
 const done=assistant('a2','stop',[{type:'text',text:'Updated the file.'}]);
 const userEntry=user('u1','Update implementation');
 const branch=[userEntry,e0,editResult,done];const entries=branch.map(e=>({sourceEntry:e,messages:[e.message]}));
 const state=rebuild(branch,'s');state.snapshot.items.push({id:'test-old',key:'test:unit',kind:'test',text:'Previously passed',status:'active',authority:'tool-evidence',sourceEntryIds:['old-test'],taskId:'RC-T-u1',dependencies:[],observedAtEntryId:'old-test',pinned:false});
 const plan=planTurn({entries,branch,eventEntries:[],baseLeaf:'a2',config:{mode:'on',targetTokens:100000,reserveTokens:0,minSavingTokens:99999,minCheckpointTurns:100,recallMaxTokens:2000},state,sessionId:'s'});
 const envelope=plan.find(x=>x.type==='custom')?.data;assert.ok(envelope);assert.equal(envelope.snapshot.items.find(x=>x.id==='test-old').status,'stale');assert.ok(envelope.snapshot.items.some(x=>x.kind==='change'&&x.dependencies[0].path==='src/a.ts'));
});

test('test results are tool evidence and become stale after an unrelated edit when scope is unknown',()=>{
 const branch=[user('task','Run tests then update the module')];
 const testCall=assistant('test-call','toolUse',[{type:'toolCall',id:'test-run',name:'bash',arguments:{command:'pnpm test --filter unit'}}]);testCall.parentId='task';branch.push(testCall);
 const testResult={type:'message',id:'test-result',parentId:'test-call',timestamp:'',message:{role:'toolResult',toolCallId:'test-run',toolName:'bash',content:[{type:'text',text:'1 test passed'}],isError:false,timestamp:0}};branch.push(testResult);
 const testDone=assistant('test-done','stop',[{type:'text',text:'Tests passed.'}]);testDone.parentId='test-result';branch.push(testDone);
 const editCall=assistant('edit-call','toolUse',[{type:'toolCall',id:'edit-run',name:'edit',arguments:{intent:'update module',patch:'...'}}]);editCall.parentId='test-done';branch.push(editCall);
 const editResult={type:'message',id:'edit-result',parentId:'edit-call',timestamp:'',message:{role:'toolResult',toolCallId:'edit-run',toolName:'edit',content:[{type:'text',text:'Applied update'}],details:{changes:[{path:'src/module.ts',kind:'update'}]},isError:false,timestamp:0}};branch.push(editResult);
 const editDone=assistant('edit-done','stop',[{type:'text',text:'Updated module.'}]);editDone.parentId='edit-result';branch.push(editDone);
 const entries=branch.map(e=>({sourceEntry:e,messages:[e.message]}));const plan=planTurn({entries,branch,eventEntries:[],baseLeaf:'edit-done',config:{mode:'on',targetTokens:100000,reserveTokens:0,minSavingTokens:99999,minCheckpointTurns:100,recallMaxTokens:2000},state:rebuild(branch,'s'),sessionId:'s'});
 const testEvidence=plan.find(x=>x.type==='custom')?.data.snapshot.items.find(item=>item.kind==='test');
 assert.ok(testEvidence);assert.equal(testEvidence.authority,'tool-evidence');assert.match(testEvidence.text,/Scope and current file version still require verification/);assert.equal(testEvidence.status,'stale');
});

test('checkpoint planning refuses images and unknown extension contributions',()=>{
 const branch=[user('u-image',[{type:'text',text:'Inspect the old design.'},{type:'image',data:'not-retained',mimeType:'image/png'}])];
 for(let i=0;i<8;i++){const a=assistant(`report-${i}`,'stop',[{type:'text',text:`Detailed progress ${i}: ${'x'.repeat(3000)}`}]);a.parentId=branch.at(-1).id;branch.push(a);}
 const latest=user('u-latest','Continue with the current task.');latest.parentId=branch.at(-1).id;branch.push(latest);
 const done=assistant('latest-done','stop',[{type:'text',text:'Continuing.'}]);done.parentId='u-latest';branch.push(done);
 const entries=branch.map(e=>({sourceEntry:e,messages:[e.message]}));
 const config={mode:'on',targetTokens:2048,reserveTokens:0,minSavingTokens:99999,minCheckpointTurns:1,recallMaxTokens:2000};
 const imagePlan=planTurn({entries,branch,eventEntries:[],baseLeaf:'latest-done',config,state:rebuild(branch,'image-session'),sessionId:'image-session'});
 assert.ok(!imagePlan.some(draft=>draft.type==='compaction'));
 const foreign={type:'custom_message',id:'foreign',parentId:'latest-done',timestamp:'',customType:'other-extension.v1',content:[{type:'text',text:'hidden extension state'}],display:false};
 const foreignBranch=[...branch,foreign];const foreignEntries=[...entries,{sourceEntry:foreign,messages:[{role:'custom',customType:'other-extension.v1',content:'hidden extension state',timestamp:0}]}];
 const foreignPlan=planTurn({entries:foreignEntries,branch:foreignBranch,eventEntries:[],baseLeaf:'foreign',config,state:rebuild(foreignBranch,'foreign-session'),sessionId:'foreign-session'});
 assert.ok(!foreignPlan.some(draft=>draft.type==='compaction'));
 const externalEdit={type:'context_edit',id:'external-edit',parentId:'latest-done',targetId:'report-0',replacement:null};const editedBranch=[...branch,externalEdit];
 const externalEditPlan=planTurn({entries,branch:editedBranch,eventEntries:[],baseLeaf:'external-edit',config,state:rebuild(editedBranch,'external-edit-session'),sessionId:'external-edit-session'});
 assert.ok(!externalEditPlan.some(draft=>draft.type==='compaction'));
});

test('one branch remains a single task scope rather than guessing from later user messages',()=>{
 const branch=[user('u1','Inspect component A'),user('u2','Now inspect unrelated component B')];
 const state=rebuild(branch,'session');assert.equal(state.snapshot.focus.taskId,'RC-T-u1');
 const entries=branch.map(e=>({sourceEntry:e,messages:[e.message]}));
 const plan=planTurn({entries,branch,eventEntries:[],baseLeaf:'u2',config:{mode:'on',targetTokens:100000,reserveTokens:0,minSavingTokens:1,minWarmTurns:1,minBatchSavingTokens:1,minCheckpointTurns:100,recallMaxTokens:2000},state,sessionId:'session'});
 const snapshot=plan.find(d=>d.type==='custom')?.data.snapshot;
 assert.ok(snapshot.items.filter(item=>item.authority==='user').every(item=>item.taskId==='RC-T-u1'));
});
