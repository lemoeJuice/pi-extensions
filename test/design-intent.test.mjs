import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCandidate, emptyStore, findProject, loadStore, makeProposal, parseDraft, queryStore, relationDiagnostics, serializeStore, validateStore, commitCandidate } from '../extensions/design-intent/lib.ts';

const draft=(extra={})=>parseDraft({kind:'invariant',title:'Stable API',statement:'Keep public API stable',rationale:'Existing integrations depend on it.',...extra});

test('missing and malformed stores stay distinct',async()=>{
 const root=await mkdtemp(join(tmpdir(),'intent-'));try{
  const project=await findProject(root);assert.equal((await loadStore(project)).state,'missing');
  await mkdir(join(root,'.pi'));await writeFile(project.storePath,'{');
  const loaded=await loadStore(project);assert.equal(loaded.state,'unavailable');assert.equal(loaded.code,'INVALID_STORE');
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
  const rejectedProposal=makeProposal('s','call2',base,draft({supersedes:['DI-0001'],conflictsWith:['DI-0001'],dependsOn:['DI-0001']}));
  const rejected=buildCandidate(rejectedProposal,base,'reject','Not appropriate');
  assert.equal(rejected.record.supersedes.length,0);assert.equal(rejected.record.conflictsWith.length,0);assert.match(rejected.record.rationale,/not applied/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('query reports immutable source and candidate commit is atomic and idempotent by proposal source',async()=>{
 const root=await mkdtemp(join(tmpdir(),'intent-'));try{
  const project=await findProject(root);const base=await loadStore(project);const p=makeProposal('session','call1',base,draft());const candidate=buildCandidate(p,base,'accept','Approved');
  const committed=await commitCandidate(project,p,'accept','Approved',candidate.candidateHash,candidate.record.review.recordedAt);assert.equal(committed.store.revision,1);
  const retried=await commitCandidate(project,p,'accept','Approved',candidate.candidateHash,candidate.record.review.recordedAt);assert.equal(retried.store.revision,1);assert.equal(retried.record.id,committed.record.id);
  const loaded=await loadStore(project);assert.equal(loaded.state,'ready');assert.equal(loaded.store.records[0].id,'DI-0001');assert.ok(loaded.hash);
  const projection=queryStore(loaded,{paths:['src/api.ts']});assert.equal(projection.items[0].id,'DI-0001');assert.equal(projection.sourceHash,loaded.hash);assert.equal(relationDiagnostics(loaded.store).length,0);
  assert.equal((await readFile(project.storePath,'utf8')),serializeStore(committed.store));
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
