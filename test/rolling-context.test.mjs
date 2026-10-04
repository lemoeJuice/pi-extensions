import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySnapshot, groups, makeCapsule, planTurn, rebuild, renderCheckpoint } from '../extensions/rolling-context/lib.ts';

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
