import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCandidate, deriveNeedsReview, emptyStore, findProject, loadStore, makeProposal, parseDraft, queryStore, relationDiagnostics, serializeStore, storeDiff, validateStore, commitCandidate } from '../extensions/design-intent/lib.ts';

const draft=(extra={})=>parseDraft({kind:'invariant',title:'Stable API',statement:'Keep public API stable',rationale:'Existing integrations depend on it.',...extra});

test('missing and malformed stores stay distinct',async()=>{
 const root=await mkdtemp(join(tmpdir(),'intent-'));try{
  const project=await findProject(root);assert.equal((await loadStore(project)).state,'missing');
  await mkdir(join(root,'.pi'));await writeFile(project.storePath,'{');
  const loaded=await loadStore(project);assert.equal(loaded.state,'unavailable');assert.equal(loaded.code,'INVALID_STORE');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('workspace cwd is authoritative: no parent discovery and symlink cwd resolves locally',async()=>{
 const root=await mkdtemp(join(tmpdir(),'intent-root-'));try{
  const child=join(root,'nested','workspace');await mkdir(join(root,'.pi'),{recursive:true});await mkdir(child,{recursive:true});await writeFile(join(root,'.pi','design-intent.json'),serializeStore(emptyStore()));
  const project=await findProject(child);assert.equal(project.root,child);assert.equal(project.storePath,join(child,'.pi','design-intent.json'));assert.equal((await loadStore(project)).state,'missing');
  const alias=join(root,'workspace-link');await symlink(child,alias);const linked=await findProject(alias);assert.equal(linked.root,child);assert.equal((await loadStore(linked)).state,'missing');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('validates dangling relations and dependency cycles',()=>{
 const store=emptyStore();store.revision=1;store.records=[
  {id:'DI-0001',kind:'decision',title:'A',statement:'A',rationale:'Why A',scope:{paths:[],tags:[]},status:'accepted',supersedes:[],conflictsWith:[],dependsOn:['DI-0002'],sources:[],review:{note:'ok',recordedAt:new Date().toISOString()},createdInRevision:1},
  {id:'DI-0002',kind:'decision',title:'B',statement:'B',rationale:'Why B',scope:{paths:[],tags:[]},status:'accepted',supersedes:[],conflictsWith:[],dependsOn:['DI-0001'],sources:[],review:{note:'ok',recordedAt:new Date().toISOString()},createdInRevision:1},
 ];assert.ok(validateStore(store).some(x=>x.code==='RELATION_CYCLE'));
});

test('accepted proposals deterministic, reject does not supersede',async()=>{
 const root=await mkdtemp(join(tmpdir(),'intent-'));try{
  const project=await findProject(root);const base=await loadStore(project);const proposal=makeProposal('s','call1',base,draft());
  const reviewAt=new Date().toISOString();const accepted=buildCandidate(proposal,base,'accept','Approved by operator',reviewAt);
  assert.equal(buildCandidate(proposal,base,'accept','Approved by operator',reviewAt).candidateHash,accepted.candidateHash);
  assert.equal(accepted.record.status,'accepted');
  const acceptedBase={state:'ready',store:accepted.store,hash:'accepted-base-hash',storePath:base.storePath,diagnostics:[]};
  const rejectedProposal=makeProposal('s','call2',acceptedBase,draft({supersedes:['DI-0001'],conflictsWith:['DI-0001'],dependsOn:['DI-0001']}));
  const rejected=buildCandidate(rejectedProposal,acceptedBase,'reject','Not appropriate');
  assert.equal(rejected.record.supersedes.length,0);assert.equal(rejected.record.conflictsWith.length,0);assert.deepEqual(rejected.store.records[0].status,'accepted');assert.match(rejected.record.rationale,/not applied/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('proposal creation rejects unknown or non-accepted relation targets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'intent-relations-'));try{
  const project=await findProject(root);const missing=await loadStore(project);assert.throws(()=>makeProposal('s','bad',missing,draft({dependsOn:['DI-9999']})),/unknown intent DI-9999/);
  const store=emptyStore();store.revision=1;store.records=[{id:'DI-0001',kind:'decision',title:'Old',statement:'Old decision',rationale:'Why',scope:{paths:[],tags:[]},status:'superseded',supersedes:[],conflictsWith:[],dependsOn:[],sources:[],review:{note:'replaced',recordedAt:'2026-04-15T00:00:00.000Z'},createdInRevision:1}];
  const loaded={state:'ready',store,hash:'source-hash',storePath:project.storePath,diagnostics:[]};assert.throws(()=>makeProposal('s','bad-status',loaded,draft({supersedes:['DI-0001']})),/not accepted/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('superseding a dependency surfaces all newly affected accepted intents',async()=>{
 const root=await mkdtemp(join(tmpdir(),'intent-impact-'));try{
  const project=await findProject(root);const store=emptyStore();store.revision=1;const rec=(id,dependsOn=[])=>({id,kind:'decision',title:id,statement:`Statement ${id}`,rationale:'Reason',scope:{paths:[],tags:[]},status:'accepted',supersedes:[],conflictsWith:[],dependsOn,sources:[],review:{note:'accepted',recordedAt:'2026-04-15T00:00:00.000Z'},createdInRevision:1});store.records=[rec('DI-0001'),rec('DI-0002',['DI-0001']),rec('DI-0003',['DI-0002'])];
  const loaded={state:'ready',store,hash:'impact-source',storePath:project.storePath,diagnostics:[]};const proposal=makeProposal('s','supersede',loaded,draft({supersedes:['DI-0001']}));const candidate=buildCandidate(proposal,loaded,'accept','Replace decision');const diff=storeDiff(loaded,candidate);
  assert.match(diff,/DI-0002: needs review/);assert.match(diff,/DI-0003: needs review/);assert.equal(deriveNeedsReview(candidate.store,'DI-0003'),true);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('shared dependency ancestors do not create false needs-review cycles',()=>{
 const store=emptyStore();store.revision=1;const rec=(id,dependsOn=[])=>({id,kind:'decision',title:id,statement:id,rationale:'Reason',scope:{paths:[],tags:[]},status:'accepted',supersedes:[],conflictsWith:[],dependsOn,sources:[],review:{note:'accepted',recordedAt:'2026-04-15T00:00:00.000Z'},createdInRevision:1});store.records=[rec('DI-0001',['DI-0002','DI-0003']),rec('DI-0002',['DI-0004']),rec('DI-0003',['DI-0004']),rec('DI-0004')];
 assert.equal(deriveNeedsReview(store,'DI-0001'),false);
});

test('query reports immutable source and candidate commit is atomic and idempotent by proposal source',async()=>{
 const root=await mkdtemp(join(tmpdir(),'intent-'));try{
  const project=await findProject(root);const base=await loadStore(project);const p=makeProposal('session','call1',base,draft());const candidate=buildCandidate(p,base,'accept','Approved');
  const committed=await commitCandidate(project,p,'accept','Approved',candidate.candidateHash,candidate.record.review.recordedAt);assert.equal(committed.store.revision,1);
  const retried=await commitCandidate(project,p,'accept','Approved',candidate.candidateHash,candidate.record.review.recordedAt);assert.equal(retried.store.revision,1);assert.equal(retried.record.id,committed.record.id);
  const loaded=await loadStore(project);assert.equal(loaded.state,'ready');assert.equal(loaded.store.records[0].id,'DI-0001');assert.ok(loaded.hash);
  assert.equal((await stat(project.storePath)).mode&0o777,0o600);assert.deepEqual((await readdir(join(root,'.pi'))).sort(),['design-intent.json']);
  const projection=queryStore(loaded,{paths:['src/api.ts']});assert.equal(projection.items[0].id,'DI-0001');assert.equal(projection.sourceHash,loaded.hash);assert.equal(relationDiagnostics(loaded.store).length,0);
  assert.equal((await readFile(project.storePath,'utf8')),serializeStore(committed.store));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('store file symlinks and pre-existing lock files are rejected without cleanup',async()=>{
 const root=await mkdtemp(join(tmpdir(),'intent-file-link-'));const outside=await mkdtemp(join(tmpdir(),'intent-file-out-'));try{
  const project=await findProject(root);await mkdir(join(root,'.pi'));await writeFile(join(outside,'store.json'),serializeStore(emptyStore()));await symlink(join(outside,'store.json'),project.storePath);
  const loaded=await loadStore(project);assert.equal(loaded.state,'unavailable');assert.equal(loaded.code,'UNSAFE_STORE_FILE');await rm(project.storePath);
  const base=await loadStore(project);const proposal=makeProposal('s','locked',base,draft());const candidate=buildCandidate(proposal,base,'accept','Approved');const lockPath=`${project.storePath}.lock`;await writeFile(lockPath,'foreign lock token');
  await assert.rejects(()=>commitCandidate(project,proposal,'accept','Approved',candidate.candidateHash),/LOCK_BUSY/);assert.equal(await readFile(lockPath,'utf8'),'foreign lock token');
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

test('concurrent commits from one baseline cannot both replace the store',async()=>{
 const root=await mkdtemp(join(tmpdir(),'intent-race-'));try{
  const project=await findProject(root);const base=await loadStore(project);const proposals=['one','two'].map(id=>makeProposal('session',id,base,draft({title:`Decision ${id}`,statement:`Statement ${id}`})));
  const outcomes=await Promise.allSettled(proposals.map(proposal=>{const reviewedAt='2026-04-15T00:00:00.000Z';const candidate=buildCandidate(proposal,base,'accept','Approved',reviewedAt);return commitCandidate(project,proposal,'accept','Approved',candidate.candidateHash,reviewedAt);}));
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1,JSON.stringify(outcomes.map(result=>result.status==='rejected'?String(result.reason):'fulfilled')));assert.equal(outcomes.filter(result=>result.status==='rejected').length,1);
  const current=await loadStore(project);assert.equal(current.state,'ready');assert.equal(current.store.revision,1);assert.equal(current.store.records.length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('store rejects symlinks rather than following project boundary',async()=>{
 const root=await mkdtemp(join(tmpdir(),'intent-'));const outside=await mkdtemp(join(tmpdir(),'intent-out-'));try{
  await writeFile(join(outside,'secret.json'),serializeStore(emptyStore()));await symlink(outside,join(root,'.pi'));
  const loaded=await loadStore(await findProject(root));assert.equal(loaded.state,'unavailable');assert.equal(loaded.code,'UNSAFE_STORE_DIRECTORY');
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

test('query projection respects its character budget or explicitly omits the item',async()=>{
 const root=await mkdtemp(join(tmpdir(),'intent-'));try{
  const project=await findProject(root);await mkdir(join(root,'.pi'));const store=emptyStore();store.revision=1;store.records=[{id:'DI-0001',kind:'invariant',title:'Long',statement:'x'.repeat(500),rationale:'y'.repeat(500),scope:{paths:[],tags:[]},status:'accepted',supersedes:[],conflictsWith:[],dependsOn:[],sources:[],review:{note:'ok',recordedAt:new Date().toISOString()},createdInRevision:1}];await writeFile(project.storePath,serializeStore(store));
  const loaded=await loadStore(project);assert.equal(loaded.state,'ready');const projection=queryStore(loaded,{maxChars:180});assert.ok(JSON.stringify(projection.items).length<=180||projection.items.length===0);assert.equal(projection.truncated,true);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('query binds opaque cursors to source and filters while including relation endpoints',async()=>{
 const root=await mkdtemp(join(tmpdir(),'intent-cursor-'));try{
  const project=await findProject(root);await mkdir(join(root,'.pi'));const store=emptyStore();store.revision=1;
  const record=(id,dependsOn=[],conflictsWith=[])=>({id,kind:'decision',title:`Decision ${id}`,statement:`Statement ${id}`,rationale:'Reviewed rationale',scope:{paths:[],tags:[]},status:'accepted',supersedes:[],conflictsWith,dependsOn,sources:[{kind:'user',ref:`request-${id}`}],review:{note:'accepted',recordedAt:'2026-04-15T00:00:00.000Z'},createdInRevision:1});
  store.records=[record('DI-0001',['DI-0002']),record('DI-0002'),record('DI-0003')];await writeFile(project.storePath,serializeStore(store));const loaded=await loadStore(project);assert.equal(loaded.state,'ready');
  const first=queryStore(loaded,{limit:1,maxChars:5000});assert.ok(first.items.some(item=>item.id==='DI-0002'&&item.relatedTo?.includes('DI-0001')));assert.ok(first.nextCursor);
  const second=queryStore(loaded,{limit:1,maxChars:5000,cursor:first.nextCursor});assert.equal(second.items[0].id,'DI-0002');
  const changedFilter=queryStore(loaded,{limit:1,maxChars:5000,text:'different',cursor:first.nextCursor});assert.equal(changedFilter.items.length,0);assert.equal(changedFilter.diagnostics[0].code,'STALE_QUERY_CURSOR');
  const changedSource=queryStore({...loaded,hash:'f'.repeat(64)},{limit:1,maxChars:5000,cursor:first.nextCursor});assert.equal(changedSource.diagnostics[0].code,'STALE_QUERY_CURSOR');
 }finally{await rm(root,{recursive:true,force:true});}
});
