import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import rollingContext from '../extensions/rolling-context/index.ts';
import designIntent from '../extensions/design-intent/index.ts';
import { UIBroker } from '../extensions/daemon/ui/broker.ts';
import { installUIProxy } from '../extensions/daemon/ui/adapter.ts';
import { emptyStore, serializeStore, sha } from '../extensions/design-intent/lib.ts';
import { rebuild, hash } from '../extensions/rolling-context/lib.ts';

function mockPi(overrides={}){
 const tools=new Map(),commands=new Map(),events=new Map(),flags=new Map(),appended=[];
 events.emit=(name,payload)=>{for(const handler of events.get(name)||[])handler(payload);};
 return{tools,commands,events,flags,appended,
  registerTool(tool){assert.ok(!tools.has(tool.name));tools.set(tool.name,tool);},
  registerCommand(name,command){commands.set(name,command);},
  registerFlag(name,definition){flags.set(name,definition);},
  getFlag(name){return overrides[name]??flags.get(name)?.default;},
  getAllTools(){return [{name:'read',parameters:{'x-pi-guardrails-contract':'pi-guardrails.read-intent.v1'}},...tools.values()];},
  on(name,handler){const handlers=events.get(name)||[];handlers.push(handler);events.set(name,handlers);},
  appendEntry(customType,data){appended.push({customType,data});},
 };
}

test('both context extensions register their public tools, commands, and lifecycle hooks',()=>{
 const rolling=mockPi();rollingContext(rolling);
 assert.deepEqual([...rolling.tools.keys()],['context_note','context_recall']);
 assert.ok(rolling.commands.has('rolling-context'));
 assert.ok(rolling.events.has('turn_end'));
 const design=mockPi();designIntent(design);
 assert.deepEqual([...design.tools.keys()],['design_intent_query','design_intent_get','design_intent_propose','design_intent_check']);
 assert.equal(design.tools.get('design_intent_query').parameters['x-pi-guardrails-contract'],'design-intent.read-projection.v1');
 assert.equal(design.tools.get('design_intent_get').parameters['x-pi-guardrails-contract'],'design-intent.read-projection.v1');
 assert.ok(design.commands.has('design-intent'));
 assert.ok(design.events.has('before_agent_start'));
});

test('observe reports a simulated plan and submits only non-context telemetry',async()=>{
 const cwd='/tmp/rolling-context-observe-test';const header={type:'session',version:3,id:'observe-session',timestamp:new Date().toISOString(),cwd};
 const branch=[{type:'message',id:'u1',parentId:null,timestamp:'',message:{role:'user',content:'Inspect the module',timestamp:0}},{type:'message',id:'a1',parentId:'u1',timestamp:'',message:{role:'assistant',content:[{type:'text',text:'I will inspect it.'}],stopReason:'stop',timestamp:0}}];
 const manager=SessionManager.inMemory(cwd,{id:header.id},[header,...branch]);const pi=mockPi();rollingContext(pi);
 const notices=[];const ctx={cwd,sessionManager:manager,getContextUsage:()=>undefined,ui:{notify:(text)=>notices.push(text)}};
 const before=manager.getBranch().length;const handler=pi.events.get('turn_end')[0];
 const result=await handler({outcome:'completed',messageEntryId:manager.getBranch().at(-1).id,message:manager.getBranch().at(-1).message,entries:[],context:{contextEntries:manager.buildSessionProjection().entries}},ctx);
 assert.deepEqual(result.entries.map(d=>d.customType),['rolling-context.telemetry.v1']);assert.equal(manager.getBranch().length,before);
 await pi.commands.get('rolling-context').handler('status',ctx);
 assert.match(notices.at(-1),/observe:.*writes=0/);assert.match(notices.at(-1),/projectionValid=true/);
});

test('on-mode turn boundary returns replayable edits without breaking tool pairing',async()=>{
 const cwd='/tmp/rolling-context-turn-boundary-test';const header={type:'session',version:3,id:'turn-boundary-session',timestamp:new Date().toISOString(),cwd};const branch=[];const push=entry=>{entry.parentId=branch.at(-1)?.id??null;branch.push(entry);};
 push({type:'message',id:'u',timestamp:'',message:{role:'user',content:'Inspect these files',timestamp:0}});
 for(let i=0;i<6;i++){
  push({type:'message',id:`call-${i}`,timestamp:'',message:{role:'assistant',content:[{type:'toolCall',id:`read-${i}`,name:'read',arguments:{path:`src/${i}.ts`}}],stopReason:'toolUse',timestamp:0}});
  push({type:'message',id:`result-${i}`,timestamp:'',message:{role:'toolResult',toolCallId:`read-${i}`,toolName:'read',content:[{type:'text',text:`file ${i}: ${'content '.repeat(500)}`}],isError:false,timestamp:0}});
  push({type:'message',id:`done-${i}`,timestamp:'',message:{role:'assistant',content:[{type:'text',text:`Read file ${i}`}],stopReason:'stop',timestamp:0}});
 }
 const manager=SessionManager.inMemory(cwd,{id:header.id},[header,...branch]);const pi=mockPi({'rolling-context-warm-interval':'1','rolling-context-batch-saving':'1'});rollingContext(pi);const notices=[];const ctx={cwd,sessionManager:manager,getContextUsage:()=>({tokens:20000,contextWindow:128000}),ui:{notify:text=>notices.push(text)}};
 await pi.commands.get('rolling-context').handler('on',ctx);const event={outcome:'completed',messageEntryId:manager.getBranch().at(-1).id,message:manager.getBranch().at(-1).message,entries:[],context:{contextEntries:manager.buildSessionProjection().entries}};const result=await pi.events.get('turn_end')[0](event,ctx);
 assert.ok(result?.entries?.some(entry=>entry.type==='context_edit'));assert.equal(manager.getBranch().length,branch.length);
 for(const draft of result.entries){if(draft.type==='custom')manager.appendCustomEntry(draft.customType,draft.data);else if(draft.type==='context_edit')manager.appendContextEdit(draft.targetId,draft.replacement);else if(draft.type==='compaction')manager.appendCompaction(draft.summary,draft.firstKeptEntryId,0,draft.details,true,draft.usage);}
 const projection=manager.buildSessionProjection().entries;const calls=projection.flatMap(entry=>entry.messages).filter(message=>message.role==='assistant').flatMap(message=>message.content.filter(part=>part.type==='toolCall'));const results=projection.flatMap(entry=>entry.messages).filter(message=>message.role==='toolResult');
 assert.equal(calls.length,results.length);assert.equal(rebuild(manager.getBranch(),manager.getSessionId()).envelope.edits.length,result.entries.filter(entry=>entry.type==='context_edit').length);
});

test('tree navigation restores mode and task notes from the selected branch only',async()=>{
 const cwd='/tmp/rolling-context-tree-restore-test';const header={type:'session',version:3,id:'tree-restore-session',timestamp:new Date().toISOString(),cwd};
 const branch=[{type:'message',id:'u',parentId:null,timestamp:'',message:{role:'user',content:'Inspect component',timestamp:0}},{type:'message',id:'note',parentId:'u',timestamp:'',message:{role:'toolResult',toolCallId:'step-1',toolName:'context_note',content:[{type:'text',text:'Recorded'}],details:{type:'rolling-context.note.v1',noteId:'step-1',taskId:'RC-T-u',kind:'next-step',text:'Update the adapter',paths:[]},isError:false,timestamp:0}},{type:'message',id:'a',parentId:'note',timestamp:'',message:{role:'assistant',content:[{type:'text',text:'Next step recorded.'}],stopReason:'stop',timestamp:0}}];
 const manager=SessionManager.inMemory(cwd,{id:header.id},[header,...branch]);manager.appendCustomEntry('rolling-context.config.v1',{mode:'on'});const pi=mockPi();rollingContext(pi);const notices=[];const ctx={cwd,sessionManager:manager,ui:{notify:text=>notices.push(text)}};
 await pi.events.get('session_start')[0]({type:'session_start'},ctx);await pi.commands.get('rolling-context').handler('status',ctx);assert.match(notices.at(-1),/mode=on/);assert.match(notices.at(-1),/next=1/);
 manager.branch('u');await pi.events.get('session_tree')[0]({type:'session_tree'},ctx);await pi.commands.get('rolling-context').handler('status',ctx);assert.match(notices.at(-1),/mode=observe/);assert.match(notices.at(-1),/next=0/);
});

test('compact hook uses a covered state checkpoint only when safe and preserves host instructions',async()=>{
 const cwd='/tmp/rolling-context-compact-hook-test';const header={type:'session',version:3,id:'compact-hook-session',timestamp:new Date().toISOString(),cwd};
 const branch=[
  {type:'message',id:'u',parentId:null,timestamp:'',message:{role:'user',content:'Inspect the module and preserve its API',timestamp:0}},
  {type:'message',id:'call',parentId:'u',timestamp:'',message:{role:'assistant',content:[{type:'toolCall',id:'read-1',name:'read',arguments:{path:'src/module.ts'}}],stopReason:'toolUse',timestamp:0}},
  {type:'message',id:'result',parentId:'call',timestamp:'',message:{role:'toolResult',toolCallId:'read-1',toolName:'read',content:[{type:'text',text:'module source '.repeat(400)}],isError:false,timestamp:0}},
  {type:'message',id:'done',parentId:'result',timestamp:'',message:{role:'assistant',content:[{type:'text',text:'Inspection complete'}],stopReason:'stop',timestamp:0}},
 ];
 const manager=SessionManager.inMemory(cwd,{id:header.id},[header,...branch]);
 const snapshot={schemaVersion:1,revision:1,coveredThroughEntryId:'result',items:[
  {id:'user-request',key:'user-request',kind:'constraint',text:'Inspect the module and preserve its API',status:'active',authority:'user',sourceEntryIds:['u'],taskId:'RC-T-u',dependencies:[],observedAtEntryId:'u',pinned:false},
  {id:'source-evidence',key:'file:src/module.ts',kind:'project',text:'module source available',status:'active',authority:'tool-evidence',sourceEntryIds:['call','result'],taskId:'RC-T-u',dependencies:[{path:'src/module.ts'}],observedAtEntryId:'result',pinned:false},
 ],intentRefs:[],focus:{taskId:'RC-T-u',nextSteps:[],openQuestions:[]},coverage:[]};
 manager.appendCustomEntry('rolling-context.state.v1',{schemaVersion:1,revision:1,planId:'covered',baseLeafId:manager.getLeafId(),snapshot,edits:[{targetId:'result',originalHash:hash(branch[2].message.content[0].text),replacementHash:hash('Historical module source; recall result'),warmTurn:0}]});
 manager.appendContextEdit('result',{content:[{type:'text',text:'Historical module source; recall result'}]});
 const pi=mockPi({'rolling-context-mode':'on','rolling-context-checkpoint-interval':'0'});rollingContext(pi);const notices=[];const ctx={cwd,sessionManager:manager,getContextUsage:()=>undefined,ui:{notify:(text)=>notices.push(text)}};
 const handler=pi.events.get('session_before_compact')[0];const event={reason:'threshold',willRetry:false,branchEntries:manager.getBranch(),preparation:{firstKeptEntryId:'done',tokensBefore:100000},signal:new AbortController().signal};
 const result=await handler(event,ctx);assert.ok(result?.compaction);assert.equal(result.compaction.firstKeptEntryId,'done');
 manager.appendCompaction(result.compaction.summary,result.compaction.firstKeptEntryId,result.compaction.tokensBefore,result.compaction.details,true);assert.equal(rebuild(manager.getBranch(),manager.getSessionId()).envelope.checkpoint.firstKeptEntryId,'done');
 await pi.events.get('session_compact')[0]({reason:'threshold',willRetry:false,fromExtension:true,compactionEntry:manager.getBranch().at(-1)},ctx);
 assert.equal(await handler({...event,customInstructions:'retain the exact wording'},ctx),undefined);
 const external=SessionManager.inMemory(cwd,{id:'external-edit'},[header,...branch]);external.appendContextEdit('result',null);external.appendCustomEntry('rolling-context.state.v1',{schemaVersion:1,revision:1,planId:'covered',baseLeafId:external.getLeafId(),snapshot,edits:[]});
 const unsafe=await handler({...event,branchEntries:external.getBranch()}, {...ctx,sessionManager:external});assert.equal(unsafe,undefined);
});

test('pin and unpin persist branch-local memory changes',async()=>{
 const cwd='/tmp/rolling-context-pin-test';const header={type:'session',version:3,id:'pin-session',timestamp:new Date().toISOString(),cwd};
 const branch=[{type:'message',id:'u',parentId:null,timestamp:'',message:{role:'user',content:'Inspect a module',timestamp:0}},{type:'message',id:'note-entry',parentId:'u',timestamp:'',message:{role:'toolResult',toolCallId:'note-1',toolName:'context_note',content:[{type:'text',text:'Recorded'}],isError:false,timestamp:0,details:{type:'rolling-context.note.v1',noteId:'note-1',taskId:'RC-T-u',kind:'task-decision',text:'Use this task-specific adapter',paths:[]}}}];
 const manager=SessionManager.inMemory(cwd,{id:header.id},[header,...branch]);const pi=mockPi();rollingContext(pi);const notices=[];const ctx={sessionManager:manager,ui:{notify:text=>notices.push(text)}};
 await pi.commands.get('rolling-context').handler('pin note-1',ctx);await pi.commands.get('rolling-context').handler('unpin note-1',ctx);
 assert.equal(pi.appended.length,2);assert.equal(pi.appended[0].customType,'rolling-context.state.v1');assert.equal(pi.appended[0].data.snapshot.items.find(item=>item.id==='note-1').pinned,true);assert.equal(pi.appended[1].data.snapshot.items.find(item=>item.id==='note-1').pinned,false);assert.ok(notices.some(text=>/pinned note-1/.test(text)));
});

test('design_intent_get returns the complete record and current source identity',async()=>{
 const cwd='/tmp/design-intent-get-test';await mkdir(`${cwd}/.pi`,{recursive:true});const store=emptyStore();store.revision=2;store.records=[{id:'DI-0001',kind:'invariant',title:'Public API',statement:'Keep the API stable',rationale:'Clients depend on it.',scope:{paths:['src/api.ts'],tags:['compatibility']},status:'accepted',supersedes:[],conflictsWith:[],dependsOn:[],sources:[{kind:'user',ref:'request-1'}],review:{note:'Explicitly approved',recordedAt:'2026-04-15T00:00:00.000Z'},createdInRevision:2}];await writeFile(`${cwd}/.pi/design-intent.json`,serializeStore(store));
 const manager=SessionManager.inMemory(cwd,{id:'design-intent-get-session'},[]);const pi=mockPi();designIntent(pi);pi.flags.get('design-intent-read').default=true;const ctx={cwd,sessionManager:manager,isProjectTrusted:()=>true,hasUI:false};
 const result=await pi.tools.get('design_intent_get').execute('get-1',{intent:'Inspect full record',id:'DI-0001'},undefined,undefined,ctx);const record=result.details.projection.items[0];
 assert.equal(record.scope.paths[0],'src/api.ts');assert.deepEqual(record.sources,[{kind:'user',ref:'request-1'}]);assert.equal(record.review.note,'Explicitly approved');assert.equal(record.createdInRevision,2);assert.equal(result.details.projection.sourceHash.length,64);
});

function proxyUI(answer) {
 const notices=[];
 const wait=fallback=>(_title,_other,opts)=>new Promise(resolve=>{
  if(opts?.signal?.aborted)return resolve(fallback);
  opts?.signal?.addEventListener('abort',()=>resolve(fallback),{once:true});
 });
 const ui={select:wait(undefined),confirm:wait(false),input:wait(undefined),editor:async()=>undefined,custom:async()=>undefined,notify:(message,type)=>notices.push({message,type}),setStatus:()=>{}};
 const broker=new UIBroker(frame=>{const request=frame.pending?.[0];if(request)queueMicrotask(()=>broker.respond(frame.uiEpoch,{id:request.id,...answer(request)}));});
 const restore=installUIProxy(ui,broker);
 return{ui,broker,notices,restore};
}

test('Design Intent read grants use the same ordinary confirm when proxied',async()=>{
 const cwd='/tmp/design-intent-remote-read-test';await mkdir(`${cwd}/.pi`,{recursive:true});await writeFile(`${cwd}/.pi/design-intent.json`,serializeStore(emptyStore()));
 const manager=SessionManager.inMemory(cwd,{id:'remote-read-session'},[]);const pi=mockPi();designIntent(pi);
 const proxy=proxyUI(request=>{assert.equal(request.method,'confirm');assert.match(request.message,/exact project intent file/);return{confirmed:true};});
 const ctx={cwd,sessionManager:manager,isProjectTrusted:()=>true,hasUI:true,ui:proxy.ui};
 const result=await pi.tools.get('design_intent_query').execute('query-1',{},undefined,undefined,ctx);
 assert.equal(result.details.projection.availability,'ready');assert.deepEqual(proxy.broker.snapshot().pending,[]);proxy.restore();
 const headless=mockPi();designIntent(headless);const denied=await headless.tools.get('design_intent_query').execute('query-2',{},undefined,undefined,{...ctx,hasUI:false});
 assert.equal(denied.details.projection.availability,'unavailable');
});

test('manual Rolling Context checkpoint confirms through ordinary UI, including the proxy',async()=>{
 const cwd='/tmp/rolling-context-remote-checkpoint-test';const header={type:'session',version:3,id:'remote-checkpoint-session',timestamp:new Date().toISOString(),cwd};const manager=SessionManager.inMemory(cwd,{id:header.id},[]);const pi=mockPi();rollingContext(pi);let compactOptions;
 const proxy=proxyUI(request=>{assert.equal(request.method,'confirm');assert.match(request.message,/当前任务/);return{confirmed:true};});
 const ctx={cwd,sessionManager:manager,hasUI:true,waitForIdle:async()=>{},hasPendingMessages:()=>false,ui:proxy.ui,compact:options=>{compactOptions=options;}};
 await pi.commands.get('rolling-context').handler('checkpoint',ctx);
 assert.ok(compactOptions);assert.match(compactOptions.customInstructions,/Do not add or infer project Design Intent/);proxy.restore();
 compactOptions=undefined;await pi.commands.get('rolling-context').handler('checkpoint',{...ctx,hasUI:false});assert.equal(compactOptions,undefined);
});

test('Design Intent has one local accept/reject execution path; proxy replies only to its confirm',async()=>{
 const cwd='/tmp/design-intent-web-approval-test';await mkdir(`${cwd}/.pi`,{recursive:true});await writeFile(`${cwd}/.pi/design-intent.json`,serializeStore(emptyStore()));
 const pi=mockPi();designIntent(pi);pi.flags.get('design-intent-read').default=true;
 const branch=[];const sessionManager={getSessionId:()=> 'approval-session',getLeafId:()=>branch.at(-1)?.id??'root',getBranch:()=>branch};
 const proxy=proxyUI(request=>{assert.equal(request.method,'confirm');assert.match(request.message,/candidate=/);return{confirmed:true};});
 const ctx={cwd,sessionManager,isProjectTrusted:()=>true,hasUI:true,waitForIdle:async()=>{},hasPendingMessages:()=>false,ui:proxy.ui};
 const result=await pi.tools.get('design_intent_propose').execute('propose-1',{intent:'Preserve the API',kind:'invariant',title:'Stable interface',statement:'Keep the public interface stable',rationale:'Existing clients depend on it.'},undefined,undefined,ctx);
 assert.equal(result.details.type,'design-intent.proposal.v1');assert.deepEqual(proxy.broker.snapshot().pending,[]);
 branch.push({type:'message',id:'proposal-result',message:{role:'toolResult',toolCallId:'propose-1',toolName:'design_intent_propose',details:result.details}});
 await pi.commands.get('design-intent').handler(`accept ${result.details.proposalId}`,ctx);
 const committed=JSON.parse(await readFile(`${cwd}/.pi/design-intent.json`,'utf8'));assert.equal(committed.records[0].status,'accepted');assert.equal(committed.records[0].review.note,'Approved by user through /design-intent accept');assert.equal(pi.appended.at(-1).customType,'design-intent.review.v1');
 const rejected=await pi.tools.get('design_intent_propose').execute('propose-2',{intent:'Consider replacing the interface',kind:'alternative',title:'Replacement interface',statement:'Replace the public interface',rationale:'A proposed alternative.',supersedes:['DI-0001']},undefined,undefined,ctx);
 branch.push({type:'message',id:'proposal-result-2',message:{role:'toolResult',toolCallId:'propose-2',toolName:'design_intent_propose',details:rejected.details}});
 await pi.commands.get('design-intent').handler(`reject ${rejected.details.proposalId} This would break clients.`,ctx);
 const afterReject=JSON.parse(await readFile(`${cwd}/.pi/design-intent.json`,'utf8'));assert.equal(afterReject.records[0].status,'accepted');assert.equal(afterReject.records[1].status,'rejected');assert.deepEqual(afterReject.records[1].supersedes,[]);
 const stale=await pi.tools.get('design_intent_propose').execute('propose-3',{intent:'Consider another rule',kind:'requirement',title:'New rule',statement:'Do something',rationale:'A candidate'},undefined,undefined,ctx);
 branch.push({type:'message',id:'proposal-result-3',message:{role:'toolResult',toolCallId:'propose-3',toolName:'design_intent_propose',details:stale.details}});
 proxy.restore();const changed=proxyUI(()=>{branch.push({type:'custom',id:'branch-changed'});return{confirmed:true};});
 await pi.commands.get('design-intent').handler(`accept ${stale.details.proposalId}`,{...ctx,ui:changed.ui});
 assert.equal((JSON.parse(await readFile(`${cwd}/.pi/design-intent.json`,'utf8'))).records.length,2);assert.match(changed.notices.at(-1).message,/branch changed/);changed.restore();
});

test('the sole DI approval path rechecks trust and reports receipt failure as committed',async()=>{
 const cwd='/tmp/design-intent-ui-boundary-test';await mkdir(`${cwd}/.pi`,{recursive:true});await writeFile(`${cwd}/.pi/design-intent.json`,serializeStore(emptyStore()));
 const pi=mockPi();designIntent(pi);pi.flags.get('design-intent-read').default=true;let trusted=true;const branch=[];
 const ctx={cwd,isProjectTrusted:()=>trusted,sessionManager:{getSessionId:()=> 'boundary-session',getLeafId:()=>branch.at(-1)?.id??'root',getBranch:()=>branch},hasUI:true,waitForIdle:async()=>{},hasPendingMessages:()=>false};
 const propose=async id=>{const result=await pi.tools.get('design_intent_propose').execute(id,{intent:'Preserve behavior',kind:'requirement',title:id,statement:'Keep the API safe',rationale:'Compatibility matters'},undefined,undefined,ctx);branch.push({type:'message',id,message:{role:'toolResult',toolCallId:id,toolName:'design_intent_propose',details:result.details}});return result.details.proposalId;};
 const first=await propose('untrusted');const revoked=proxyUI(()=>{trusted=false;return{confirmed:true};});
 await pi.commands.get('design-intent').handler(`accept ${first}`,{...ctx,ui:revoked.ui});
 assert.equal(JSON.parse(await readFile(`${cwd}/.pi/design-intent.json`,'utf8')).records.length,0);assert.match(revoked.notices.at(-1).message,/no longer trusted/);revoked.restore();
 trusted=true;const second=await propose('receipt-failure');const approved=proxyUI(()=>({confirmed:true}));pi.appendEntry=()=>{throw new Error('disk full');};
 await pi.commands.get('design-intent').handler(`accept ${second}`,{...ctx,ui:approved.ui});
 assert.equal(JSON.parse(await readFile(`${cwd}/.pi/design-intent.json`,'utf8')).records.length,1);assert.equal(approved.notices.at(-1).type,'warning');assert.match(approved.notices.at(-1).message,/Project file was committed/);approved.restore();
});

test('design_intent_check bounds paths and reports denied, truncated, and stale evidence as unknown',async()=>{
 const cwd='/tmp/design-intent-check-test';await mkdir(`${cwd}/.pi`,{recursive:true});const store=emptyStore();store.revision=1;store.records=[{id:'DI-0001',kind:'invariant',title:'API rule',statement:'Keep API stable',rationale:'Compatibility',scope:{paths:['src'],tags:[]},status:'accepted',supersedes:[],conflictsWith:[],dependsOn:[],sources:[{kind:'user',ref:'request'}],review:{note:'approved',recordedAt:'2026-04-15T00:00:00.000Z'},createdInRevision:1}];const storePath=`${cwd}/.pi/design-intent.json`;await writeFile(storePath,serializeStore(store));
 const manager=SessionManager.inMemory(cwd,{id:'design-intent-check-session'},[]);const pi=mockPi();designIntent(pi);pi.flags.get('design-intent-read').default=true;const tool=pi.tools.get('design_intent_check');let readResult={isError:false,result:{content:[{type:'text',text:'source contents'}],details:{}}};let reads=0;const ctx={cwd,sessionManager:manager,isProjectTrusted:()=>true,hasUI:false,executeTool:async(name,params)=>{assert.equal(name,'read');assert.equal(params.path,'src/api.ts');reads++;return readResult;}};
 await assert.rejects(()=>tool.execute('bad-path',{intent:'Check',paths:['../outside']},undefined,undefined,ctx),/CHECK_PATH_INVALID/);
 readResult={isError:true,result:{content:[{type:'text',text:'permission denied'}],details:{}}};const denied=await tool.execute('denied',{intent:'Check',paths:['src/api.ts']},undefined,undefined,ctx);assert.equal(denied.details.results[0].status,'unknown');assert.equal(denied.details.complete,false);
 readResult={isError:false,result:{content:[{type:'text',text:'partial source'}],details:{truncated:true}}};const truncated=await tool.execute('truncated',{intent:'Check',paths:['src/api.ts']},undefined,undefined,ctx);assert.equal(truncated.details.results[0].truncated,true);assert.equal(truncated.details.complete,false);
 readResult={isError:false,result:{content:[{type:'text',text:'source contents'}],details:{}}};ctx.executeTool=async()=>{reads++;const changed={...store,revision:2};await writeFile(storePath,serializeStore(changed));return readResult;};const stale=await tool.execute('stale',{intent:'Check',paths:['src/api.ts']},undefined,undefined,ctx);assert.equal(stale.details.stale,true);assert.match(stale.details.results[0].reason,/source changed/);assert.equal(stale.details.complete,false);assert.ok(reads>=3);
});

test('Rolling Context retains Design Intent as a read-only reference and never edits its store',async()=>{
 const cwd='/tmp/context-intent-boundary-test';await mkdir(`${cwd}/.pi`,{recursive:true});const store=emptyStore();store.revision=1;store.records=[{id:'DI-0001',kind:'invariant',title:'Stable interface',statement:'Keep the public interface stable',rationale:'Existing callers rely on it.',scope:{paths:['src'],tags:[]},status:'accepted',supersedes:[],conflictsWith:[],dependsOn:[],sources:[{kind:'user',ref:'initial request'}],review:{note:'Approved explicitly',recordedAt:'2026-04-15T00:00:00.000Z'},createdInRevision:1}];const storePath=`${cwd}/.pi/design-intent.json`;await writeFile(storePath,serializeStore(store));const before=await readFile(storePath,'utf8');
 const header={type:'session',version:3,id:'context-intent-boundary',timestamp:new Date().toISOString(),cwd};const branch=[];const push=entry=>{entry.parentId=branch.at(-1)?.id??null;branch.push(entry);};
 push({type:'message',id:'u',timestamp:'',message:{role:'user',content:'Update the adapter without changing public API',timestamp:0}});
 const projection={type:'design-intent.projection.v1',availability:'ready',storePath,storeRevision:1,sourceHash:sha(before),items:[{id:'DI-0001',kind:'invariant',status:'accepted',statement:'Keep the public interface stable',rationale:'Existing callers rely on it.',needsReview:false,mustExpand:false}],diagnostics:[],omittedIds:[],truncated:false};
 push({type:'message',id:'query-result',timestamp:'',message:{role:'toolResult',toolCallId:'query-1',toolName:'design_intent_query',content:[{type:'text',text:'read-only projection'}],details:{type:'design-intent.query-result.v1',projection},isError:false,timestamp:0}});
 push({type:'message',id:'note-result',timestamp:'',message:{role:'toolResult',toolCallId:'note-1',toolName:'context_note',content:[{type:'text',text:'Recorded'}],details:{type:'rolling-context.note.v1',noteId:'note-1',taskId:'RC-T-u',kind:'task-decision',text:'Use a local adapter for this task',paths:['src/adapter.ts'],replaces:[]},isError:false,timestamp:0}});
 push({type:'message',id:'a',timestamp:'',message:{role:'assistant',content:[{type:'text',text:'I will update the adapter.'}],stopReason:'stop',timestamp:0}});
 const manager=SessionManager.inMemory(cwd,{id:header.id},[header,...branch]);const pi=mockPi();rollingContext(pi);await pi.commands.get('rolling-context').handler('on',{sessionManager:manager,ui:{notify:()=>{}}});
 const ctx={cwd,sessionManager:manager,getContextUsage:()=>undefined,ui:{notify:()=>{}}};const projectionEntries=manager.buildSessionProjection().entries;
 const plan=await pi.events.get('turn_end')[0]({outcome:'completed',messageEntryId:'a',message:branch.at(-1).message,entries:[],context:{contextEntries:projectionEntries}},ctx);const envelope=plan?.entries?.find(entry=>entry.type==='custom'&&entry.customType==='rolling-context.state.v1')?.data;
 assert.ok(envelope);assert.deepEqual(envelope.snapshot.intentRefs.map(ref=>ref.id),['DI-0001']);assert.ok(envelope.snapshot.items.some(item=>item.kind==='task-decision'&&item.authority==='agent-report'));assert.equal(await readFile(storePath,'utf8'),before);
});

test('recall filters current projection, omits multimodal payloads, and rejects stale cursors',async()=>{
 const cwd='/tmp/rolling-context-recall-test';const header={type:'session',version:3,id:'recall-session',timestamp:new Date().toISOString(),cwd};
 const branch=[];const push=(entry)=>{entry.parentId=branch.at(-1)?.id??null;branch.push(entry);};
 push({type:'message',id:'u',timestamp:'',message:{role:'user',content:[{type:'text',text:'Inspect alpha and beta'},{type:'image',data:'base64secret',mimeType:'image/png'}],timestamp:0}});
 for(const [n,path,value] of [['a','src/a.ts','alpha evidence'],['b','src/b.ts','beta evidence']]){
  push({type:'message',id:`call-${n}`,timestamp:'',message:{role:'assistant',content:[{type:'toolCall',id:`read-${n}`,name:'read',arguments:{path}}],stopReason:'toolUse',timestamp:0}});
  push({type:'message',id:`result-${n}`,timestamp:'',message:{role:'toolResult',toolCallId:`read-${n}`,toolName:'read',content:[{type:'text',text:value}],isError:false,timestamp:0}});
  push({type:'message',id:`done-${n}`,timestamp:'',message:{role:'assistant',content:[{type:'thinking',thinking:'private reasoning'},{type:'text',text:`Finished ${n}`}],stopReason:'stop',timestamp:0}});
 }
 const manager=SessionManager.inMemory(cwd,{id:header.id},[header,...branch]);manager.appendCustomEntry('rolling-context.state.v1',{schemaVersion:1,revision:1,planId:'stale-source',baseLeafId:manager.getLeafId(),snapshot:{schemaVersion:1,revision:1,coveredThroughEntryId:'done-b',items:[{id:'stale-a',key:'file:src/a.ts',kind:'project',text:'Old file observation',status:'stale',authority:'tool-evidence',sourceEntryIds:['result-a'],taskId:'RC-T-u',dependencies:[{path:'src/a.ts'}],observedAtEntryId:'result-a',pinned:false}],intentRefs:[],focus:{taskId:'RC-T-u',nextSteps:[],openQuestions:[]},coverage:[]},edits:[]});const pi=mockPi();rollingContext(pi);const tool=pi.tools.get('context_recall');
 const ctx={cwd,sessionManager:manager};
 const alpha=await tool.execute('q1',{intent:'Find alpha evidence',query:'alpha'},undefined,undefined,ctx);assert.match(alpha.content[0].text,/alpha evidence/);assert.match(alpha.content[0].text,/stale/);assert.doesNotMatch(alpha.content[0].text,/beta evidence|base64secret|private reasoning/);
 const beta=await tool.execute('q2',{intent:'Find beta file',paths:['src/b.ts']},undefined,undefined,ctx);assert.match(beta.content[0].text,/beta evidence/);assert.doesNotMatch(beta.content[0].text,/alpha evidence/);
 const first=await tool.execute('q3',{intent:'Page branch history',limit:2},undefined,undefined,ctx);assert.ok(first.details.nextCursor);
 manager.appendContextEdit('result-a',{content:[{type:'text',text:'changed projection'}]});
 await assert.rejects(()=>tool.execute('q4',{intent:'Continue old page',limit:2,cursor:first.details.nextCursor},undefined,undefined,ctx),/STALE_RECALL_CURSOR/);
 manager.appendContextEdit('result-a',null);const denied=await tool.execute('q5',{intent:'Request hidden source',entryId:'result-a'},undefined,undefined,ctx);assert.equal(denied.details.denied,true);assert.doesNotMatch(denied.content[0].text,/alpha evidence/);
});

test('completed-turn telemetry is non-context, branch-local, usage-aware and idempotent; aborted turns do not advance',async()=>{
 const cwd='/tmp/rolling-telemetry-test',manager=SessionManager.inMemory(cwd,{id:'telemetry'},[]);manager.appendMessage({role:'user',content:'Inspect',timestamp:0});
 const usage={input:123,cacheRead:456,cacheWrite:78,output:10,totalTokens:667,cost:{input:0,cacheRead:0,cacheWrite:0,output:0,total:0}};
 manager.appendMessage({role:'assistant',content:[{type:'text',text:'Done'}],stopReason:'stop',usage,timestamp:0});
 const pi=mockPi({'rolling-context-mode':'off'});rollingContext(pi);const ctx={cwd,sessionManager:manager,getContextUsage:()=>undefined};const handler=pi.events.get('turn_end')[0];
 const event={outcome:'completed',messageEntryId:manager.getLeafId(),message:manager.getBranch().at(-1).message,entries:[{type:'custom',customType:'foreign.metadata',data:{keep:true}}],context:{contextEntries:manager.buildSessionProjection().entries}};
 assert.equal(await handler({...event,outcome:'aborted'},ctx),undefined);
 const result=await handler(event,ctx);assert.equal(result.entries[0],event.entries[0]);const record=result.entries.at(-1);assert.equal(record.customType,'rolling-context.telemetry.v1');assert.equal(record.data.turn,1);assert.equal(record.data.cacheRead,456);assert.equal(record.data.input,123);assert.equal(record.data.providerContextTokens,null);assert.equal(record.data.checkpointCreated,false);
 const before=manager.buildSessionProjection().messages;manager.appendCustomEntry(record.customType,record.data);assert.deepEqual(manager.buildSessionProjection().messages,before);assert.equal(await handler(event,ctx),undefined);
});

test('context_recall retrieves own cold original evidence but never undoes foreign redactions or compaction',async()=>{
 const cwd='/tmp/rolling-cold-tool',manager=SessionManager.inMemory(cwd,{id:'cold-recall'},[]);
 const userId=manager.appendMessage({role:'user',content:'Inspect',timestamp:0});
 const original='Cold original file evidence';const resultId=manager.appendMessage({role:'toolResult',toolCallId:'read',toolName:'read',content:[{type:'text',text:original}],isError:false,timestamp:0});
 const kept=manager.appendMessage({role:'assistant',content:[{type:'text',text:'Continue'}],stopReason:'stop',timestamp:0});
 const snapshot={schemaVersion:1,revision:1,coveredThroughEntryId:kept,items:[],intentRefs:[],focus:{taskId:`RC-T-${userId}`,nextSteps:[],openQuestions:[]},coverage:[]};
 const capsule='Historical source; recall for exact output';const envelope={schemaVersion:1,revision:1,planId:'warm',baseLeafId:kept,snapshot,edits:[{targetId:resultId,originalHash:hash(original),replacementHash:hash(capsule),warmTurn:1}]};
 manager.appendCustomEntry('rolling-context.state.v1',envelope);manager.appendContextEdit(resultId,{content:[{type:'text',text:capsule}]});
 const summary='Checkpoint',cp={...envelope,checkpoint:{firstKeptEntryId:kept,summaryHash:hash(summary)}};
 manager.appendCompaction(summary,kept,100,{type:'rolling-context.checkpoint.v1',turn:10,stateEnvelope:cp,firstKeptEntryId:kept,summaryHash:hash(summary)},true);
 const pi=mockPi();rollingContext(pi);const tool=pi.tools.get('context_recall'),ctx={cwd,sessionManager:manager};
 const recall=async()=>tool.execute('q',{intent:'Retrieve old evidence',entryId:resultId},undefined,undefined,ctx);
 assert.match((await recall()).content[0].text,/Cold original file evidence/);
 manager.appendContextEdit(resultId,{content:[{type:'text',text:'[redacted]'}]});const redacted=await recall();assert.match(redacted.content[0].text,/redacted/);assert.doesNotMatch(redacted.content[0].text,/Cold original/);
 manager.appendContextEdit(resultId,null);assert.equal((await recall()).details.denied,true);
 manager.appendCompaction('Foreign compaction',kept,100,{},false);assert.equal((await recall()).details.denied,true);
});
