import type { ExtensionAPI, SessionBoundaryDraft, SessionEntry, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { analyzeGroups, boundMemory, effectiveTarget, estimateProjection, groups, hash, planTurn, previewDrafts, rebuild, renderCheckpoint, serializedStateBytes, MAX_STATE_BYTES, TELEMETRY_TYPE, contextComposition, warmEffectiveness, ownedEdits, ownedCheckpoint, checkpointSafe, makeCapsule, explicitUserConstraints, recallProjection, turnClock, continuitySufficient, extractContinuityFallback, type PlanMetrics, type RollingConfig } from "./v1.ts";

const NoteParams=Type.Object({intent:Type.String({minLength:1}),kind:Type.Union([Type.Literal("plan"),Type.Literal("task-decision"),Type.Literal("focus"),Type.Literal("next-step")]),text:Type.String({minLength:1,maxLength:2000}),replaces:Type.Optional(Type.Array(Type.String(),{maxItems:8})),paths:Type.Optional(Type.Array(Type.String({maxLength:256}),{maxItems:12}))},{additionalProperties:false});
const RecallParams=Type.Object({intent:Type.String({minLength:1}),entryId:Type.Optional(Type.String()),itemId:Type.Optional(Type.String()),query:Type.Optional(Type.String({maxLength:300})),paths:Type.Optional(Type.Array(Type.String({minLength:1,maxLength:256}),{maxItems:12})),cursor:Type.Optional(Type.String({maxLength:2048})),limit:Type.Optional(Type.Number({minimum:1,maximum:8}))},{additionalProperties:false});
const NoteDetails=Type.Object({type:Type.Literal("rolling-context.note.v1"),noteId:Type.String(),taskId:Type.String(),kind:Type.String(),text:Type.String(),replaces:Type.Array(Type.String()),paths:Type.Array(Type.String())});
const CommandArguments=[
  {value:"status",label:"status",description:"查看模式、预算与运行状态（默认）"},
  {value:"inspect",label:"inspect",description:"查看连续性摘要和当前分支的条目 ID"},
  {value:"on",label:"on",description:"启用后续自动上下文维护；不恢复已移出的内容"},
  {value:"observe",label:"observe",description:"仅观察和估算，不应用上下文改写"},
  {value:"off",label:"off",description:"停止后续 Rolling 改写；保留既有 edits/checkpoints"},
  {value:"pin",label:"pin <ITEM_ID>",description:"固定当前分支条目；先用 inspect 查看 ITEM_ID"},
  {value:"unpin",label:"unpin <ITEM_ID>",description:"解除条目固定；需要一个当前分支 ITEM_ID"},
  {value:"checkpoint",label:"checkpoint",description:"等待 idle、人工确认并验证覆盖和净节省后请求 compact"},
  {value:"help",label:"help",description:"显示全部参数与操作说明"},
];
const commandHelp=()=>["/rolling-context 参数说明",...CommandArguments.map(item=>`  ${item.label} — ${item.description}`),"on/off/observe 不回滚已有改写；pin/unpin 需要 inspect 中的准确 ITEM_ID。"].join("\n");

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
  let manualCheckpointCancelReason:string|undefined;

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
  const checkpointCoverageValid=(branch:SessionEntry[],firstKeptId:string,state:ReturnType<typeof rebuild>,projection:ProjectedSessionEntry[]):boolean=>{
    const cut=branch.findIndex(entry=>entry.id===firstKeptId);if(cut<0)return false;
    const prefixIds=new Set(branch.slice(0,cut).map(entry=>entry.id));
    for(const editEntry of branch)if(editEntry.type==="context_edit"&&prefixIds.has(editEntry.targetId)){
      if(!editEntry.replacement)return false;
      const content=editEntry.replacement.content;const text=typeof content==="string"?content:Array.isArray(content)&&content.every(part=>part.type==="text")?content.map(part=>part.type==="text"?part.text:"").join("\n"):undefined;
      if(text===undefined||!state.envelope?.edits.some(edit=>edit.targetId===editEntry.targetId&&edit.replacementHash===hash(text)))return false;
    }
    const covered=new Set([...state.snapshot.items.flatMap(item=>item.sourceEntryIds),...state.snapshot.coverage.map(c=>c.sourceEntryId)]);
    const projectedById=new Map(projection.map(entry=>[entry.sourceEntry.id,entry]));
    const protectedGroupIds=new Set(analyzeGroups(projection,state.snapshot).filter(group=>group.reasons.length>0).map(group=>group.assistantId));
    const groupsByResult=new Map(groups(projection).filter(group=>checkpointSafe(group)&&!protectedGroupIds.has(group.assistantId)).flatMap(group=>group.resultIds.map(id=>[id,group] as const)));
    const latestUserId=[...projection].reverse().find(projected=>projected.messages.some(message=>message.role==="user"))?.sourceEntry.id;
    for(const entry of branch.slice(0,cut)){
      if(entry.type==="message"){
        const message=entry.message;
        if(message.role==="system")continue;
        if(message.role==="user"&&Array.isArray(message.content)&&message.content.some(part=>part.type==="image"))return false;
        if(message.role==="user"){
          const text=typeof message.content==="string"?message.content:message.content.filter((part:any)=>part.type==="text").map((part:any)=>part.text).join("\n");
          const required=explicitUserConstraints(text);
          if(required.some(span=>!state.snapshot.items.some(item=>item.authority==="user"&&item.sourceEntryIds.includes(entry.id)&&(item.sourceSpan?.start===span.start&&item.sourceSpan.end===span.end||item.text===text))))return false;
          if(entry.id===latestUserId&&!state.snapshot.items.some(item=>item.authority==="user"&&item.sourceEntryIds.includes(entry.id)&&item.text===text))return false;
          continue;
        }
        if(message.role==="assistant"){
          const projected=projectedById.get(entry.id);
          if(message.content.some(part=>part.type==="toolCall")&&!groups(projection).some(group=>group.assistantId===entry.id&&checkpointSafe(group)))return false;
          if(!projected||projected.messages.some(value=>value.role!=="assistant"))return false;
          continue;
        }
        if(message.role==="bashExecution")return covered.has(entry.id);
        if(message.role==="toolResult"){
          const note=message.toolName==="context_note"&&(message.details as any)?.type==="rolling-context.note.v1"&&state.snapshot.items.some(item=>item.sourceEntryIds.includes(entry.id));
          if(!covered.has(entry.id)&&!groupsByResult.has(entry.id)&&!note)return false;
          if(message.isError||(!groupsByResult.has(entry.id)&&!note))return false;
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
  const recordTurnZero=(ctx:any)=>{
    const branch=ctx.sessionManager.getBranch();
    if(branch.some((entry:SessionEntry)=>entry.type==="custom"&&entry.customType===TELEMETRY_TYPE&&(entry.data as any)?.turn===0))return;
    if(turnClock(branch).turn>0||branch.some((entry:SessionEntry)=>entry.type==="message"&&entry.message.role==="assistant"))return;
    const projection=ctx.sessionManager.buildSessionProjection().entries as ProjectedSessionEntry[];
    const state=rebuild(branch,ctx.sessionManager.getSessionId());
    const usage=ctx.getContextUsage?.();
    const contextWindow=Number.isSafeInteger(ctx.model?.contextWindow)&&ctx.model.contextWindow>0?ctx.model.contextWindow:usage?.contextWindow;
    const target=effectiveTarget({...config,mode,contextWindow});
    const raw=branch.filter((entry:SessionEntry):entry is Extract<SessionEntry,{type:"message"}>=>entry.type==="message").map((entry:SessionEntry)=>({sourceEntry:entry,messages:[(entry as Extract<SessionEntry,{type:"message"}>).message]})) as ProjectedSessionEntry[];
    const warmIds=new Set(ownedEdits(branch).keys());
    const nullValue=null;
    const data={type:TELEMETRY_TYPE,turn:0,timelineKind:"initial",messageEntryId:null,epoch:turnClock(branch).epoch,mode,tokenBasis:"host-estimate",rawTokens:estimateProjection(raw),projectedTokens:estimateProjection(projection),effectiveTokens:estimateProjection(projection),afterWarmTokens:nullValue,afterCheckpointTokens:nullValue,targetTokens:target,softThresholdTokens:Math.ceil(target*1.2),hardThresholdTokens:contextWindow===undefined?nullValue:Math.max(0,contextWindow-config.reserveTokens-Math.max(2048,Math.ceil(contextWindow*0.05))),...contextComposition(projection,warmIds),...warmEffectiveness(projection,branch,warmIds),capsulesCreated:0,capsuleTokensSaved:0,checkpointWanted:false,checkpointCandidate:false,checkpointBlockedBy:[],checkpointCreated:false,checkpointReason:null,protectedTokens:0,protectedTokensByReason:{},eligibleHistoricalTokens:0,stateBytes:serializedStateBytes(state.envelope??state.snapshot),stateLimitBytes:MAX_STATE_BYTES,input:nullValue,uncachedInput:nullValue,cacheRead:nullValue,cacheWrite:nullValue,cacheReuseRatio:nullValue,usage:{input:nullValue,uncachedInput:nullValue,cacheRead:nullValue,cacheWrite:nullValue},providerContextTokens:typeof usage?.tokens==="number"?usage.tokens:nullValue,planValid:true,attemptedStateBytes:nullValue,planRejectedReason:nullValue};
    pi.appendEntry(TELEMETRY_TYPE,data);
  };
  pi.on("session_start",(_event,ctx)=>{restoreMode(ctx);recordTurnZero(ctx);const state=rebuildState(ctx);lastStatus=`mode=${mode}; items=${state.snapshot.items.length}; diagnostics=${state.diagnostics.length}`;});
  pi.on("session_tree",(_event,ctx)=>{restoreMode(ctx);const state=rebuildState(ctx);lastStatus=`mode=${mode}; branch=${ctx.sessionManager.getLeafId()??"empty"}; items=${state.snapshot.items.length}`;});
  pi.on("turn_end",async(event,ctx)=>{
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
    const warmIds=new Set(ownedEdits(branch).keys());if(mode==="on")for(const d of editDrafts)warmIds.add(d.targetId);
    const metric=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)?value:null;
    const uncachedInput=metric(usage?.input),cacheRead=metric(usage?.cacheRead),cacheWrite=metric(usage?.cacheWrite);
    const cacheDenominator=uncachedInput!==null&&cacheRead!==null?uncachedInput+cacheRead:0;
    const cacheReuseRatio=cacheDenominator>0?cacheRead!/cacheDenominator:null;
    const actualWarm=warmEffectiveness(effective,branch,warmIds);
    const checkpointBlockedBy=planning.checkpointBlockedBy??[];
    const hardThreshold=contextWindow===undefined?null:Math.max(0,contextWindow-config.reserveTokens-Math.max(2048,Math.ceil(contextWindow*0.05)));
    const telemetry={type:TELEMETRY_TYPE,turn,timelineKind:"completed",eventPosition:"after-turn",messageEntryId:event.messageEntryId,epoch:clock.epoch+(checkpoint?1:0),mode,
      tokenBasis:"host-estimate",rawTokens:estimateProjection(branch.filter((e):e is Extract<SessionEntry,{type:"message"}>=>e.type==="message").map(e=>({sourceEntry:e,messages:[e.message]}))),
      projectedTokens:tokens,effectiveTokens:estimateProjection(effective),afterWarmTokens:planning.afterWarmTokens??(afterWarm?estimateProjection(afterWarm):null),afterCheckpointTokens:planning.afterCheckpointTokens??(preview?estimateProjection(preview):null),
      targetTokens:budget,softThresholdTokens:Math.ceil(budget*1.2),hardThresholdTokens:hardThreshold,stateLimitBytes:MAX_STATE_BYTES,
      ...contextComposition(effective,warmIds),...actualWarm,capsulesCreated:editDrafts.length,
      warmEventSourceTokens:mode==="on"&&editDrafts.length?planning.warmSourceTokens??0:0,warmEventCapsuleTokens:mode==="on"&&editDrafts.length?planning.warmCapsuleTokens??0:0,warmEventTokensSaved:mode==="on"&&editDrafts.length?planning.warmTokensSaved??0:0,
      capsuleTokensSaved:mode==="on"&&editDrafts.length?planning.warmTokensSaved??0:0,
      earliestMutationPosition:mode==="on"&&editDrafts.length?planning.earliestMutationPosition??null:null,earliestMutationEntryId:mode==="on"&&editDrafts.length?planning.earliestMutationEntryId??null:null,
      projectedTokensBeforeMutation:mode==="on"&&editDrafts.length?planning.projectedTokensBeforeMutation??null:null,estimatedInvalidatedSuffixTokens:mode==="on"&&editDrafts.length?planning.estimatedInvalidatedSuffixTokens??0:0,
      plannedWarmSourceTokens:planning.warmSourceTokens??0,plannedWarmCapsuleTokens:planning.warmCapsuleTokens??0,plannedWarmTokensSaved:planning.warmTokensSaved??0,
      checkpointWanted:planning.checkpointWanted??false,checkpointCandidate:planning.checkpointCandidate??false,checkpointBlockedBy,checkpointCreated:!!checkpoint,
      checkpointReason:checkpoint?(checkpoint.details as any)?.reason??null:planning.checkpointReason??null,protectedTokens:planning.protectedTokens??0,protectedTokensByReason:planning.protectedTokensByReason??{},eligibleHistoricalTokens:planning.eligibleHistoricalTokens??0,
      checkpointBoundaryEntryId:planning.checkpointBoundaryEntryId??null,checkpointKeptTokens:planning.checkpointKeptTokens??null,checkpointEstimatedTokens:planning.checkpointEstimatedTokens??null,checkpointPreviewTokens:planning.checkpointPreviewTokens??null,
      stateBytes:serializedStateBytes(envelope?.data??state.envelope??state.snapshot),input:uncachedInput,uncachedInput,cacheRead,cacheWrite,cacheReuseRatio,
      usage:{input:uncachedInput,uncachedInput,cacheRead,cacheWrite,cacheReuseRatio},
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
    const cancelManual=(code:string,detail:string,severity:"warning"|"error"="warning")=>{
      lastStatus+=`; checkpoint blocked: ${code}`;
      manualCheckpointCancelReason=`${code}: ${detail}`;
      ctx.ui.notify(`Rolling checkpoint cancelled (${code}): ${detail}`,severity);
      return {cancel:true as const};
    };
    if(explicit&&(event.reason!=="manual"||ctx.sessionManager.getSessionId()!==manualCheckpoint!.sessionId||ctx.sessionManager.getLeafId()!==manualCheckpoint!.leafId)){
      return cancelManual("SESSION_BRANCH_CHANGED","the session branch changed before compaction");
    }
    // Overflow recovery is deliberately left to the host. User-supplied compact instructions
    // are never replaced; the explicit Rolling command's own instructions are the exception.
    if(!explicit&&(event.reason==="overflow"||!!event.customInstructions)){
      lastStatus+=`; native compact delegated reason=${event.reason}; customInstructions=${!!event.customInstructions}`;return;
    }
    const clock=turnClock(ctx.sessionManager.getBranch());
    if(!explicit&&(mode!=="on"||clock.turn-clock.lastCheckpointTurn<config.minCheckpointTurns)){lastStatus+="; native compact delegated: Rolling checkpoint cadence";return;}
    const state=rebuildState(ctx);
    const projection=ctx.sessionManager.buildSessionProjection().entries as ProjectedSessionEntry[];
    if(!continuitySufficient(state.snapshot)){
      const extracted=extractContinuityFallback(projection,state.snapshot);
      if(!extracted.ok){
        if(explicit)return cancelManual("MISSING_CONTINUITY_STATE","bounded continuity extraction could not establish a safe task state");
        lastStatus+="; checkpoint blocked: MISSING_CONTINUITY_STATE";
        return;
      }
    }
    const firstKeptEntryId=event.preparation.firstKeptEntryId;
    if(!firstKeptEntryId||!checkpointCoverageValid(event.branchEntries,firstKeptEntryId,state,projection)){
      if(explicit)return cancelManual("CHECKPOINT_COVERAGE","the current task state does not cover every context entry before the host-proposed boundary");
      lastStatus+=`; native compact delegated: checkpoint coverage unknown at ${firstKeptEntryId??"missing boundary"}`;return;
    }
    const warm=ownedEdits(event.branchEntries);
    const proposedCut=event.branchEntries.findIndex(e=>e.id===firstKeptEntryId);
    const prefix=new Set(event.branchEntries.slice(0,proposedCut).map(e=>e.id));
    const oldGroups=groups(projection).filter(g=>prefix.has(g.assistantId));
    const contextWindow=Number.isSafeInteger(ctx.model?.contextWindow)&&ctx.model!.contextWindow>0?ctx.model!.contextWindow:ctx.getContextUsage()?.contextWindow;
    const hard=contextWindow===undefined?Infinity:Math.max(0,contextWindow-config.reserveTokens-Math.max(2048,Math.ceil(contextWindow*0.05)));
    const emergency=event.preparation.tokensBefore>hard;
    const valuableUnwarmed=oldGroups.some(group=>group.results.some(result=>{
      if(warm.has(result.id))return false;
      const source=event.branchEntries.find(entry=>entry.id===result.id);
      if(source?.type!=="message"||source.message.role!=="toolResult"||!Array.isArray(source.message.content)||source.message.content.some((part:any)=>part.type!=="text"))return false;
      const original=source.message.content.map((part:any)=>part.text).join("\n"),capsule=makeCapsule(group,event.branchEntries,result.id);
      return !!capsule&&original.length-capsule.length>=config.minSavingTokens*4;
    }));
    if(valuableUnwarmed&&!emergency){if(explicit)return cancelManual("WARM_REQUIRED","valuable historical evidence must enter warm and satisfy residence before checkpointing");lastStatus+="; checkpoint blocked: WARM_REQUIRED";return;}
    const tooYoungWarm=oldGroups.some(group=>group.results.some(result=>{
      const committed=warm.get(result.id);return !!committed&&!emergency&&clock.turn-(committed.warmTurn??clock.turn)<config.minCheckpointTurns;
    }));
    if(tooYoungWarm){if(explicit)return cancelManual("WARM_RESIDENCE","a committed warm source has not met its residence period");lastStatus+="; checkpoint blocked: WARM_RESIDENCE";return;}
    boundMemory(state.snapshot);
    const summary=renderCheckpoint(state.snapshot);
    const cut=event.branchEntries.findIndex(entry=>entry.id===firstKeptEntryId);
    const keptIds=new Set(event.branchEntries.slice(cut).map(entry=>entry.id));
    const keptTokens=estimateProjection(ctx.sessionManager.buildSessionProjection().entries.filter(entry=>keptIds.has(entry.sourceEntry.id)));
    if(keptTokens+Math.ceil(summary.length/4)>=event.preparation.tokensBefore){
      if(explicit)return cancelManual("NO_NET_SAVING","the validated checkpoint does not reduce the estimated context size");
      lastStatus+=`; native compact delegated: checkpoint has no estimated net saving`;return;
    }
    const leafId=ctx.sessionManager.getLeafId();const sessionId=ctx.sessionManager.getSessionId();
    const planId=hash([sessionId,leafId,firstKeptEntryId,summary]).slice(0,20);
    const revision=state.snapshot.revision+1;const summaryHash=hash(summary);
    const envelope={schemaVersion:1 as const,revision,planId,baseLeafId:leafId,snapshot:{...state.snapshot,revision},edits:[...warm.values()].filter(e=>keptIds.has(e.targetId)).map(({replacement,...edit})=>edit),checkpoint:{firstKeptEntryId,summaryHash}};
    if(serializedStateBytes(envelope)>MAX_STATE_BYTES){if(explicit)return cancelManual("STATE_SIZE_LIMIT","Rolling Context state exceeds 128 KiB","error");lastStatus+="; native compact delegated: state exceeds 128 KiB";return;}
    return {compaction:{summary,firstKeptEntryId,tokensBefore:event.preparation.tokensBefore,details:{type:"rolling-context.checkpoint.v1",turn:clock.turn,reason:explicit?"manual":event.reason,stateEnvelope:envelope,stateRevision:revision,planId,firstKeptEntryId,summaryHash}}};
  });
  pi.on("session_compact",event=>{manualCheckpoint=undefined;lastStatus+=`; compacted reason=${event.reason}; fromExtension=${event.fromExtension}`;});
  pi.on("session_compact_failed",event=>{manualCheckpoint=undefined;lastStatus+=`; compact failed reason=${event.reason}; aborted=${event.aborted}; ${event.errorMessage??"no error detail"}`;});

  pi.registerCommand("rolling-context",{description:"Rolling Context: status | inspect | on | observe | off | pin/unpin ITEM_ID | checkpoint | help",getArgumentCompletions:prefix=>{
    const trimmed=prefix.trimStart();
    if(/^(pin|unpin)\s/.test(trimmed)){const item=CommandArguments.find(item=>item.value===trimmed.split(/\s+/)[0])!;return [{...item,value:prefix}];}
    if(/\s/.test(trimmed))return null;
    const matches=CommandArguments.filter(item=>item.value.startsWith(trimmed));return matches.length?matches:null;
  },handler:async(args,ctx)=>{
    const [verb,...rest]=args.trim().split(/\s+/);const value=rest.join(" ");
    if(verb==="help"){ctx.ui.notify(commandHelp(),"info");return;}
    if(rest.length&&(verb!=="pin"&&verb!=="unpin"||rest.length!==1)){ctx.ui.notify(commandHelp(),"warning");return;}
    if(verb==="status"||!verb){const state=rebuildState(ctx);ctx.ui.notify(`${lastStatus}\nmode=${mode}; focus=${state.snapshot.focus.taskId||"none"}; next=${state.snapshot.focus.nextSteps.length}; intentRefs=${state.snapshot.intentRefs.length}`,"info");return;}
    if(verb==="inspect"){const state=rebuildState(ctx);const items=state.snapshot.items.map(item=>`- ${item.id} · ${item.kind} · ${item.status}${item.pinned?" · pinned":""}: ${item.text.slice(0,120)}`);ctx.ui.notify(`${renderCheckpoint(state.snapshot)}\n\n当前分支条目（ITEM_ID）：\n${items.join("\n")||"- 无"}`,"info");return;}
    if(verb==="observe"||verb==="on"||verb==="off"){mode=verb;pi.appendEntry("rolling-context.config.v1",{mode});ctx.ui.notify(`Rolling Context mode: ${mode}. Existing edits/checkpoints are unchanged.`,"info");return;}
    if(verb==="pin"||verb==="unpin"){
      const id=rest[0];if(!id){ctx.ui.notify(`Usage: /rolling-context ${verb} ITEM_ID\n先用 /rolling-context inspect 查看条目 ID。`,"warning");return;}
      const state=rebuildState(ctx);const item=state.snapshot.items.find(candidate=>candidate.id===id);if(!item){ctx.ui.notify(`Unknown active-branch item ${id}`,"error");return;}
      item.pinned=verb==="pin";item.pinReason=verb==="pin"?"explicit":undefined;state.snapshot.revision++;
      const envelope={schemaVersion:1 as const,revision:state.snapshot.revision,planId:hash([ctx.sessionManager.getSessionId(),ctx.sessionManager.getLeafId(),id,verb,state.snapshot.revision]).slice(0,24),baseLeafId:ctx.sessionManager.getLeafId(),snapshot:state.snapshot,edits:state.envelope?.edits??[],checkpoint:state.envelope?.checkpoint};
      if(serializedStateBytes(envelope)>MAX_STATE_BYTES){ctx.ui.notify("Rolling Context state exceeds 128 KiB; pin state was not written.","error");return;}
      pi.appendEntry("rolling-context.state.v1",envelope);ctx.ui.notify(`${verb}ned ${id}`,"info");return;
    }
    if(verb==="checkpoint"){
      await ctx.waitForIdle();
      if(ctx.hasPendingMessages()){ctx.ui.notify("Checkpoint skipped: pending messages exist.","warning");return;}
      const sessionId=ctx.sessionManager.getSessionId();const leafId=ctx.sessionManager.getLeafId();const state=rebuildState(ctx);const summary=renderCheckpoint(state.snapshot);
      if(!ctx.hasUI){ctx.ui.notify("Manual checkpoint requires a UI.","error");return;}
      const ok=await ctx.ui.confirm("Rolling Context checkpoint",`Create a checkpoint from current validated task state?\n\n${summary.slice(0,3000)}`);
      if(!ok)return;
      if(ctx.sessionManager.getSessionId()!==sessionId||ctx.sessionManager.getLeafId()!==leafId||ctx.hasPendingMessages()){ctx.ui.notify("Checkpoint skipped: session branch changed or new messages arrived while approval was pending.","warning");return;}
      manualCheckpointCancelReason=undefined;
      manualCheckpoint={sessionId,leafId};
      ctx.compact({customInstructions:"Use exactly the Rolling Context state supplied by the extension as the continuity summary. Do not add or infer project Design Intent. Preserve user instructions, task-local execution decisions, evidence freshness and next steps.",onComplete:()=>{manualCheckpoint=undefined;manualCheckpointCancelReason=undefined;ctx.ui.notify("Rolling Context checkpoint completed.","info");},onError:error=>{const reason=manualCheckpointCancelReason;manualCheckpoint=undefined;manualCheckpointCancelReason=undefined;ctx.ui.notify(reason?`Rolling checkpoint cancelled: ${reason}`:`Checkpoint failed: ${error.message}`,"error");}});
      return;
    }
    ctx.ui.notify(commandHelp(),"warning");
  }});
}
