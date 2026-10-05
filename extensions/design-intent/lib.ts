import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export type IntentKind="requirement"|"invariant"|"decision"|"alternative";
export type IntentStatus="accepted"|"rejected"|"superseded";
export interface IntentRecord {
  id:string;kind:IntentKind;title:string;statement:string;rationale:string;
  scope:{paths:string[];tags:string[]};status:IntentStatus;
  supersedes:string[];conflictsWith:string[];dependsOn:string[];
  sources:Array<{kind:"user"|"document"|"proposal";ref:string}>;
  review:{note:string;recordedAt:string};createdInRevision:number;
}
export interface IntentStore {schemaVersion:1;revision:number;records:IntentRecord[]}
export interface ProjectIdentity {root:string;storePath:string}
export interface Diagnostic {code:string;message:string;ids?:string[]}
export type LoadResult={state:"ready";store:IntentStore;hash:string;storePath:string;diagnostics:Diagnostic[]}|{state:"missing";hash:"missing";storePath:string}|{state:"unavailable";code:string;message:string;storePath:string};
export interface IntentProjection {
  type:"design-intent.projection.v1";availability:"ready"|"missing"|"unavailable";storePath:string;
  storeRevision?:number;sourceHash?:string;
  items:Array<{id:string;kind:IntentKind;status:IntentStatus;statement:string;rationale:string;needsReview:boolean;mustExpand:boolean;scope?:IntentRecord["scope"];supersedes?:string[];conflictsWith?:string[];dependsOn?:string[];sources?:IntentRecord["sources"];review?:IntentRecord["review"];createdInRevision?:number;relatedTo?:string[]}>;
  diagnostics:Diagnostic[];omittedIds:string[];truncated:boolean;nextCursor?:string;
}
export interface IntentDraft {kind:IntentKind;title:string;statement:string;rationale:string;scope:{paths:string[];tags:string[]};supersedes:string[];conflictsWith:string[];dependsOn:string[];sources:Array<{kind:"user"|"document";ref:string}>}
export interface Proposal {type:"design-intent.proposal.v1";proposalId:string;storePath:string;baseRevision:number;baseHash:string;draft:IntentDraft;proposalHash:string;sessionId:string;createdAt:string}
export const sha=(input:string)=>createHash("sha256").update(input).digest("hex");
const STORE_LIMIT=1024*1024, RECORD_LIMIT=1000;
const str=(x:unknown,max:number)=>typeof x==="string"&&x.length>0&&x.length<=max;
const arr=(x:unknown,max:number)=>Array.isArray(x)&&x.length<=max&&x.every(v=>typeof v==="string"&&v.length<=512);
export function emptyStore():IntentStore{return{schemaVersion:1,revision:0,records:[]};}
export function validateStore(value:unknown):Diagnostic[]{
  const errors:Diagnostic[]=[];
  if(!value||typeof value!=="object")return[{code:"INVALID_STORE",message:"Store root must be an object"}];
  const s=value as IntentStore;
  if(s.schemaVersion!==1||!Number.isSafeInteger(s.revision)||s.revision<0||!Array.isArray(s.records)||s.records.length>RECORD_LIMIT)return[{code:"INVALID_STORE",message:"Unsupported schema, revision or record count"}];
  const ids=new Set<string>();
  for(const r of s.records){
    if(!r||typeof r!=="object"||!/^DI-\d{4,}$/.test(r.id)||ids.has(r.id)){errors.push({code:"INVALID_RECORD",message:"Invalid or duplicate record ID",ids:[r?.id??""]});continue;}ids.add(r.id);
    if(!["requirement","invariant","decision","alternative"].includes(r.kind)||!["accepted","rejected","superseded"].includes(r.status)||!str(r.title,200)||!str(r.statement,8000)||!str(r.rationale,8000))errors.push({code:"INVALID_RECORD",message:"Invalid kind/status/text",ids:[r.id]});
    if(!r.scope||!arr(r.scope.paths,32)||!arr(r.scope.tags,32)||r.scope.paths.some(p=>!p||p.startsWith("/")||p.split(/[\\/]/).includes("..")||p.includes("\0"))||r.scope.tags.some(t=>!t||t.length>80))errors.push({code:"INVALID_SCOPE",message:"Invalid project-relative scope",ids:[r.id]});
    const relations=[r.supersedes,r.conflictsWith,r.dependsOn];
    const validRelations=relations.every(list=>arr(list,64)&&new Set(list).size===list.length);
    const validSources=Array.isArray(r.sources)&&r.sources.length<=16&&r.sources.every(s=>s&&["user","document","proposal"].includes(s.kind)&&str(s.ref,512));
    if(!validRelations||!validSources||!r.review||!str(r.review.note,4000)||!str(r.review.recordedAt,80)||!Number.isSafeInteger(r.createdInRevision)||r.createdInRevision<0||r.createdInRevision>s.revision)errors.push({code:"INVALID_RECORD",message:"Invalid relationships, source, review or revision",ids:[r.id]});
  }
  const by=new Map(s.records.map(r=>[r.id,r]));
  for(const r of s.records){
    for(const [name,refs] of [["supersedes",r.supersedes],["conflictsWith",r.conflictsWith],["dependsOn",r.dependsOn]] as const){
      for(const id of refs??[])if(id===r.id||!by.has(id))errors.push({code:"INVALID_RELATION",message:`${name} is self-referential or dangling`,ids:[r.id,id]});
    }
  }
  for(const relation of ["dependsOn","supersedes"] as const){
    const visiting=new Set<string>(),done=new Set<string>();
    const visit=(id:string)=>{if(visiting.has(id)){errors.push({code:"RELATION_CYCLE",message:`${relation} graph has a cycle`,ids:[id]});return;}if(done.has(id))return;visiting.add(id);const record=by.get(id);for(const next of (record?.[relation]??[]))if(by.has(next))visit(next);visiting.delete(id);done.add(id);};
    for(const id of by.keys())visit(id);
  }
  for(const r of s.records)if(r.createdInRevision>s.revision)errors.push({code:"INVALID_REVISION",message:"Record revision exceeds store revision",ids:[r.id]});
  return errors;
}
export async function findProject(cwd:string):Promise<ProjectIdentity>{
  const start=await realpath(cwd);
  // Never walk above the granted workspace looking for a repository marker.
  return {root:start,storePath:resolve(start,".pi","design-intent.json")};
}
export async function loadStore(project:ProjectIdentity):Promise<LoadResult>{
  try{
    const root=await realpath(project.root);const rel=relative(root,project.storePath);
    if(rel.startsWith(`..${sep}`)||rel===".."||resolve(root,rel)!==project.storePath) return{state:"unavailable",code:"PATH_OUTSIDE_PROJECT",message:"Store resolves outside project",storePath:project.storePath};
    try{const parent=await lstat(dirname(project.storePath));if(parent.isSymbolicLink()||!parent.isDirectory())return{state:"unavailable",code:"UNSAFE_STORE_DIRECTORY",message:".pi must be an ordinary project-local directory",storePath:project.storePath};}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    try{const fileInfo=await lstat(project.storePath);if(fileInfo.isSymbolicLink()||!fileInfo.isFile())return{state:"unavailable",code:"UNSAFE_STORE_FILE",message:"Intent store must be an ordinary file, not a symlink",storePath:project.storePath};}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;throw error;}
    const file=await open(project.storePath,constants.O_RDONLY|constants.O_NOFOLLOW);
    let bytes:Buffer;
    try{
      const info=await file.stat();if(!info.isFile())return{state:"unavailable",code:"UNSAFE_STORE_FILE",message:"Intent store must be an ordinary file",storePath:project.storePath};
      if(info.size>STORE_LIMIT)return{state:"unavailable",code:"STORE_TOO_LARGE",message:`Store exceeds ${STORE_LIMIT} bytes`,storePath:project.storePath};
      const chunks:Buffer[]=[];let total=0;
      while(total<=STORE_LIMIT){const buffer=Buffer.alloc(Math.min(64*1024,STORE_LIMIT+1-total));const {bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;chunks.push(buffer.subarray(0,bytesRead));total+=bytesRead;}
      if(total>STORE_LIMIT)return{state:"unavailable",code:"STORE_TOO_LARGE",message:`Store exceeds ${STORE_LIMIT} bytes`,storePath:project.storePath};
      bytes=Buffer.concat(chunks,total);
    }finally{await file.close();}
    const raw=bytes.toString("utf8");
    let parsed:unknown;try{parsed=JSON.parse(raw);}catch{return{state:"unavailable",code:"INVALID_STORE",message:"Store is not valid JSON",storePath:project.storePath};}
    const diagnostics=validateStore(parsed);if(diagnostics.length)return{state:"unavailable",code:diagnostics[0].code,message:diagnostics.map(d=>d.message).join("; "),storePath:project.storePath};
    return{state:"ready",store:parsed as IntentStore,hash:sha(raw),storePath:project.storePath,diagnostics:relationDiagnostics(parsed as IntentStore)};
  }catch(error){
    if((error as NodeJS.ErrnoException).code==="ENOENT")return{state:"missing",hash:"missing",storePath:project.storePath};
    return{state:"unavailable",code:"STORE_READ_FAILED",message:error instanceof Error?error.message:String(error),storePath:project.storePath};
  }
}
export function relationDiagnostics(store:IntentStore):Diagnostic[]{
  const by=new Map(store.records.map(r=>[r.id,r]));const out:Diagnostic[]=[];
  const active=store.records.filter(r=>r.status==="accepted");
  for(const r of active){
    for(const other of active)if(r.id<other.id&&(r.conflictsWith.includes(other.id)||other.conflictsWith.includes(r.id)))out.push({code:"ACTIVE_CONFLICT",message:`Accepted intents ${r.id} and ${other.id} declare a conflict`,ids:[r.id,other.id]});
    for(const id of r.dependsOn){const target=by.get(id);if(!target||target.status!=="accepted")out.push({code:"DEPENDENCY_NEEDS_REVIEW",message:`${r.id} depends on non-accepted ${id}`,ids:[r.id,id]});}
  }
  return out;
}
export function deriveNeedsReview(store:IntentStore,id:string,seen=new Set<string>()):boolean{
  if(seen.has(id))return true;seen.add(id);const record=store.records.find(r=>r.id===id);if(!record||record.status!=="accepted")return true;
  const needs=record.dependsOn.some(dep=>deriveNeedsReview(store,dep,seen));seen.delete(id);return needs;
}
function normalizePath(root:string,path:string):string|undefined {
  const p=path.replace(/\\/g,"/").replace(/^\.\//,"");if(!p||p.startsWith("/")||p.split("/").includes("..")||p.includes("\0"))return;
  return resolve(root,p);
}
export function queryStore(loaded:LoadResult,args:{text?:string;paths?:string[];tags?:string[];cursor?:string;limit?:number;maxChars?:number}):IntentProjection{
  if(loaded.state!=="ready")return{type:"design-intent.projection.v1",availability:loaded.state,storePath:loaded.storePath,items:[],diagnostics:loaded.state==="unavailable"?[{code:loaded.code,message:loaded.message}]:[{code:"STORE_MISSING",message:"No project intent store has been created"}],omittedIds:[],truncated:false};
  const store=loaded.store;const paths=(args.paths??[]).map(p=>normalizePath(loaded.storePath.replace(/[/\\]\.pi[/\\]design-intent\.json$/,""),p)).filter((x):x is string=>!!x);const terms=(args.text??"").toLowerCase().split(/\s+/).filter(Boolean);const tags=(args.tags??[]).map(t=>t.toLowerCase());
  if((args.paths?.length??0)>0&&paths.length!==args.paths!.length)return{type:"design-intent.projection.v1",availability:"ready",storePath:loaded.storePath,storeRevision:store.revision,sourceHash:loaded.hash,items:[],diagnostics:[{code:"INVALID_QUERY_PATH",message:"Every query path must be a valid project-relative path"}],omittedIds:[],truncated:false};
  const active=store.records.filter(r=>r.status==="accepted");
  const scored=active.map(r=>{
    const scope=r.scope.paths.map(p=>normalizePath(loaded.storePath.replace(/[/\\]\.pi[/\\]design-intent\.json$/,""),p));
    const global=scope.length===0;
    const pathHit=paths.some(p=>global||scope.some(s=>s&&(p===s||p.startsWith(`${s}${sep}`))));
    const text=`${r.title} ${r.statement} ${r.rationale} ${r.scope.tags.join(" ")}`.toLowerCase();
    const keyword=terms.filter(t=>text.includes(t)).length;
    const tagHit=tags.some(t=>r.scope.tags.some(rt=>rt.toLowerCase()===t));
    if(paths.length&&!pathHit&&!keyword&&!tagHit)return undefined;
    if(!paths.length&&!terms.length&&!tags.length&&!global)return undefined;
    return{r,score:(global?1000:0)+(pathHit?500:0)+(tagHit?200:0)+keyword*10,needs:deriveNeedsReview(store,r.id)};
  }).filter((x):x is NonNullable<typeof x>=>!!x).sort((a,b)=>b.score-a.score||a.r.id.localeCompare(b.r.id));
  const limit=Math.min(100,args.limit??30),budget=args.maxChars??6000,itemBudget=Math.max(0,budget-2);
  const queryHash=sha(JSON.stringify({storePath:loaded.storePath,text:args.text?.toLowerCase(),paths:args.paths?.map(p=>p.replace(/\\/g,"/")).sort(),tags:args.tags?.map(t=>t.toLowerCase()).sort(),limit,budget}));
  let start=0;
  if(args.cursor){try{const cursor=JSON.parse(Buffer.from(args.cursor,"base64url").toString("utf8"));if(cursor.v!==1||cursor.sourceHash!==loaded.hash||cursor.queryHash!==queryHash||!Number.isSafeInteger(cursor.offset)||cursor.offset<0)throw new Error();start=cursor.offset;}catch{return{type:"design-intent.projection.v1",availability:"ready",storePath:loaded.storePath,storeRevision:store.revision,sourceHash:loaded.hash,items:[],diagnostics:[{code:"STALE_QUERY_CURSOR",message:"Query cursor is malformed or bound to a different query/store version; start a new query."}],omittedIds:[],truncated:true};}}
  const page=scored.slice(start,start+limit);const pageIds=new Set(page.map(item=>item.r.id));
  const relatedIds=new Set<string>();for(const {r} of page)for(const id of [...r.dependsOn,...r.conflictsWith])if(!pageIds.has(id))relatedIds.add(id);
  const byId=new Map(store.records.map(record=>[record.id,record]));
  const candidates=[...page.map(item=>({r:item.r,needs:item.needs,relatedTo:[] as string[]})),...Array.from(relatedIds).sort().flatMap(id=>{const r=byId.get(id);return r?[{r,needs:deriveNeedsReview(store,r.id),relatedTo:page.filter(item=>item.r.dependsOn.includes(id)||item.r.conflictsWith.includes(id)).map(item=>item.r.id)}]:[]})];
  const diagnostics=relationDiagnostics(store);let used=0;const selected=[];const omittedIds:string[]=[];
  for(const {r,needs,relatedTo} of candidates){
    const item={id:r.id,kind:r.kind,status:r.status,statement:r.statement,rationale:r.rationale,needsReview:needs,mustExpand:false,scope:r.scope,supersedes:r.supersedes,conflictsWith:r.conflictsWith,dependsOn:r.dependsOn,sources:r.sources,review:r.review,createdInRevision:r.createdInRevision,...(relatedTo.length?{relatedTo}:{})};
    const n=JSON.stringify(item).length;
    const separator=selected.length?1:0;
    if(used+n+separator>itemBudget){
      if(selected.length===0){
        let short={...item,statement:"",rationale:"",mustExpand:true};
        let remaining=Math.max(0,itemBudget-used-separator-JSON.stringify(short).length);
        short.statement=r.statement.slice(0,Math.ceil(remaining*0.65));remaining=Math.max(0,itemBudget-used-separator-JSON.stringify(short).length);
        short.rationale=r.rationale.slice(0,remaining);
        while(JSON.stringify(short).length+used+separator>itemBudget&&(short.rationale.length||short.statement.length)){if(short.rationale.length)short.rationale=short.rationale.slice(0,-1);else short.statement=short.statement.slice(0,-1);}
        if(JSON.stringify(short).length+used+separator<=itemBudget){selected.push(short);used+=JSON.stringify(short).length+separator;}
      }
      omittedIds.push(r.id);
    }else{selected.push(item);used+=n+separator;}
  }
  for(const entry of scored.slice(start+limit))omittedIds.push(entry.r.id);
  for(const id of relatedIds)if(!selected.some(item=>item.id===id)&&!omittedIds.includes(id)){omittedIds.push(id);diagnostics.push({code:"RELATION_ENDPOINT_OMITTED",message:`Relationship endpoint ${id} did not fit the query budget`,ids:[id]});}
  const nextOffset=start+page.length;const nextCursor=nextOffset<scored.length?Buffer.from(JSON.stringify({v:1,sourceHash:loaded.hash,queryHash,offset:nextOffset})).toString("base64url"):undefined;
  return{type:"design-intent.projection.v1",availability:"ready",storePath:loaded.storePath,storeRevision:store.revision,sourceHash:loaded.hash,items:selected,diagnostics,omittedIds,truncated:omittedIds.length>0||start>0,nextCursor};
}
export function parseDraft(raw:any):IntentDraft{
  const allowedKinds=["requirement","invariant","decision","alternative"];
  if(!allowedKinds.includes(raw?.kind)||!str(raw.title,200)||!str(raw.statement,8000)||!str(raw.rationale,8000))throw new Error("Draft needs kind, title, statement and rationale (with a non-empty rationale)");
  const scope=raw.scope??{paths:[],tags:[]};if(!Array.isArray(scope.paths)||!Array.isArray(scope.tags)||scope.paths.length>32||scope.tags.length>32)throw new Error("Invalid scope");
  const paths=scope.paths.map((p:unknown)=>{if(typeof p!=="string"||!p||p.startsWith("/")||p.split(/[\\/]/).includes("..")||p.includes("\0"))throw new Error("Scope paths must be project-relative and contain no '..'");return p.replace(/\\/g,"/");});
  const refs=(key:string)=>{const x=raw[key]??[];if(!Array.isArray(x)||x.length>64||x.some((v:unknown)=>typeof v!=="string"||v.length>512))throw new Error(`Invalid ${key}`);return [...new Set(x)] as string[];};
  const sources=raw.sources??[];if(!Array.isArray(sources)||sources.length>16||sources.some((x:any)=>!x||!["user","document"].includes(x.kind)||!str(x.ref,512)))throw new Error("Invalid sources");
  return{kind:raw.kind,title:raw.title,statement:raw.statement,rationale:raw.rationale,scope:{paths,tags:scope.tags.map((t:unknown)=>{if(typeof t!=="string"||!t||t.length>80)throw new Error("Invalid tag");return t;})},supersedes:refs("supersedes"),conflictsWith:refs("conflictsWith"),dependsOn:refs("dependsOn"),sources};
}
export function makeProposal(sessionId:string,toolCallId:string,loaded:LoadResult,draft:IntentDraft):Proposal{
  const baseline=loaded.state==="ready"?loaded.store:emptyStore();const by=new Map(baseline.records.map(record=>[record.id,record]));
  const nextId=`DI-${String(Math.max(0,...baseline.records.map(record=>Number(record.id.slice(3))||0))+1).padStart(4,"0")}`;
  for(const [name,refs] of [["supersedes",draft.supersedes],["dependsOn",draft.dependsOn],["conflictsWith",draft.conflictsWith]] as const){
    for(const id of refs){if(id===nextId)throw new Error(`${name} cannot refer to the proposed record ${id}`);const target=by.get(id);if(!target)throw new Error(`${name} refers to unknown intent ${id}`);if(target.status!=="accepted")throw new Error(`${name} target ${id} is not accepted`);}
  }
  const proposalId=`DIP-${sha(`${sessionId}:${toolCallId}`).slice(0,16)}`;const baseRevision=loaded.state==="ready"?loaded.store.revision:0;const baseHash=loaded.hash;const createdAt=new Date().toISOString();
  const body={type:"design-intent.proposal.v1" as const,proposalId,storePath:loaded.storePath,baseRevision,baseHash,draft,sessionId,createdAt};return{...body,proposalHash:sha(JSON.stringify(body))};
}
export function rebuildProposals(branch:any[]):Map<string,Proposal>{
  const out=new Map<string,Proposal>();for(const entry of branch){if(entry.type==="message"&&entry.message?.role==="toolResult"&&entry.message.toolName==="design_intent_propose"){const p=entry.message.details as Proposal;if(p?.type==="design-intent.proposal.v1"&&p.proposalHash===sha(JSON.stringify({type:p.type,proposalId:p.proposalId,storePath:p.storePath,baseRevision:p.baseRevision,baseHash:p.baseHash,draft:p.draft,sessionId:p.sessionId,createdAt:p.createdAt})))out.set(p.proposalId,p);}}
  return out;
}
export interface Candidate {store:IntentStore;record:IntentRecord;candidateHash:string;sourceHash:string}
export function buildCandidate(proposal:Proposal,loaded:LoadResult,action:"accept"|"reject",reviewNote:string,reviewedAt=new Date().toISOString()):Candidate{
  if(loaded.state==="unavailable")throw new Error(`${loaded.code}: ${loaded.message}`);
  const store=loaded.state==="ready"?structuredClone(loaded.store):emptyStore();
  const existingRef=`${proposal.proposalId}:${proposal.proposalHash}`;
  const previous=store.records.find(r=>r.sources.some(s=>s.kind==="proposal"&&s.ref===existingRef));
  if(previous){if((action==="accept"&&previous.status!=="accepted")||(action==="reject"&&previous.status!=="rejected"))throw new Error("PROPOSAL_ALREADY_REVIEWED: the same proposal was committed with a different action");return{store,record:previous,candidateHash:sha(serializeStore(store)),sourceHash:loaded.hash};}
  if(loaded.storePath!==proposal.storePath||loaded.hash!==proposal.baseHash||(loaded.state==="ready"?loaded.store.revision:0)!==proposal.baseRevision)throw new Error("STALE_PROPOSAL: the project intent file changed; create a new proposal and review it again");
  const draft=proposal.draft;
  const by=new Map(store.records.map(r=>[r.id,r]));const id=`DI-${String(Math.max(0,...store.records.map(r=>Number(r.id.slice(3))||0))+1).padStart(4,"0")}`;const revision=store.revision+1;
  if(action==="accept"){
    for(const targetId of [...draft.supersedes,...draft.dependsOn,...draft.conflictsWith])if(!by.has(targetId))throw new Error(`Unknown intent ID ${targetId}`);
    for(const targetId of draft.supersedes){const t=by.get(targetId)!;if(t.status!=="accepted")throw new Error(`Cannot supersede ${targetId}: it is not accepted`);}
    for(const targetId of draft.dependsOn){const t=by.get(targetId)!;if(t.status!=="accepted")throw new Error(`Dependency ${targetId} is not accepted`);}
    const record:IntentRecord={...draft,id,status:"accepted",review:{note:reviewNote,recordedAt:reviewedAt},createdInRevision:revision,sources:[...draft.sources,{kind:"proposal",ref:`${proposal.proposalId}:${proposal.proposalHash}`}]};
    for(const targetId of draft.supersedes)by.get(targetId)!.status="superseded";
    store.records.push(record);store.revision=revision;
    const errors=validateStore(store);if(errors.length)throw new Error(errors.map(e=>e.message).join("; "));
    const rel=relationDiagnostics(store);if(rel.some(d=>d.code==="ACTIVE_CONFLICT"))throw new Error("ACTIVE_CONFLICT: proposal leaves an unresolved conflict; clarify scope or supersede the conflicting accepted intent");
    for(const dep of record.dependsOn)if(deriveNeedsReview(store,dep))throw new Error(`DEPENDENCY_NEEDS_REVIEW: ${dep}`);
    return{store,record,candidateHash:sha(serializeStore(store)),sourceHash:loaded.hash};
  }
  const record:IntentRecord={...draft,id,status:"rejected",supersedes:[],review:{note:reviewNote,recordedAt:reviewedAt},createdInRevision:revision,sources:[...draft.sources,{kind:"proposal",ref:`${proposal.proposalId}:${proposal.proposalHash}`}]};
  record.rationale=`${record.rationale}\n\nRejected proposal relationships (not applied): supersedes=${draft.supersedes.join(",")||"none"}; conflictsWith=${draft.conflictsWith.join(",")||"none"}; dependsOn=${draft.dependsOn.join(",")||"none"}.`;
  record.conflictsWith=[];record.dependsOn=[];
  if(record.rationale.length>8000)record.rationale=record.rationale.slice(0,7990)+"…";
  store.records.push(record);store.revision=revision;const errors=validateStore(store);if(errors.length)throw new Error(errors.map(e=>e.message).join("; "));return{store,record,candidateHash:sha(serializeStore(store)),sourceHash:loaded.hash};
}
export function serializeStore(store:IntentStore):string{return `${JSON.stringify(store,null,2)}\n`;}
export function storeDiff(loaded:LoadResult,candidate:Candidate):string{
  const before=loaded.state==="ready"?loaded.store:emptyStore();
  const changed=candidate.store.records.filter(record=>{const old=before.records.find(r=>r.id===record.id);return !old||old.status!==record.status||old.review.note!==record.review.note;});
  const newlyNeedsReview=candidate.store.records.filter(record=>record.status==="accepted"&&deriveNeedsReview(candidate.store,record.id)&&(!before.records.some(old=>old.id===record.id&&old.status==="accepted")||!deriveNeedsReview(before,record.id)));
  return [`--- ${loaded.storePath}`,`revision ${before.revision} → ${candidate.store.revision}`,
    ...changed.map(record=>{const old=before.records.find(r=>r.id===record.id);return old?`~ ${old.id}: status ${old.status} → ${record.status}`:`+ ${JSON.stringify(record,null,2).split("\n").join("\n+ ")}`;}),
    ...newlyNeedsReview.map(record=>`! ${record.id}: needs review because dependency chain includes ${record.dependsOn.join(", ")||"an unaccepted dependency"}`),
    `candidate hash: ${candidate.candidateHash}`].join("\n");
}
export async function commitCandidate(project:ProjectIdentity,proposal:Proposal,action:"accept"|"reject",note:string,expectedCandidateHash:string,reviewedAt?:string):Promise<Candidate>{
  const root=await realpath(project.root);if(resolve(root,".pi")!==dirname(project.storePath))throw new Error("Unsafe intent store path");
  const dir=dirname(project.storePath);
  try{const existing=await lstat(dir);if(existing.isSymbolicLink()||!existing.isDirectory())throw new Error("UNSAFE_STORE_DIRECTORY: .pi must be an ordinary project-local directory");}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;try{await mkdir(dir,{mode:0o700});}catch(createError){if((createError as NodeJS.ErrnoException).code!=="EEXIST")throw createError;}}
  if(await realpath(dir)!==dir)throw new Error("UNSAFE_STORE_DIRECTORY: .pi resolves outside the project");
  const lockPath=`${project.storePath}.lock`;const token=randomUUID();let lock:any;
  try{lock=await open(lockPath,"wx",0o600);}catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")throw new Error("LOCK_BUSY: another Design Intent update holds the lock; inspect it before retrying");throw error;}
  const temp=`${project.storePath}.${process.pid}.${token}.tmp`;
  try{
    await lock.writeFile(JSON.stringify({token,pid:process.pid,createdAt:new Date().toISOString()}));await lock.sync();
    const latestProject={...project,root:await realpath(project.root)};const latest=await loadStore(latestProject);
    const receiptRef=`${proposal.proposalId}:${proposal.proposalHash}`;
    if(latest.state==="ready"){
      const committed=latest.store.records.find(r=>r.sources.some(s=>s.kind==="proposal"&&s.ref===receiptRef));
      if(committed){if((action==="accept"&&committed.status!=="accepted")||(action==="reject"&&committed.status!=="rejected"))throw new Error("PROPOSAL_ALREADY_REVIEWED: proposal was committed with another action");return{store:latest.store,record:committed,candidateHash:expectedCandidateHash,sourceHash:latest.hash};}
    }
    const candidate=buildCandidate(proposal,latest,action,note,reviewedAt);
    if(candidate.candidateHash!==expectedCandidateHash)throw new Error("STALE_REVIEW: candidate differs from the reviewed proposal; review again");
    // Reconfirm that the target and parent remain ordinary project-local files.
    const rel=relative(latestProject.root,project.storePath);if(rel.startsWith(`..${sep}`)||rel==="..")throw new Error("Store path escaped project root");
    const payload=serializeStore(candidate.store);const file=await open(temp,"wx",0o600);try{await file.writeFile(payload,"utf8");await file.sync();}finally{await file.close();}
    const check=await loadStore(latestProject);if(check.hash!==proposal.baseHash)throw new Error("STALE_PROPOSAL: store changed during review");
    await rename(temp,project.storePath);
    try{const dirHandle=await open(dir,"r");try{await dirHandle.sync();}finally{await dirHandle.close();}}catch{}
    const verified=await loadStore(latestProject);if(verified.state!=="ready"||verified.hash!==sha(payload))throw new Error("COMMIT_UNCERTAIN: file was renamed but post-commit verification failed");
    return candidate;
  }finally{
    await rm(temp,{force:true}).catch(()=>undefined);
    try{await lock.close();}catch{}
    try{const record=JSON.parse(await readFile(lockPath,"utf8"));if(record.token===token)await rm(lockPath,{force:true});}catch{}
  }
}
