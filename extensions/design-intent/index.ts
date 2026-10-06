import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { markContract, DESIGN_INTENT_PROJECTION_CONTRACT, DESIGN_INTENT_READ_CONTRACT } from "../shared/contracts.ts";
import { findProject, loadStore, queryStore, deriveNeedsReview, makeProposal, parseDraft, rebuildProposals, buildCandidate, storeDiff, commitCandidate, serializeStore, sha, type IntentProjection, type IntentDraft, type ProjectIdentity, type LoadResult, type Proposal } from "./lib.ts";

const QueryParams=markContract(Type.Object({intent:Type.String({minLength:1}),text:Type.Optional(Type.String({maxLength:300})),paths:Type.Optional(Type.Array(Type.String({maxLength:256}),{maxItems:16})),tags:Type.Optional(Type.Array(Type.String({maxLength:80}),{maxItems:16})),cursor:Type.Optional(Type.String({maxLength:2048})),limit:Type.Optional(Type.Number({minimum:1,maximum:50}))},{additionalProperties:false}),DESIGN_INTENT_READ_CONTRACT);
const GetParams=markContract(Type.Object({intent:Type.String({minLength:1}),id:Type.String({pattern:"^DI-[0-9]{4,}$"})},{additionalProperties:false}),DESIGN_INTENT_READ_CONTRACT);
const DraftParams=Type.Object({intent:Type.String({minLength:1}),kind:Type.Union([Type.Literal("requirement"),Type.Literal("invariant"),Type.Literal("decision"),Type.Literal("alternative")]),title:Type.String({minLength:1,maxLength:200}),statement:Type.String({minLength:1,maxLength:8000}),rationale:Type.String({minLength:1,maxLength:8000}),scope:Type.Optional(Type.Object({paths:Type.Array(Type.String({maxLength:512}),{maxItems:32}),tags:Type.Array(Type.String({maxLength:80}),{maxItems:32})},{additionalProperties:false})),supersedes:Type.Optional(Type.Array(Type.String({pattern:"^DI-[0-9]{4,}$"}),{maxItems:64})),conflictsWith:Type.Optional(Type.Array(Type.String({pattern:"^DI-[0-9]{4,}$"}),{maxItems:64})),dependsOn:Type.Optional(Type.Array(Type.String({pattern:"^DI-[0-9]{4,}$"}),{maxItems:64})),sources:Type.Optional(Type.Array(Type.Object({kind:Type.Union([Type.Literal("user"),Type.Literal("document")]),ref:Type.String({minLength:1,maxLength:512})},{additionalProperties:false}),{maxItems:16}))},{additionalProperties:false});
const CheckParams=Type.Object({intent:Type.String({minLength:1}),paths:Type.Array(Type.String({minLength:1,maxLength:256}),{minItems:1,maxItems:16}),intentIds:Type.Optional(Type.Array(Type.String({pattern:"^DI-[0-9]{4,}$"}),{maxItems:32}))},{additionalProperties:false});
const ProjectionItemSchema=Type.Object({id:Type.String(),kind:Type.Union([Type.Literal("requirement"),Type.Literal("invariant"),Type.Literal("decision"),Type.Literal("alternative")]),status:Type.Union([Type.Literal("accepted"),Type.Literal("rejected"),Type.Literal("superseded")]),statement:Type.String(),rationale:Type.String(),needsReview:Type.Boolean(),mustExpand:Type.Boolean(),title:Type.Optional(Type.String()),scope:Type.Optional(Type.Object({paths:Type.Array(Type.String()),tags:Type.Array(Type.String())})),supersedes:Type.Optional(Type.Array(Type.String())),conflictsWith:Type.Optional(Type.Array(Type.String())),dependsOn:Type.Optional(Type.Array(Type.String())),sources:Type.Optional(Type.Array(Type.Object({kind:Type.String(),ref:Type.String()}))),review:Type.Optional(Type.Object({note:Type.String(),recordedAt:Type.String()})),createdInRevision:Type.Optional(Type.Number()),relatedTo:Type.Optional(Type.Array(Type.String()))},{additionalProperties:true});
const ProjectionSchema=markContract(Type.Object({type:Type.Literal("design-intent.projection.v1"),availability:Type.Union([Type.Literal("ready"),Type.Literal("missing"),Type.Literal("unavailable")]),storePath:Type.String(),storeRevision:Type.Optional(Type.Number()),sourceHash:Type.Optional(Type.String()),items:Type.Array(ProjectionItemSchema),diagnostics:Type.Array(Type.Any()),omittedIds:Type.Array(Type.String()),truncated:Type.Boolean(),nextCursor:Type.Optional(Type.String())}),DESIGN_INTENT_PROJECTION_CONTRACT);
const ProposalSchema=Type.Object({type:Type.Literal("design-intent.proposal.v1"),proposalId:Type.String(),storePath:Type.String(),baseRevision:Type.Number(),baseHash:Type.String(),draft:Type.Any(),proposalHash:Type.String(),sessionId:Type.String(),createdAt:Type.String()});

async function projectFor(ctx:ExtensionContext, allowParent=false):Promise<ProjectIdentity>{
  const project=await findProject(ctx.cwd);
  if(!allowParent && project.root!==await import("node:fs/promises").then(m=>m.realpath(ctx.cwd)))throw new Error("DESIGN_INTENT_ROOT: start Pi at the project root; access outside the current workspace is disabled");
  return project;
}
function readGranted(pi:ExtensionAPI):boolean{return pi.getFlag("design-intent-read")===true;}
async function authorizeRead(ctx:ExtensionContext,project:ProjectIdentity,pi:ExtensionAPI,approvedSession?:string):Promise<boolean>{
  if(!ctx.isProjectTrusted())return false;
  if(readGranted(pi)||approvedSession===ctx.sessionManager.getSessionId())return true;
  if(!ctx.hasUI)return false;
  const sessionId=ctx.sessionManager.getSessionId();
  const allowed=await ctx.ui.confirm("Read project Design Intent",`Allow reading this exact project intent file for the current session?\n${project.storePath}`,{signal:ctx.signal});
  return allowed&&ctx.isProjectTrusted()&&ctx.sessionManager.getSessionId()===sessionId;
}
function projectionText(p:IntentProjection):string{
  if(p.availability!=="ready")return `[Design Intent ${p.availability}] ${p.diagnostics.map(d=>d.message).join("; ")}`;
  const items=p.items.map(i=>`- [${i.id}] ${i.kind}${i.needsReview?" (needs review)":""}${i.mustExpand?" (must expand)":""}: ${i.statement}${i.rationale?`\n  理由：${i.rationale}`:""}`).join("\n");
  return [`[Design Intent: read-only project source ${p.storePath}; revision ${p.storeRevision}; hash ${p.sourceHash?.slice(0,16)}]`,items||"No matching accepted intents.",p.truncated?`Truncated: query remaining IDs ${p.omittedIds.join(", ")}; this is not a complete constraint check.`:"",...p.diagnostics.map(d=>`[${d.code}] ${d.message}`)].filter(Boolean).join("\n");
}
function toolResult(p:IntentProjection){return{content:[{type:"text" as const,text:projectionText(p)}],details:{type:"design-intent.query-result.v1",projection:p},structuredContent:p};}
function diffProposal(p:Proposal,candidate:ReturnType<typeof buildCandidate>,loaded:LoadResult):string{return `${storeDiff(loaded,candidate)}\n\nproposal=${p.proposalId}\nbase=${p.baseHash}\ncandidate=${candidate.candidateHash}`;}

export default function designIntent(pi:ExtensionAPI){
  pi.registerFlag("design-intent-read",{type:"boolean",default:false,description:"Allow Design Intent to read .pi/design-intent.json inside the current project workspace"});
  pi.registerFlag("design-intent-inject",{type:"boolean",default:true,description:"Inject a limited project Design Intent projection at task start (requires read grant)"});
  pi.registerFlag("design-intent-budget",{type:"string",default:"1000",description:"Maximum characters in task-start Design Intent projection"});
  pi.registerFlag("design-intent-confirm",{type:"string",default:"",description:"Explicit non-interactive approval token: PROPOSAL:accept|reject:SOURCE_HASH:CANDIDATE_HASH"});
  let cached:{path:string;hash:string;loaded:LoadResult}|undefined;
  let readApprovedSession:string|undefined;
  const load=async(ctx:ExtensionContext,approved=false):Promise<{project:ProjectIdentity;loaded:LoadResult;authorized:boolean}>=>{
    const project=await projectFor(ctx);const authorized=ctx.isProjectTrusted()&&(approved||await authorizeRead(ctx,project,pi,readApprovedSession));
    if(!authorized)return{project,loaded:{state:"unavailable",code:"READ_NOT_AUTHORIZED",message:"Project intent file read is not authorized; enable --design-intent-read or explicitly allow it in the prompt.",storePath:project.storePath},authorized:false};
    if(!readGranted(pi))readApprovedSession=ctx.sessionManager.getSessionId();
    const loaded=await loadStore(project);if(loaded.state==="ready"&&cached?.path===loaded.storePath&&cached.hash===loaded.hash)return{project,loaded:cached.loaded,authorized:true};
    if(loaded.state==="ready")cached={path:loaded.storePath,hash:loaded.hash,loaded};else cached=undefined;
    return{project,loaded,authorized:true};
  };
  pi.registerTool({name:"design_intent_query",label:"Design Intent query",description:"Read approved project requirements, architectural invariants and design decisions relevant to this task. Results are versioned project facts; missing/unavailable is not the same as no requirements.",parameters:QueryParams,outputSchema:ProjectionSchema,annotations:{readOnlyHint:true,openWorldHint:false},async execute(_id,params,_signal,_update,ctx){const {loaded}=await load(ctx);const projection=queryStore(loaded,{text:params.text,paths:params.paths,tags:params.tags,cursor:params.cursor,limit:params.limit,maxChars:6000});return toolResult(projection);}});

  pi.registerTool({name:"design_intent_get",label:"Design Intent get",description:"Get the complete current project intent record, including scope, relationships, sources, review and revision. Always check the returned current source hash.",parameters:GetParams,outputSchema:ProjectionSchema,annotations:{readOnlyHint:true,openWorldHint:false},async execute(_id,params,_signal,_update,ctx){const {loaded}=await load(ctx);if(loaded.state!=="ready")return toolResult(queryStore(loaded,{}));const record=loaded.store.records.find(r=>r.id===params.id);if(!record){const p=queryStore(loaded,{});p.diagnostics.push({code:"INTENT_NOT_FOUND",message:`No record ${params.id}`});return toolResult(p);}const p:IntentProjection={type:"design-intent.projection.v1",availability:"ready",storePath:loaded.storePath,storeRevision:loaded.store.revision,sourceHash:loaded.hash,items:[{...record,needsReview:deriveNeedsReview(loaded.store,record.id),mustExpand:false}],diagnostics:[],omittedIds:[],truncated:false};return toolResult(p);}});

  pi.registerTool({name:"design_intent_propose",label:"Propose Design Intent",description:"Propose a long-term project requirement/invariant/decision with rationale. This only records a branch-local proposal; it does not approve or write project files. Task-local execution decisions belong in Rolling Context instead.",parameters:DraftParams,outputSchema:ProposalSchema,exposure:"model-only",executionMode:"sequential",async execute(toolCallId,params,_signal,_update,ctx){const {project,loaded}=await load(ctx);if(loaded.state==="unavailable")throw new Error(`${loaded.code}: ${loaded.message}`);const raw={...params,scope:params.scope??{paths:[],tags:[]},supersedes:params.supersedes??[],conflictsWith:params.conflictsWith??[],dependsOn:params.dependsOn??[],sources:params.sources??[]};const draft:IntentDraft=parseDraft(raw);const proposal=makeProposal(ctx.sessionManager.getSessionId(),toolCallId,loaded,draft);const msg=`Proposal ${proposal.proposalId} saved for review only. Source revision ${proposal.baseRevision}, hash ${proposal.baseHash}. Use /design-intent review ${proposal.proposalId}; no project file was changed.`;return{content:[{type:"text",text:msg}],details:proposal,structuredContent:proposal};}});

  pi.registerTool({name:"design_intent_check",label:"Check Design Intent",description:"Compare selected current project files against relevant approved Design Intent. Reports only evidence-bounded violation/no-violation-found/unknown; not an automatic architecture gate.",parameters:CheckParams,annotations:{readOnlyHint:true,openWorldHint:false},async execute(_id,params,_signal,_update,ctx){
    const {loaded,authorized}=await load(ctx);
    const normalize=(value:string)=>{const path=value.replace(/\\/g,"/").replace(/^(?:\.\/)+/,"");if(!path||path.startsWith("/")||/^[a-zA-Z]:/.test(path)||path.includes("\0")||path.split("/").includes(".."))return;return path;};
    const paths=params.paths.map(normalize);if(paths.some(path=>!path))throw new Error("CHECK_PATH_INVALID: paths must be project-relative and cannot traverse directories");
    const records=loaded.state==="ready"?loaded.store.records.filter(r=>r.status==="accepted"&&(!params.intentIds||params.intentIds.includes(r.id))):[];
    const missingIds=loaded.state==="ready"?(params.intentIds??[]).filter(id=>!records.some(record=>record.id===id)):[];
    const results:any[]=[];
    for(const path of params.paths){
      const normalized=normalize(path)!;
      if(!authorized||loaded.state!=="ready"){
        results.push({intentId:undefined,status:"unknown",reason:!authorized?"Project Design Intent read is not authorized; no file was inspected.":"Design Intent is missing or unavailable; no file was inspected.",path:normalized});continue;
      }
      for(const id of missingIds)results.push({intentId:id,status:"unknown",reason:"Requested intent ID is missing, rejected, or superseded in the current store.",path:normalized});
      const applicable=records.filter(record=>record.scope.paths.length===0||record.scope.paths.some(scope=>{const base=scope.replace(/\\/g,"/").replace(/^(?:\.\/)+/,"");return normalized===base||normalized.startsWith(`${base.replace(/\/$/,"")}/`);}));
      if(!applicable.length){results.push({intentId:undefined,status:"unknown",reason:"No selected accepted intent applies to this path; no conformance claim can be made.",path:normalized});continue;}
      try{
        const read=await ctx.executeTool("read",{path:normalized,intent:"Inspect file as evidence for the requested design-intent check"});
        const content=read.result.content.filter((p:any)=>p.type==="text").map((p:any)=>p.text).join("\n");
        const truncated=!!(read.result.details as any)?.truncated||!!(read.result.details as any)?.isTruncated||/truncated|more lines|more bytes/i.test(content);
        for(const item of applicable)results.push({intentId:item.id,status:"unknown",reason:read.isError?"File read was denied or failed; no conformance claim can be made.":truncated?"File evidence is truncated; no conformance claim can be made.":`File evidence was read (${content.length} characters), but this natural-language intent has no deterministic checker; manual review is required.`,path:normalized,...(!read.isError?{evidenceHash:sha(content)}:{}),truncated});
      }catch(error){for(const item of applicable)results.push({intentId:item.id,status:"unknown",reason:`File read was unavailable: ${error instanceof Error?error.message:String(error)}`,path:normalized});}
    }
    const refreshed=await load(ctx,authorized);
    const stale=loaded.state!==refreshed.loaded.state||loaded.state==="ready"&&(refreshed.loaded.state!=="ready"||loaded.hash!==refreshed.loaded.hash);
    if(stale)for(const result of results){result.status="unknown";result.reason="Intent source changed during evidence collection; discard this report and retry.";}
    const report={type:"design-intent.check.v1",storePath:loaded.storePath,storeRevision:loaded.state==="ready"?loaded.store.revision:undefined,sourceHash:loaded.state==="ready"?loaded.hash:undefined,paths:paths as string[],stale,complete:!stale&&authorized&&loaded.state==="ready"&&results.length>0&&results.every(result=>typeof result.evidenceHash==="string"&&!result.truncated),results};
    return{content:[{type:"text",text:JSON.stringify(report,null,2)}],details:report};
  }});

  pi.on("session_start",()=>{cached=undefined;readApprovedSession=undefined;});pi.on("session_tree",()=>{cached=undefined;});
  pi.on("before_agent_start",async(event,ctx)=>{
    if(pi.getFlag("design-intent-inject")===false)return;
    const project=await projectFor(ctx).catch(()=>undefined);if(!project)return;
    if(!ctx.isProjectTrusted()||(!readGranted(pi)&&readApprovedSession!==ctx.sessionManager.getSessionId()))return;
    const {loaded}=await load(ctx,readGranted(pi));const budgetRaw=Number(pi.getFlag("design-intent-budget")??1000);const maxChars=Number.isSafeInteger(budgetRaw)&&budgetRaw>=100&&budgetRaw<=10000?budgetRaw:1000;
    const projection=queryStore(loaded,{text:event.prompt,maxChars});
    let content=projectionText(projection);if(content.length>maxChars)content=`${content.slice(0,maxChars-100)}\n[Projection truncated; query by path/ID before design-sensitive edits.]`;
    return{message:{customType:"design-intent.projection.v1",content,display:false,details:projection}};
  });

  pi.registerCommand("design-intent",{description:"Inspect and review project Design Intent proposals",handler:async(args,ctx)=>{
    const [verb,...parts]=args.trim().split(/\s+/);const id=parts[0];
    if(verb==="status"||!verb){const {project,loaded}=await load(ctx);if(loaded.state!=="ready"){ctx.ui.notify(`${loaded.state}: ${loaded.state==="missing"?project.storePath:loaded.message}`,loaded.state==="missing"?"info":"error");return;}ctx.ui.notify(`Design Intent revision ${loaded.store.revision} · ${loaded.store.records.length} records · ${loaded.diagnostics.length} relation diagnostics\n${loaded.diagnostics.map(d=>d.message).join("\n")}`,loaded.diagnostics.length?"warning":"info");return;}
    if(verb==="show"){const {loaded}=await load(ctx);const record=loaded.state==="ready"?loaded.store.records.find(r=>r.id===id):undefined;ctx.ui.notify(record?JSON.stringify(record,null,2):`No current record ${id}`,record?"info":"warning");return;}
    if(verb!=="review"&&verb!=="accept"&&verb!=="reject"){ctx.ui.notify("Usage: /design-intent [status|show ID|review PROPOSAL|accept PROPOSAL|reject PROPOSAL reason]","warning");return;}
    if(!id){ctx.ui.notify("Proposal ID is required","error");return;}
    await ctx.waitForIdle();if(ctx.hasPendingMessages()){ctx.ui.notify("Review cancelled: pending messages exist.","warning");return;}
    const project=await projectFor(ctx);const sessionId=ctx.sessionManager.getSessionId();const leaf=ctx.sessionManager.getLeafId();const proposal=rebuildProposals(ctx.sessionManager.getBranch()).get(id);
    if(!proposal||proposal.storePath!==project.storePath||proposal.sessionId!==sessionId){ctx.ui.notify("Proposal not found on this session branch or project.","error");return;}
    const {loaded,authorized}=await load(ctx);if(!authorized){ctx.ui.notify("Cannot review: project file read not authorized.","error");return;}
    const action=verb==="reject"?"reject":"accept";const note=action==="reject"?parts.slice(1).join(" "):"Approved by user through /design-intent accept";
    if(action==="reject"&&!note){ctx.ui.notify("Usage: /design-intent reject PROPOSAL reason","warning");return;}
    const reviewedAt=new Date().toISOString();let candidate;try{candidate=buildCandidate(proposal,loaded,action,note,reviewedAt);}catch(error){ctx.ui.notify(error instanceof Error?error.message:String(error),"error");return;}
    const diff=diffProposal(proposal,candidate,loaded);
    if(verb==="review"){ctx.ui.notify(diff,"info");return;}
    if(ctx.hasUI){const yes=await ctx.ui.confirm(`Design Intent ${action}`,`${diff}\n\nSide effects: create .pi/ if missing; create a temporary file and exclusive lock beside the store; atomically replace ${project.storePath}. No source files are modified. Continue?`,{signal:ctx.signal});if(!yes)return;}
    else {
      const expected=`${id}:${action}:${loaded.state==="ready"?loaded.hash:"missing"}:${candidate.candidateHash}`;
      if(pi.getFlag("design-intent-confirm")!==expected){ctx.ui.notify(`No file changed. Non-interactive approval requires --design-intent-confirm '${expected}'. Review the exact candidate before passing it.`,"error");return;}
    }
    if(ctx.sessionManager.getSessionId()!==sessionId||ctx.sessionManager.getLeafId()!==leaf){ctx.ui.notify("Review cancelled: session branch changed.","error");return;}
    const stillThere=rebuildProposals(ctx.sessionManager.getBranch()).get(id);if(!stillThere||stillThere.proposalHash!==proposal.proposalHash){ctx.ui.notify("Review cancelled: proposal changed.","error");return;}
    try{
      const committed=await withFileMutationQueue(ctx.cwd,()=>{
        if(!ctx.isProjectTrusted())throw new Error("Review cancelled: project is no longer trusted.");
        if(ctx.hasPendingMessages()||ctx.sessionManager.getSessionId()!==sessionId||ctx.sessionManager.getLeafId()!==leaf)throw new Error("Review cancelled: session branch or pending messages changed.");
        if(rebuildProposals(ctx.sessionManager.getBranch()).get(id)?.proposalHash!==proposal.proposalHash)throw new Error("Review cancelled: proposal changed.");
        return commitCandidate(project,proposal,action,note,candidate.candidateHash,reviewedAt);
      });
      cached=undefined;
      const receipt={proposalId:id,proposalHash:proposal.proposalHash,action,recordId:committed.record.id,revision:committed.store.revision,sourceHash:sha(serializeStore(committed.store))};
      const message=`${action} committed: ${committed.record.id} · revision ${committed.store.revision}`;
      try{pi.appendEntry("design-intent.review.v1",receipt);}
      catch(error){ctx.ui.notify(`${message}. Project file was committed, but the session receipt could not be recorded: ${error instanceof Error?error.message:String(error)}. Do not repeat the approval.`,"warning");return;}
      ctx.ui.notify(message,"info");
    }catch(error){const message=error instanceof Error?error.message:String(error);ctx.ui.notify(message.startsWith("COMMIT_UNCERTAIN:")?`${message}\nInspect the project intent store before retrying.`:message,"error");}
  }});
}
