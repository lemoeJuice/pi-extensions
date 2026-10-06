import type { ExtensionAPI, SessionBoundaryDraft, SessionEntry, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { checkOptionalToolContract, DESIGN_INTENT_READ_CONTRACT } from "../shared/contracts.ts";
import { analyzeGroups, boundMemory, effectiveTarget, estimateProjection, groups, hash, planTurn, previewDrafts, rebuild, renderCheckpoint, serializedStateBytes, MAX_STATE_BYTES, TELEMETRY_TYPE, contextComposition, ownedEdits, ownedCheckpoint, recallProjection, turnClock, type PlanMetrics, type RollingConfig } from "./lib.ts";

const NoteParams=Type.Object({intent:Type.String({minLength:1}),kind:Type.Union([Type.Literal("plan"),Type.Literal("task-decision"),Type.Literal("focus"),Type.Literal("next-step")]),text:Type.String({minLength:1,maxLength:2000}),replaces:Type.Optional(Type.Array(Type.String(),{maxItems:8})),paths:Type.Optional(Type.Array(Type.String({maxLength:256}),{maxItems:12}))},{additionalProperties:false});
const RecallParams=Type.Object({intent:Type.String({minLength:1}),entryId:Type.Optional(Type.String()),itemId:Type.Optional(Type.String()),query:Type.Optional(Type.String({maxLength:300})),paths:Type.Optional(Type.Array(Type.String({minLength:1,maxLength:256}),{maxItems:12})),cursor:Type.Optional(Type.String({maxLength:2048})),limit:Type.Optional(Type.Number({minimum:1,maximum:8}))},{additionalProperties:false});
const NoteDetails=Type.Object({type:Type.Literal("rolling-context.note.v1"),noteId:Type.String(),taskId:Type.String(),kind:Type.String(),text:Type.String(),replaces:Type.Array(Type.String()),paths:Type.Array(Type.String())});

let checkpointPromptQueue:Promise<void>=Promise.resolve();
function queueCheckpointPrompt<T>(prompt:()=>Promise<T>):Promise<T>{const current=checkpointPromptQueue.then(prompt,prompt);checkpointPromptQueue=current.then(()=>undefined,()=>undefined);return current;}
async function requestCheckpointApproval(pi:ExtensionAPI,ctx:any,summary:string,stateBytes:number):Promise<boolean>{
  let markAvailable!:(available:boolean)=>void,choose!:(choice:"Create checkpoint"|"Cancel")=>void,resolveRemote!:(result:{source:"remote";choice:"Create checkpoint"|"Cancel"}|{source:"unavailable"})=>void;
  let availabilitySettled=false;
  const available=new Promise<boolean>(resolve=>{markAvailable=resolve;});
  const remoteChoice=new Promise<"Create checkpoint"|"Cancel">(resolve=>{choose=resolve;});
  const remoteResult=new Promise<{source:"remote";choice:"Create checkpoint"|"Cancel"}|{source:"unavailable"}>(resolve=>{resolveRemote=resolve;});
  const requestId=randomUUID(),controller=new AbortController();
  const localChoice=ctx.hasUI?queueCheckpointPrompt(async()=>({source:"local" as const,choice:await ctx.ui.select(`Create a Rolling Context checkpoint?\n\n${summary.slice(0,3000)}`,["Create checkpoint","Cancel"],{signal:controller.signal}) as "Create checkpoint"|"Cancel"|undefined})):undefined;
  const resolveAvailability=(value:boolean)=>{if(availabilitySettled)return;availabilitySettled=true;markAvailable(value);};
  pi.events.emit("pi-remote:rolling-context-checkpoint-approval-request",{
    requestId,summary:summary.slice(0,3000),stateBytes,
    onDelivered:()=>resolveAvailability(true),
    onUnavailable:()=>{resolveAvailability(false);resolveRemote({source:"unavailable"});},
    respond:(choice:"Create checkpoint"|"Cancel")=>{choose(choice);resolveRemote({source:"remote",choice});return{ok:choice==="Create checkpoint",message:choice==="Create checkpoint"?"Rolling Context checkpoint approved":"Rolling Context checkpoint cancelled"};},
  });
  if(localChoice){
    const winner=await Promise.race([localChoice,remoteResult]);
    if(winner.source==="remote"){controller.abort();return winner.choice==="Create checkpoint";}
    if(winner.source==="unavailable"){const local=await localChoice;return local.choice==="Create checkpoint";}
    pi.events.emit("pi-remote:approval-dismiss",{requestId});
    return winner.choice==="Create checkpoint";
  }
  if(!await available)return false;
  return await remoteChoice==="Create checkpoint";
}

function parseConfig(pi:ExtensionAPI):RollingConfig {
  const mode=String(pi.getFlag("rolling-context-mode")??"observe");
  const number=(name:string,fallback:number,min=0,max=1_000_000)=>{
    const raw=pi.getFlag(name);if(raw===undefined)return fallback;
    const n=Number(raw);if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`Invalid --${name}: expected integer ${min}..${max}`);return n;
  };
  if(!["observe","on","off"].includes(mode))throw new Error("--rolling-context-mode must be observe, on, or off");
  return {mode:mode as RollingConfig["mode"],targetTokens:number("rolling-context-target",32768,2048),reserveTokens:number("rolling-context-reserve",16384),minSavingTokens:number("rolling-context-min-saving",256),minCheckpointTurns:number("rolling-context-checkpoint-interval",16),minWarmTurns:number("rolling-context-warm-interval",4,1),minBatchSavingTokens:number("rolling-context-batch-saving",2048,1),recallMaxTokens:number("rolling-context-recall-tokens",2000,100,10000)};
}

export default function rollingContext(pi:ExtensionAPI) {
  // getAllTools is a runtime action, unavailable while extension factories load.
  // Recheck at mutation boundaries too: Pi reports session_start errors but continues.
  const validateContracts=()=>{
    try{
      checkOptionalToolContract(pi,"rolling-context","design_intent_query",DESIGN_INTENT_READ_CONTRACT);
      checkOptionalToolContract(pi,"rolling-context","design_intent_get",DESIGN_INTENT_READ_CONTRACT);
    }catch(error){lastStatus=`Rolling Context disabled: ${error instanceof Error?error.message:String(error)}`;throw error;}
  };
  pi.registerFlag("rolling-context-mode",{type:"string",default:"observe",description:"Rolling Context mode: observe, on, or off"});
  pi.registerFlag("rolling-context-target",{type:"string",default:"32768",description:"Target context token estimate"});
  pi.registerFlag("rolling-context-reserve",{type:"string",default:"16384",description:"Conservative output reserve in tokens"});
  pi.registerFlag("rolling-context-min-saving",{type:"string",default:"256",description:"Minimum token saving per tool result"});
  pi.registerFlag("rolling-context-checkpoint-interval",{type:"string",default:"16",description:"Minimum completed turns since the last Rolling checkpoint; also minimum warm residence"});
  pi.registerFlag("rolling-context-warm-interval",{type:"string",default:"4",description:"Minimum completed turns between normal capsule batches"});
  pi.registerFlag("rolling-context-batch-saving",{type:"string",default:"2048",description:"Minimum cumulative estimated token saving per normal batch"});
  pi.registerFlag("rolling-context-recall-tokens",{type:"string",default:"2000",description:"Maximum recall response estimate"});
  const config=parseConfig(pi);
  let mode=config.mode;
  let lastStatus="mode=observe";
  let manualCheckpoint:{sessionId:string;leafId:string|null}|undefined;

  pi.registerTool({name:"context_note",label:"Context note",description:"Record current-task plans, task-local implementation decisions, focus or next step only. Cannot change project-level Design Intent.",parameters:NoteParams,outputSchema:NoteDetails,executionMode:"sequential",async execute(toolCallId,params,_signal,_update,ctx){
    const branch=ctx.sessionManager.getBranch();
    const firstUser=branch.find(e=>e.type==="message"&&e.message.role==="user");
    const taskId=`RC-T-${firstUser?.id??ctx.sessionManager.getSessionId()}`;
    const noteIds=new Set(branch.flatMap(entry=>entry.type==="message"&&entry.message.role==="toolResult"&&entry.message.toolName==="context_note"&&(entry.message.details as any)?.type==="rolling-context.note.v1"&&(entry.message.details as any)?.taskId===taskId?[(entry.message.details as any).noteId]:[]));
    const replaces=params.replaces??[];
    if(replaces.some(id=>!noteIds.has(id)))throw new Error("context_note can replace only an existing note from the current task");
    const paths=(params.paths??[]).map(p=>p.replace(/\\/g,"/"));
    if(paths.some(p=>p.startsWith("/")||p.includes("\0")||p.split("/").includes("..")))throw new Error("context_note paths must be project-relative and cannot traverse directories");
    const structured={type:"rolling-context.note.v1" as const,noteId:toolCallId,taskId,kind:params.kind,text:params.text.trim(),replaces,paths};
    return {content:[{type:"text",text:`Recorded ${params.kind} as ${toolCallId} for current task only. Use replaces=["${toolCallId}"] to supersede this note. It does not modify project Design Intent.`}],details:structured,structuredContent:structured};
  }});

  pi.registerTool({name:"context_recall",label:"Context recall",description:"Search or retrieve limited evidence from the active session branch. Historical content is not current filesystem truth.",parameters:RecallParams,annotations:{readOnlyHint:true,openWorldHint:false},async execute(_id,params,_signal,_update,ctx){
    const branch=ctx.sessionManager.getBranch();
    const projection=ctx.sessionManager.buildSessionProjection();
    const authorized=recallProjection(ctx.cwd,ctx.sessionManager.getHeader(),branch,projection.entries);
    const ownedSources=ownedEdits(branch);
    const projectedById=new Map(authorized.map(e=>[e.sourceEntry.id,e.messages]));
    const visibleIds=new Set(authorized.filter(e=>e.messages.length>0).map(e=>e.sourceEntry.id));
    const state=rebuild(branch,ctx.sessionManager.getSessionId());
    if(params.paths?.some(path=>path.startsWith("/")||path.includes("\0")||path.split(/[\\/]/).includes("..")))throw new Error("Recall paths must be project-relative and cannot traverse directories");
    const selectors=[params.entryId,params.itemId,params.query].filter(Boolean);if(selectors.length>1)throw new Error("Use only one of entryId, itemId or query; paths may be combined as a filter");
    const perEntryChars=Math.max(64,Math.min(1600,config.recallMaxTokens*4-300));
    const limit=Math.min(params.limit??5,Math.max(1,Math.floor(config.recallMaxTokens*4/1800)));const leafId=ctx.sessionManager.getLeafId();
    const projectionHash=hash(authorized.map(e=>[e.sourceEntry.id,e.messages]));
    const queryHash=hash({entryId:params.entryId,itemId:params.itemId,query:params.query?.toLowerCase(),paths:params.paths?.map(p=>p.replace(/\\/g,"/")).sort(),limit});
    let start=0;
    if(params.cursor){try{const decoded=JSON.parse(Buffer.from(params.cursor,"base64url").toString("utf8"));if(decoded.v!==1||decoded.sessionId!==ctx.sessionManager.getSessionId()||decoded.leafId!==leafId||decoded.queryHash!==queryHash||decoded.projectionHash!==projectionHash||!Number.isSafeInteger(decoded.start)||decoded.start<0)throw new Error();start=decoded.start;}catch{throw new Error("STALE_RECALL_CURSOR: branch, projection or query changed; start a new recall request");}}
    const callPaths=new Map<string,string>();
    for(const entry of authorized)for(const message of entry.messages)if(message.role==="assistant")for(const part of message.content)if(part.type==="toolCall"&&typeof part.arguments.path==="string")callPaths.set(part.id,part.arguments.path.replace(/\\/g,"/"));
    const candidates=branch.filter(e=>visibleIds.has(e.id)&&(e.type==="message"||e.type==="custom_message"&&e.customType==="design-intent.projection.v1"||e.type==="compaction"));
    if(params.entryId&&branch.some(entry=>entry.id===params.entryId)&&!visibleIds.has(params.entryId))return{content:[{type:"text",text:`[${params.entryId}] Source is absent from the current authorized projection; content withheld.`}],details:{denied:true,reason:"SOURCE_NOT_IN_CURRENT_PROJECTION",returned:0}};
    const render=(entry:SessionEntry):string=>{
      const linked=state.snapshot.items.filter(item=>item.sourceEntryIds.includes(entry.id));
      const status=[...new Set(linked.map(item=>item.status).filter(value=>value==="stale"||value==="superseded"))].join(",");
      const prefix=`[${entry.id}; historical evidence${status?`; ${status}`:""}; not current filesystem truth]`;
      if(entry.type==="message"){
        const messages=projectedById.get(entry.id)??[];return messages.map(message=>{
          let effective=message;
          if(message.role==="toolResult"&&(typeof message.content==="string"||Array.isArray(message.content))){
            const effectiveText=typeof message.content==="string"?message.content:message.content.every((part:any)=>part.type==="text")?message.content.map((part:any)=>part.text).join("\n"):undefined;
            const owned=effectiveText!==undefined&&ownedSources.get(entry.id)?.replacementHash===hash(effectiveText);
            if(owned&&entry.message.role==="toolResult")effective=entry.message;
          }
          if(message.role==="user"){const text=typeof message.content==="string"?message.content:message.content.filter((part:any)=>part.type==="text").map((part:any)=>part.text).join("\n");return `${prefix} user: ${text.slice(0,perEntryChars)}${Array.isArray(message.content)&&message.content.some((part:any)=>part.type==="image")?" [image omitted]":""}`;}
          if(effective.role==="assistant")return `${prefix} assistant: ${effective.content.filter((part:any)=>part.type==="text").map((part:any)=>part.text).join("\n").slice(0,perEntryChars)}${effective.content.some((part:any)=>part.type==="thinking")?" [thinking omitted]":""}`;
          if(effective.role==="toolResult"){const content=typeof effective.content==="string"?effective.content:Array.isArray(effective.content)?effective.content.filter((part:any)=>part.type==="text").map((part:any)=>part.text).join("\n"):"";const callPath=callPaths.get(effective.toolCallId);return `${prefix} toolResult ${effective.toolName}${callPath?` path=${callPath}`:""}: ${content.slice(0,perEntryChars)}${Array.isArray(effective.content)&&effective.content.some((part:any)=>part.type==="image")?" [image omitted]":""}`;}
          return `${prefix} ${effective.role}`;
        }).join("\n");
      }
      if(entry.type==="custom_message")return `${prefix} Design Intent projection: ${entry.content.filter((part:any)=>part.type==="text").map((part:any)=>part.text).join("\n").slice(0,Math.min(1200,perEntryChars))}`;
      if(entry.type==="compaction")return `${prefix} checkpoint: ${entry.summary.slice(0,Math.min(1200,perEntryChars))}`;
      return prefix;
    };
    let matches=candidates.map(entry=>({entry,text:render(entry)}));
    if(params.entryId)matches=matches.filter(x=>x.entry.id===params.entryId);
    else if(params.itemId){const item=state.snapshot.items.find(i=>i.id===params.itemId);matches=matches.filter(x=>item?.sourceEntryIds.includes(x.entry.id));}
    else if(params.query){const q=params.query.toLowerCase();matches=matches.filter(x=>x.text.toLowerCase().includes(q));}
    if(params.paths?.length){matches=matches.filter(({entry,text})=>{
      const linked=state.snapshot.items.filter(item=>item.sourceEntryIds.includes(entry.id)).flatMap(item=>item.dependencies.map(dep=>dep.path.replace(/\\/g,"/")));
      if(entry.type==="message"&&entry.message.role==="toolResult"){const path=callPaths.get(entry.message.toolCallId);if(path)linked.push(path);const changes=(entry.message.details as any)?.changes;if(Array.isArray(changes))for(const change of changes)if(typeof change?.path==="string")linked.push(change.path.replace(/\\/g,"/"));}
      return params.paths!.some(requested=>{const path=requested.replace(/\\/g,"/");return linked.some(actual=>actual===path||actual.startsWith(`${path.replace(/\/$/,"")}/`)||path.startsWith(`${actual.replace(/\/$/,"")}/`))||text.includes(path);});
    });}
    const page=matches.slice(start,start+limit);
    let text=page.map(x=>x.text).join("\n\n");
    const truncated=text.length>config.recallMaxTokens*4;if(truncated)text=`${text.slice(0,config.recallMaxTokens*4)}\n[Recall response truncated; narrow the query or request fewer entries.]`;
    const next=start+page.length<matches.length?Buffer.from(JSON.stringify({v:1,sessionId:ctx.sessionManager.getSessionId(),leafId,queryHash,projectionHash,start:start+page.length})).toString("base64url"):undefined;
    return {content:[{type:"text",text:text||"No matching evidence in the active projected branch."}],details:{nextCursor:next,totalMatches:matches.length,returned:page.length,truncated,sourceStatuses:page.map(x=>({entryId:x.entry.id,stale:state.snapshot.items.some(item=>item.sourceEntryIds.includes(x.entry.id)&&item.status==="stale")}))}};
  }});

  const rebuildState=(ctx:any)=>rebuild(ctx.sessionManager.getBranch(),ctx.sessionManager.getSessionId());
  const checkpointCoverageValid=(branch:SessionEntry[],firstKeptId:string,state:ReturnType<typeof rebuild>):boolean=>{
    const cut=branch.findIndex(entry=>entry.id===firstKeptId);if(cut<0)return false;
    const prefixIds=new Set(branch.slice(0,cut).map(entry=>entry.id));
    for(const editEntry of branch)if(editEntry.type==="context_edit"&&prefixIds.has(editEntry.targetId)){
      if(!editEntry.replacement)return false;
      const content=editEntry.replacement.content;const text=typeof content==="string"?content:Array.isArray(content)&&content.every(part=>part.type==="text")?content.map(part=>part.type==="text"?part.text:"").join("\n"):undefined;
      if(text===undefined||!state.envelope?.edits.some(edit=>edit.targetId===editEntry.targetId&&edit.replacementHash===hash(text)))return false;
    }
    const covered=new Set([...state.snapshot.items.flatMap(item=>item.sourceEntryIds),...state.snapshot.coverage.map(c=>c.sourceEntryId)]);
    for(const entry of branch.slice(0,cut)){
      if(entry.type==="message"){
        const message=entry.message;
        if(message.role==="system")continue;
        if(message.role==="user"&&Array.isArray(message.content)&&message.content.some(part=>part.type==="image"))return false;
        if(message.role==="user"||message.role==="assistant"||message.role==="bashExecution"){
          if(!covered.has(entry.id))return false;
          continue;
        }
        if(message.role==="toolResult"){
          if(!covered.has(entry.id))return false;
          continue;
        }
      }
      if(entry.type==="context_edit"){
        if(!entry.replacement)return false;
        const content=entry.replacement.content;const text=typeof content==="string"?content:Array.isArray(content)&&content.every(part=>part.type==="text")?content.map(part=>part.type==="text"?part.text:"").join("\n"):undefined;
        if(text===undefined||!state.envelope?.edits.some(edit=>edit.targetId===entry.targetId&&edit.replacementHash===hash(text)))return false;
        continue;
      }
      if(entry.type==="custom_message"&&entry.customType==="design-intent.projection.v1"&&state.snapshot.intentRefs.length)continue;
      if(ownedCheckpoint(entry))continue;
      if(entry.type==="custom"||entry.type==="usage"||entry.type==="model_change"||entry.type==="thinking_level_change"||entry.type==="context_edit"||entry.type==="label"||entry.type==="session_info")continue;
      return false;
    }
    return true;
  };
  const restoreMode=(ctx:any)=>{mode=config.mode;const entry=[...ctx.sessionManager.getBranch()].reverse().find((e:SessionEntry)=>e.type==="custom"&&e.customType==="rolling-context.config.v1");const saved=(entry as any)?.data?.mode;if(saved==="on"||saved==="off"||saved==="observe")mode=saved;};
  pi.on("session_start",(_event,ctx)=>{validateContracts();restoreMode(ctx);const state=rebuildState(ctx);lastStatus=`mode=${mode}; items=${state.snapshot.items.length}; diagnostics=${state.diagnostics.length}`;});
  pi.on("session_tree",(_event,ctx)=>{restoreMode(ctx);const state=rebuildState(ctx);lastStatus=`mode=${mode}; branch=${ctx.sessionManager.getLeafId()??"empty"}; items=${state.snapshot.items.length}`;});
  pi.on("turn_end",async(event,ctx)=>{
    validateContracts();
    const state=rebuildState(ctx);
    const projection=event.context.contextEntries;
    const tokens=estimateProjection(projection);
    const current=ctx.getContextUsage();
    const contextWindow=Number.isSafeInteger(ctx.model?.contextWindow)&&ctx.model!.contextWindow>0?ctx.model!.contextWindow:current?.contextWindow;
    const turnConfig={...config,mode,contextWindow};const budget=effectiveTarget(turnConfig);const projected=tokens;
    lastStatus=`mode=${mode}; projected≈${projected}${current?.tokens==null?" (heuristic)":""}; window=${contextWindow??"unknown"}; target=${budget}; stateBytes=${serializedStateBytes(state.envelope??state.snapshot)}; groups=${groups(projection).length}; items=${state.snapshot.items.length}`;
    if(event.outcome!=="completed")return;
    const branch=ctx.sessionManager.getBranch();
    if(branch.some(e=>e.type==="custom"&&e.customType===TELEMETRY_TYPE&&(e.data as any)?.messageEntryId===event.messageEntryId))return;
    const clock=turnClock(branch),turn=clock.turn+1;
    const header=ctx.sessionManager.getHeader();
    const previewPlan=(ds:SessionBoundaryDraft[])=>header?previewDrafts(ctx.cwd,header,branch,[...event.entries,...ds]) as ProjectedSessionEntry[]|undefined:undefined;
    const usage=event.message.role==="assistant"?event.message.usage:undefined;
    const planning:PlanMetrics={};
    const own=mode==="off"?[]:planTurn({entries:projection,branch,eventEntries:event.entries,baseLeaf:ctx.sessionManager.getLeafId(),config:turnConfig,state,sessionId:ctx.sessionManager.getSessionId(),turn,cache:usage,metrics:planning,preview:previewPlan});
    if(planning.rejection)lastStatus+=`; plan rejected: ${planning.rejection}; attemptedStateBytes=${planning.attemptedStateBytes??"unknown"}`;
    const preview=previewPlan(own);
    const valid=!!preview&&projection.some(e=>e.messages.some(m=>m.role==="user"||m.role==="compactionSummary"));
    const applied=mode==="on"&&valid?own:[];
    const effective=applied.length?preview!:projection;
    const afterWarm=previewPlan(own.filter(d=>d.type!=="compaction"));
    const editDrafts=applied.filter(d=>d.type==="context_edit");
    const checkpoint=applied.find(d=>d.type==="compaction");
    const envelope=applied.find(d=>d.type==="custom"&&d.customType==="rolling-context.state.v1");
    const warmIds=new Set(ownedEdits(branch).keys());for(const d of editDrafts)warmIds.add(d.targetId);
    const metric=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)?value:null;
    const telemetry={type:TELEMETRY_TYPE,turn,messageEntryId:event.messageEntryId,epoch:clock.epoch+(checkpoint?1:0),mode,
      tokenBasis:"host-estimate",rawTokens:estimateProjection(branch.filter((e):e is Extract<SessionEntry,{type:"message"}>=>e.type==="message").map(e=>({sourceEntry:e,messages:[e.message]}))),
      projectedTokens:tokens,effectiveTokens:estimateProjection(effective),afterWarmTokens:planning.afterWarmTokens??(afterWarm?estimateProjection(afterWarm):null),afterCheckpointTokens:planning.afterCheckpointTokens??(preview?estimateProjection(preview):null),
      ...contextComposition(effective,warmIds),capsulesCreated:editDrafts.length,capsuleTokensSaved:applied.length&&afterWarm?tokens-estimateProjection(afterWarm):0,
      checkpointCreated:!!checkpoint,checkpointReason:checkpoint?(checkpoint.details as any)?.reason??null:null,
      stateBytes:serializedStateBytes(envelope?.data??state.envelope??state.snapshot),input:metric(usage?.input),cacheRead:metric(usage?.cacheRead),cacheWrite:metric(usage?.cacheWrite),
      providerContextTokens:metric(current?.tokens),planValid:valid,attemptedStateBytes:planning.attemptedStateBytes??null,planRejectedReason:planning.rejection??null};
    const result={entries:[...event.entries,...applied,{type:"custom" as const,customType:TELEMETRY_TYPE,data:telemetry}]};
    const analysis=analyzeGroups(projection,state.snapshot);
    if(!own.length)return result;
    if(mode==="observe"){
      const counts=new Map<string,number>();for(const group of analysis)for(const reason of group.reasons)counts.set(reason,(counts.get(reason)??0)+1);
      const eligible=analysis.filter(group=>group.reasons.length===0).length;
      const editedIds=new Set(own.filter(x=>x.type==="context_edit").map(x=>x.targetId));const scheduledGroups=analysis.filter(group=>group.resultIds.some(id=>editedIds.has(id))).length;
      lastStatus+=`; observe: reserve=${config.reserveTokens}; headroom≈${budget-projected}; eligibleGroups=${eligible}; protection=${JSON.stringify(Object.fromEntries(counts))}; candidateEdits=${editedIds.size}; eligibleWithoutEdit=${Math.max(0,eligible-scheduledGroups)} (saving threshold/already projected); checkpoint=${own.some(x=>x.type==="compaction")}; projectionValid=${!!preview}; writes=0`;
      return result;
    }
    if(!preview){lastStatus+="; plan rejected by projection validation";return result;}
    return result;
  });
  pi.on("agent_before_settle",async(event,ctx)=>{
    if(event.outcome!=="completed"||mode!=="on")return;
    // turn_end handles normal incremental updates; final boundary intentionally avoids a second compaction.
    const state=rebuildState(ctx);lastStatus+=`; settled revision=${state.snapshot.revision}`;
  });
  pi.on("session_before_compact",async(event,ctx)=>{
    const explicit=!!manualCheckpoint;
    try{validateContracts();}catch(error){lastStatus=`Rolling Context disabled: ${error instanceof Error?error.message:String(error)}`;ctx.ui.notify(lastStatus,"error");if(explicit){manualCheckpoint=undefined;return {cancel:true};}return;}
    if(explicit&&(event.reason!=="manual"||ctx.sessionManager.getSessionId()!==manualCheckpoint!.sessionId||ctx.sessionManager.getLeafId()!==manualCheckpoint!.leafId)){
      ctx.ui.notify("Rolling checkpoint cancelled because the session branch changed before compaction.","warning");return {cancel:true};
    }
    // Overflow recovery is deliberately left to the host. User-supplied compact instructions
    // are never replaced; the explicit Rolling command's own instructions are the exception.
    if(!explicit&&(event.reason==="overflow"||!!event.customInstructions)){
      lastStatus+=`; native compact delegated reason=${event.reason}; customInstructions=${!!event.customInstructions}`;return;
    }
    const clock=turnClock(ctx.sessionManager.getBranch());
    if(!explicit&&(mode!=="on"||clock.turn-clock.lastCheckpointTurn<config.minCheckpointTurns)){lastStatus+="; native compact delegated: Rolling checkpoint cadence";return;}
    const state=rebuildState(ctx);
    const firstKeptEntryId=event.preparation.firstKeptEntryId;
    if(!firstKeptEntryId||!checkpointCoverageValid(event.branchEntries,firstKeptEntryId,state)){
      if(explicit){ctx.ui.notify("Rolling checkpoint cancelled: the task state does not cover every context entry before the proposed boundary.","warning");return {cancel:true};}
      lastStatus+=`; native compact delegated: checkpoint coverage unknown at ${firstKeptEntryId??"missing boundary"}`;return;
    }
    const warm=ownedEdits(event.branchEntries);
    const proposedCut=event.branchEntries.findIndex(e=>e.id===firstKeptEntryId);
    const prefix=new Set(event.branchEntries.slice(0,proposedCut).map(e=>e.id));
    const oldGroups=groups(ctx.sessionManager.buildSessionProjection().entries).filter(g=>prefix.has(g.assistantId));
    if(!explicit&&oldGroups.some(g=>g.results.some(r=>["read","bash","edit"].includes(r.message.toolName)&&(!warm.has(r.id)||clock.turn-(warm.get(r.id)?.warmTurn??clock.turn)<config.minCheckpointTurns)))){lastStatus+="; native compact delegated: hot evidence / warm residence";return;}
    boundMemory(state.snapshot);
    const summary=renderCheckpoint(state.snapshot);
    const cut=event.branchEntries.findIndex(entry=>entry.id===firstKeptEntryId);
    const keptIds=new Set(event.branchEntries.slice(cut).map(entry=>entry.id));
    const keptTokens=estimateProjection(ctx.sessionManager.buildSessionProjection().entries.filter(entry=>keptIds.has(entry.sourceEntry.id)));
    if(keptTokens+Math.ceil(summary.length/4)>=event.preparation.tokensBefore){
      if(explicit){ctx.ui.notify("Rolling checkpoint cancelled: the validated state does not reduce the estimated context size.","warning");return {cancel:true};}
      lastStatus+=`; native compact delegated: checkpoint has no estimated net saving`;return;
    }
    const leafId=ctx.sessionManager.getLeafId();const sessionId=ctx.sessionManager.getSessionId();
    const planId=hash([sessionId,leafId,firstKeptEntryId,summary]).slice(0,20);
    const revision=state.snapshot.revision+1;const summaryHash=hash(summary);
    const envelope={schemaVersion:1 as const,revision,planId,baseLeafId:leafId,snapshot:{...state.snapshot,revision},edits:[...warm.values()].filter(e=>keptIds.has(e.targetId)).map(({replacement,...edit})=>edit),checkpoint:{firstKeptEntryId,summaryHash}};
    if(serializedStateBytes(envelope)>MAX_STATE_BYTES){if(explicit){ctx.ui.notify("Rolling Context state exceeds 128 KiB; checkpoint cancelled.","error");return {cancel:true};}lastStatus+="; native compact delegated: state exceeds 128 KiB";return;}
    return {compaction:{summary,firstKeptEntryId,tokensBefore:event.preparation.tokensBefore,details:{type:"rolling-context.checkpoint.v1",turn:clock.turn,reason:explicit?"manual":event.reason,stateEnvelope:envelope,stateRevision:revision,planId,firstKeptEntryId,summaryHash}}};
  });
  pi.on("session_compact",event=>{manualCheckpoint=undefined;lastStatus+=`; compacted reason=${event.reason}; fromExtension=${event.fromExtension}`;});
  pi.on("session_compact_failed",event=>{manualCheckpoint=undefined;lastStatus+=`; compact failed reason=${event.reason}; aborted=${event.aborted}; ${event.errorMessage??"no error detail"}`;});

  pi.registerCommand("rolling-context",{description:"Inspect or control Rolling Context",handler:async(args,ctx)=>{
    const [verb,...rest]=args.trim().split(/\s+/);const value=rest.join(" ");
    if(verb==="status"||!verb){const state=rebuildState(ctx);ctx.ui.notify(`${lastStatus}\nmode=${mode}; focus=${state.snapshot.focus.taskId||"none"}; next=${state.snapshot.focus.nextSteps.length}; intentRefs=${state.snapshot.intentRefs.length}`,"info");return;}
    if(verb==="inspect"){const state=rebuildState(ctx);ctx.ui.notify(renderCheckpoint(state.snapshot),"info");return;}
    if(["on","observe","pin","unpin","checkpoint"].includes(verb))validateContracts();
    if(verb==="observe"||verb==="on"||verb==="off"){mode=verb;pi.appendEntry("rolling-context.config.v1",{mode});ctx.ui.notify(`Rolling Context mode: ${mode}. Existing edits/checkpoints are unchanged.`,"info");return;}
    if(verb==="pin"||verb==="unpin"){
      const id=rest[0];if(!id){ctx.ui.notify(`Usage: /rolling-context ${verb} ITEM_ID`,"warning");return;}
      const state=rebuildState(ctx);const item=state.snapshot.items.find(candidate=>candidate.id===id);if(!item){ctx.ui.notify(`Unknown active-branch item ${id}`,"error");return;}
      item.pinned=verb==="pin";state.snapshot.revision++;
      const envelope={schemaVersion:1 as const,revision:state.snapshot.revision,planId:hash([ctx.sessionManager.getSessionId(),ctx.sessionManager.getLeafId(),id,verb,state.snapshot.revision]).slice(0,24),baseLeafId:ctx.sessionManager.getLeafId(),snapshot:state.snapshot,edits:state.envelope?.edits??[],checkpoint:state.envelope?.checkpoint};
      if(serializedStateBytes(envelope)>MAX_STATE_BYTES){ctx.ui.notify("Rolling Context state exceeds 128 KiB; pin state was not written.","error");return;}
      pi.appendEntry("rolling-context.state.v1",envelope);ctx.ui.notify(`${verb}ned ${id}`,"info");return;
    }
    if(verb==="checkpoint"){
      await ctx.waitForIdle();
      if(ctx.hasPendingMessages()){ctx.ui.notify("Checkpoint skipped: pending messages exist.","warning");return;}
      const sessionId=ctx.sessionManager.getSessionId();const leafId=ctx.sessionManager.getLeafId();const state=rebuildState(ctx);const summary=renderCheckpoint(state.snapshot);
      const ok=await requestCheckpointApproval(pi,ctx,summary,serializedStateBytes(state.envelope??state.snapshot));
      if(!ok)return;
      validateContracts();
      if(ctx.sessionManager.getSessionId()!==sessionId||ctx.sessionManager.getLeafId()!==leafId||ctx.hasPendingMessages()){ctx.ui.notify("Checkpoint skipped: session branch changed or new messages arrived while approval was pending.","warning");return;}
      manualCheckpoint={sessionId,leafId};
      ctx.compact({customInstructions:"Use exactly the Rolling Context state supplied by the extension as the continuity summary. Do not add or infer project Design Intent. Preserve user instructions, task-local execution decisions, evidence freshness and next steps.",onComplete:()=>{manualCheckpoint=undefined;ctx.ui.notify("Rolling Context checkpoint completed.","info");},onError:error=>{manualCheckpoint=undefined;ctx.ui.notify(`Checkpoint failed: ${error.message}`,"error");}});
      return;
    }
    ctx.ui.notify("Usage: /rolling-context [status|inspect|checkpoint|on|off|observe]","warning");
  }});
}
