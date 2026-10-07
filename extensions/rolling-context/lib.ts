import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ProjectedSessionEntry, SessionEntry, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { estimateTokens, SessionManager } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";

export const STATE_TYPE = "rolling-context.state.v1";
export const NOTE_TYPE = "rolling-context.note.v1";
export const CHECKPOINT_TYPE = "rolling-context.checkpoint.v1";
export const TELEMETRY_TYPE = "rolling-context.telemetry.v1";
export const MAX_STATE_BYTES=128*1024;
export function serializedStateBytes(value:unknown):number{return new TextEncoder().encode(JSON.stringify(value)).byteLength;}

export interface MemoryItem {
  id: string;
  key: string;
  kind: "constraint" | "project" | "task-decision" | "change" | "test" | "task" | "focus";
  text: string;
  status: "active" | "resolved" | "superseded" | "stale";
  authority: "user" | "tool-evidence" | "agent-report" | "inference";
  sourceEntryIds: string[];
  taskId: string;
  dependencies: Array<{ path: string; observedHash?: string }>;
  observedAtEntryId: string;
  supersedes?: string[];
  pinned: boolean;
}
export interface IntentReference {
  storePath: string; storeRevision: number; sourceHash: string; id: string; projection?: string;
}
export interface MemorySnapshot {
  schemaVersion: 1; revision: number; coveredThroughEntryId: string;
  items: MemoryItem[]; intentRefs: IntentReference[];
  focus: { taskId: string; nextSteps: string[]; openQuestions: string[] };
  coverage: Array<{ sourceEntryId: string; disposition: "retained" | "extracted" | "recall-only" }>;
}
export interface StateEnvelope {
  schemaVersion: 1; revision: number; planId: string; baseLeafId: string | null;
  snapshot: MemorySnapshot;
  edits: Array<{targetId:string; originalHash:string; replacementHash:string; replacement?:string; warmTurn?:number}>;
  checkpoint?: {firstKeptEntryId:string; summaryHash:string};
}
export interface RollingConfig {
  mode: "observe" | "on" | "off";
  targetTokens: number;
  reserveTokens: number;
  contextWindow?: number;
  minSavingTokens: number;
  minCheckpointTurns: number;
  minWarmTurns?: number;
  minBatchSavingTokens?: number;
  recallMaxTokens: number;
}
export interface PlanMetrics {
  afterWarmTokens?:number;
  afterCheckpointTokens?:number;
  attemptedStateBytes?:number;
  rejection?:string;
}
function replacementText(entry:Extract<SessionEntry,{type:"context_edit"}>):string|undefined {
  const content=entry.replacement?.content;
  return typeof content==="string"?content:Array.isArray(content)&&content.every(p=>p.type==="text")?content.map(p=>p.type==="text"?p.text:"").join("\n"):undefined;
}
export function ownedCheckpoint(entry:SessionEntry):boolean {
  if(entry.type!=="compaction")return false;
  const d=entry.details as any, c=d?.stateEnvelope?.checkpoint;
  return d?.type===CHECKPOINT_TYPE&&d.firstKeptEntryId===entry.firstKeptEntryId&&d.summaryHash===hash(entry.summary)&&c?.firstKeptEntryId===entry.firstKeptEntryId&&c?.summaryHash===d.summaryHash;
}
// Ownership is append-order evidence, not a capsule-looking string. A foreign edit
// anywhere in a source's history permanently prevents raw restoration.
export function ownedEdits(branch:SessionEntry[]):Map<string,StateEnvelope["edits"][number]> {
  const sources=new Map(branch.map(entry=>[entry.id,entry]));
  const declared=new Map<string,StateEnvelope["edits"][number]>(),owned=new Map<string,StateEnvelope["edits"][number]>(),foreign=new Set<string>();
  for(const entry of branch){
    const envelope=entry.type==="custom"&&entry.customType===STATE_TYPE?entry.data as StateEnvelope:ownedCheckpoint(entry)?(entry as any).details.stateEnvelope as StateEnvelope:undefined;
    if(envelope?.schemaVersion===1&&Array.isArray(envelope.edits))for(const edit of envelope.edits){
      declared.set(edit.targetId,edit);
      const actual=owned.get(edit.targetId);
      if(actual&&actual.originalHash===edit.originalHash&&actual.replacementHash===edit.replacementHash&&actual.warmTurn===undefined&&edit.warmTurn!==undefined)owned.set(edit.targetId,{...actual,warmTurn:edit.warmTurn});
    }
    if(entry.type!=="context_edit")continue;
    const edit=declared.get(entry.targetId),text=replacementText(entry);
    const source=sources.get(entry.targetId);
    const original=source?.type==="message"&&source.message.role==="toolResult"?textContent(source.message):undefined;
    if(!edit||text===undefined||hash(text)!==edit.replacementHash||original===undefined||hash(original)!==edit.originalHash)foreign.add(entry.targetId);
    if(!foreign.has(entry.targetId)&&edit)owned.set(entry.targetId,edit);else owned.delete(entry.targetId);
  }
  return owned;
}
export function turnClock(branch:SessionEntry[]):{turn:number;lastWarmTurn:number;lastCheckpointTurn:number;epoch:number} {
  let turn=0,lastCheckpointTurn=0,epoch=0;
  for(const entry of branch){
    if(entry.type==="custom"&&entry.customType===TELEMETRY_TYPE){const n=(entry.data as any)?.turn;if(Number.isSafeInteger(n)&&n>turn)turn=n;}
    if(ownedCheckpoint(entry)){epoch++;const n=(entry as any).details.turn;lastCheckpointTurn=Number.isSafeInteger(n)?n:turn;}
  }
  const lastWarmTurn=Math.max(0,...[...ownedEdits(branch).values()].map(e=>e.warmTurn??0));
  return {turn,lastWarmTurn,lastCheckpointTurn,epoch};
}
export function recallProjection(cwd:string,header:any,branch:SessionEntry[],live:ProjectedSessionEntry[]):ProjectedSessionEntry[] {
  // Foreign compactions may encode redaction/permissions. Never undo them.
  if(!header||branch.some(e=>e.type==="compaction"&&!ownedCheckpoint(e)))return live;
  const filtered=branch.filter(e=>!ownedCheckpoint(e)).map((e,i,all)=>({...e,parentId:i?all[i-1].id:null}));
  try{
    const restored=SessionManager.inMemory(cwd,undefined,[header,...filtered]).buildSessionProjection().entries;
    const visible=new Map(live.map(e=>[e.sourceEntry.id,e]));
    return restored.map(e=>visible.get(e.sourceEntry.id)??e);
  }catch{return live;}
}
export interface Group {
  assistantId: string; resultIds: string[]; callIds: string[]; complete: boolean; consumed: boolean;
  message: Extract<AgentMessage, { role: "assistant" }>;
  results: Array<{ id:string; message: Extract<AgentMessage,{role:"toolResult"}> }>;
}
export const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
export function effectiveTarget(config:RollingConfig):number{
  if(!Number.isSafeInteger(config.contextWindow)||!config.contextWindow)return config.targetTokens;
  const safety=Math.max(2048,Math.ceil(config.contextWindow*0.05));
  return Math.min(config.targetTokens,Math.max(0,config.contextWindow-config.reserveTokens-safety));
}
export function emptySnapshot(taskId = "") : MemorySnapshot {
  return { schemaVersion:1, revision:0, coveredThroughEntryId:"", items:[], intentRefs:[], focus:{taskId,nextSteps:[],openQuestions:[]}, coverage:[] };
}
export function boundMemory(snapshot:MemorySnapshot):void {
  snapshot.items=snapshot.items.filter(i=>i.pinned||(!i.id.startsWith("rc-assistant-")&&i.status!=="superseded"&&i.status!=="resolved"));
  for(const item of snapshot.items){
    if(!item.pinned&&item.id.startsWith("rc-evidence-"))item.text=`Historical source=${item.sourceEntryIds[0]}; paths=${item.dependencies.map(d=>d.path).join(",")}; recall for exact evidence, not current filesystem truth.`;
    if(!item.pinned&&item.id.startsWith("rc-bash-"))item.text=`Historical shell source=${item.sourceEntryIds[0]}; recall for exact evidence.`;
  }
  // These are a bounded working map, not a permanent evidence ledger. L0 still
  // contains every retired source. Explicit constraints/decisions/pins are exempt.
  for(const kind of ["project","change","test"] as const){
    const items=snapshot.items.filter(i=>i.kind===kind&&!i.pinned);
    const retired=new Set(items.slice(0,Math.max(0,items.length-32)).map(i=>i.id));
    snapshot.items=snapshot.items.filter(i=>!retired.has(i.id));
  }
  snapshot.coverage=snapshot.coverage.slice(-64);
  snapshot.focus.nextSteps=snapshot.items.filter(i=>i.status==="active"&&i.key.startsWith("next-step:")).slice(-3).map(i=>i.text);
}
export function contextComposition(entries:ProjectedSessionEntry[],warmIds:Set<string>):{hotTokens:number;warmTokens:number;checkpointTokens:number;otherTokens:number} {
  const result={hotTokens:0,warmTokens:0,checkpointTokens:0,otherTokens:0};
  for(const entry of entries)for(const message of entry.messages){
    const key=message.role==="compactionSummary"?"checkpointTokens":warmIds.has(entry.sourceEntry.id)?"warmTokens":["user","assistant","toolResult","bashExecution"].includes(message.role)?"hotTokens":"otherTokens";
    result[key]+=estimateTokens(message);
  }
  return result;
}
function validSnapshot(x: unknown): x is MemorySnapshot {
  if (!x || typeof x !== "object") return false;
  const s=x as MemorySnapshot;
  return s.schemaVersion===1 && Number.isSafeInteger(s.revision) && Array.isArray(s.items) && Array.isArray(s.coverage) && Array.isArray(s.intentRefs) && !!s.focus;
}
export function rebuild(branch: SessionEntry[], sessionId: string): {snapshot:MemorySnapshot; envelope?:StateEnvelope; diagnostics:string[]} {
  let snapshot = emptySnapshot();
  let envelope:StateEnvelope|undefined;
  const diagnostics:string[]=[];
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === STATE_TYPE) {
      const candidate=entry.data as StateEnvelope;
      if (!candidate || candidate.schemaVersion!==1 || !validSnapshot(candidate.snapshot) || !Array.isArray(candidate.edits)) { diagnostics.push(`Invalid rolling state at ${entry.id}`); continue; }
      if (candidate.revision >= snapshot.revision) { snapshot=structuredClone(candidate.snapshot); envelope=candidate; }
    }
    if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "context_note") {
      const note=(entry.message.details as any);
      if (note?.type !== NOTE_TYPE || typeof note.text !== "string" || !["plan","task-decision","focus","next-step"].includes(note.kind)) continue;
      const taskId=String(note.taskId || `RC-T-${entry.id}`);
      if (snapshot.focus.taskId && snapshot.focus.taskId!==taskId) continue;
      snapshot.focus.taskId=taskId;
      for(const replaced of Array.isArray(note.replaces)?note.replaces:[]){
        const old=snapshot.items.find(item=>item.id===replaced&&item.taskId===taskId&&item.authority==="agent-report");
        if(old)old.status="superseded";
      }
      const item:MemoryItem={id:String(note.noteId||entry.id),key:`${note.kind}:${note.key||note.noteId||entry.id}`,kind:note.kind==="task-decision"?"task-decision":note.kind==="focus"?"focus":"task",text:note.text,status:"active",authority:"agent-report",sourceEntryIds:[entry.id],taskId,dependencies:Array.isArray(note.paths)?note.paths.map((path:string)=>({path})):[],observedAtEntryId:entry.id,pinned:false};
      if(note.kind!=="task-decision")for(const old of snapshot.items)if(old.authority==="agent-report"&&old.status==="active"&&old.key.startsWith(`${note.kind}:`)&&old.id!==item.id&&!old.pinned)old.status="superseded";
      if (!snapshot.items.some(i=>i.id===item.id)) snapshot.items.push(item);
      if (note.kind==="next-step") snapshot.focus.nextSteps=[...snapshot.focus.nextSteps,item.text].slice(-3);
    }
    if (entry.type === "message" && entry.message.role === "user" && !snapshot.focus.taskId) snapshot.focus.taskId=`RC-T-${entry.id}`;
    if (entry.type === "compaction" && (entry.details as any)?.type===CHECKPOINT_TYPE) {
      const details=entry.details as any;const data=details.stateEnvelope as StateEnvelope|undefined;const actualSummaryHash=hash(entry.summary);
      const validCheckpoint=data&&data.checkpoint?.firstKeptEntryId===entry.firstKeptEntryId&&data.checkpoint?.summaryHash===actualSummaryHash&&details.firstKeptEntryId===entry.firstKeptEntryId&&details.summaryHash===actualSummaryHash;
      if(data&&validCheckpoint&&validSnapshot(data.snapshot)&&data.revision>=snapshot.revision){snapshot=structuredClone(data.snapshot);envelope=data;}
      else diagnostics.push(`Checkpoint metadata does not match compaction entry ${entry.id}`);
    }
  }
  if(envelope){
    const latestEdits=new Map<string,Extract<SessionEntry,{type:"context_edit"}>>();
    for(const entry of branch)if(entry.type==="context_edit")latestEdits.set(entry.targetId,entry);
    const committedEdits=envelope.edits.filter(edit=>{
      const actual=latestEdits.get(edit.targetId);if(!actual?.replacement)return false;
      const content=actual.replacement.content;
      const text=typeof content==="string"?content:Array.isArray(content)&&content.every(part=>part.type==="text")?content.map(part=>part.type==="text"?part.text:"").join("\n"):undefined;
      return text!==undefined&&hash(text)===edit.replacementHash;
    });
    for(const edit of envelope.edits)if(!committedEdits.some(actual=>actual.targetId===edit.targetId&&actual.replacementHash===edit.replacementHash))diagnostics.push(`Planned context edit is not active at ${edit.targetId}`);
    const checkpoint=envelope.checkpoint;
    if(checkpoint&&!branch.some(entry=>entry.type==="compaction"&&entry.firstKeptEntryId===checkpoint.firstKeptEntryId&&hash(entry.summary)===checkpoint.summaryHash&&(entry.details as any)?.type===CHECKPOINT_TYPE&&(entry.details as any)?.summaryHash===checkpoint.summaryHash&&(entry.details as any)?.firstKeptEntryId===checkpoint.firstKeptEntryId)){
      diagnostics.push("Planned checkpoint has no matching committed compaction entry");
      envelope={...envelope,edits:committedEdits,checkpoint:undefined};
    }else envelope={...envelope,edits:committedEdits};
  }
  return {snapshot,envelope,diagnostics};
}
function textContent(message: Extract<AgentMessage,{role:"toolResult"}>): string|undefined {
  if (!Array.isArray(message.content) || message.content.some(part=>part.type!=="text")) return;
  return message.content.map(part=>part.type==="text"?part.text:"").join("\n");
}
export function groups(entries: ProjectedSessionEntry[]): Group[] {
  const out:Group[]=[];
  for(let i=0;i<entries.length;i++) {
    const projected=entries[i];
    for(const msg of projected.messages) {
      if(msg.role==="assistant") {
        const calls=msg.content.filter((x):x is Extract<typeof x,{type:"toolCall"}>=>x.type==="toolCall");
        if(calls.length) {
          const results:Array<{id:string;message:Extract<AgentMessage,{role:"toolResult"}>}> = [];
          for(const call of calls) {
            const found=entries.slice(i+1).flatMap(e=>e.messages.map(m=>({e,m}))).find(({m})=>m.role==="toolResult"&&m.toolCallId===call.id);
            if(found && found.m.role==="toolResult") results.push({id:found.e.sourceEntry.id,message:found.m});
          }
          out.push({assistantId:projected.sourceEntry.id,callIds:calls.map(c=>c.id),resultIds:results.map(r=>r.id),complete:results.length===calls.length&&new Set(results.map(r=>r.message.toolCallId)).size===calls.length&&results.every(r=>calls.some(c=>c.id===r.message.toolCallId)),consumed:false,message:msg,results});
        }
      }
    }
  }
  for(const group of out){
    if(!group.complete)continue;
    const lastResult=Math.max(...group.resultIds.map(id=>entries.findIndex(e=>e.sourceEntry.id===id)));
    group.consumed=entries.slice(lastResult+1).some(e=>e.messages.some(m=>m.role==="assistant"&&(m.stopReason==="stop"||m.stopReason==="toolUse")));
  }
  return out;
}
function safeBashEvidence(command:string):boolean {
  if(/[;&|<>`]/.test(command))return false;
  return /^\s*(?:pwd|ls|find|rg|grep|git\s+(?:status|diff|log|show)|cat|head|tail|sed\s+-n)\b/i.test(command)||/\b(?:test|vitest|jest|pytest|cargo test|go test|npm run test|pnpm test)\b/i.test(command);
}
function capsuleSafe(group:Group):boolean {
  return group.complete&&group.consumed&&group.results.length>0&&group.results.every(result=>{
    const call=group.message.content.find((part):part is Extract<typeof part,{type:"toolCall"}>=>part.type==="toolCall"&&part.id===result.message.toolCallId);
    if(!call||call.name!==result.message.toolName||result.message.isError||textContent(result.message)===undefined)return false;
    if(result.message.toolName==="read")return typeof call.arguments.path==="string";
    if(result.message.toolName==="edit")return Array.isArray((result.message.details as any)?.changes)&&((result.message.details as any).changes.length>0);
    if(result.message.toolName==="bash")return typeof call.arguments.command==="string"&&safeBashEvidence(call.arguments.command);
    return false;
  });
}
function isReadyIntentProjection(value:unknown):value is {type:"design-intent.projection.v1";availability:"ready";storePath:string;sourceHash:string;storeRevision:number;items:Array<{id:string;statement?:string}>} {
  if(!value||typeof value!=="object")return false;
  const projection=value as any;
  return projection.type==="design-intent.projection.v1"&&projection.availability==="ready"&&
    typeof projection.storePath==="string"&&projection.storePath.length>0&&
    typeof projection.sourceHash==="string"&&projection.sourceHash.length>0&&
    Number.isSafeInteger(projection.storeRevision)&&projection.storeRevision>=0&&Array.isArray(projection.items)&&
    projection.items.every((item:any)=>!!item&&typeof item.id==="string"&&!!item.id.trim()&&(item.statement===undefined||typeof item.statement==="string"));
}
function checkpointSafe(group:Group):boolean {
  return capsuleSafe(group)||group.complete&&group.consumed&&group.results.every(r=>!r.message.isError&&(
    r.message.toolName==="context_note"&&(r.message.details as any)?.type===NOTE_TYPE||
    isReadyIntentProjection((r.message.details as any)?.projection)));
}
export function analyzeGroups(entries:ProjectedSessionEntry[],snapshot:MemorySnapshot):Array<{assistantId:string;resultIds:string[];reasons:string[]}>{
  const all=groups(entries),recent=new Set(all.filter(group=>group.complete).slice(-3).map(group=>group.assistantId));
  const pinned=new Set(snapshot.items.filter(item=>item.pinned).flatMap(item=>item.sourceEntryIds));
  const dependencies=snapshot.items.filter(item=>item.status==="active"&&(item.authority==="agent-report"||item.pinned)).flatMap(item=>item.dependencies.map(dep=>dep.path.replace(/\\/g,"/")));
  const pathProtected=(path:string)=>dependencies.some(dep=>{const actual=path.replace(/\\/g,"/"),expected=dep.replace(/\\/g,"/");return actual===expected||actual.endsWith(`/${expected}`)||expected.endsWith(`/${actual}`);});
  return all.map(group=>{
    const reasons:string[]=[];
    if(!group.complete)reasons.push("INCOMPLETE_TOOL_GROUP");
    if(!group.consumed)reasons.push("NOT_CONSUMED");
    if(!capsuleSafe(group))reasons.push("UNSUPPORTED_TOOL_OR_RESULT");
    if(recent.has(group.assistantId))reasons.push("RECENT_GROUP");
    if(group.results.some(result=>pinned.has(result.id)||pinned.has(group.assistantId)))reasons.push("PINNED_SOURCE");
    if(group.results.some(result=>{
      const call=group.message.content.find((part):part is Extract<typeof part,{type:"toolCall"}>=>part.type==="toolCall"&&part.id===result.message.toolCallId);
      const paths:string[]=[];if(typeof call?.arguments.path==="string")paths.push(call.arguments.path);
      const changes=(result.message.details as any)?.changes;if(Array.isArray(changes))for(const change of changes)if(typeof change?.path==="string")paths.push(change.path);
      return paths.some(path=>pathProtected(path));
    }))reasons.push("ACTIVE_PATH_DEPENDENCY");
    return{assistantId:group.assistantId,resultIds:group.resultIds,reasons};
  });
}
export function makeCapsule(group:Group, entries:SessionEntry[], onlyResultId?:string):string|undefined {
  if(!capsuleSafe(group)) return;
  const lines:string[]=[];
  const selected=onlyResultId?group.results.filter(result=>result.id===onlyResultId):group.results;
  if(!selected.length)return;
  for(const result of selected) {
    const source=entries.find(e=>e.id===result.id);
    if(!source || source.type!=="message") return;
    const content=textContent(result.message);
    if(content===undefined || result.message.isError||content.startsWith("[Rolling Context 历史工具证据；")) return;
    const call=group.message.content.find((part):part is Extract<typeof part,{type:"toolCall"}>=>part.type==="toolCall"&&part.id===result.message.toolCallId);
    const preview=content.length>700?`${content.slice(0,700)}… [已缩减]`:content;
    lines.push(`- ${result.message.toolName} args=${JSON.stringify(call?.arguments??{}).slice(0,400)}; source=${result.id}: ${preview}`);
  }
  const capsule=`[Rolling Context 历史工具证据；原始来源 ${group.resultIds.join(", ")}；需要精确内容时对每个来源 ID 分别调用 context_recall(entryId=…) 召回]\n${lines.join("\n")}`;
  return capsule.length<group.results.reduce((n,r)=>n+(textContent(r.message)?.length||0),0)*0.5?capsule:undefined;
}
export function renderCheckpoint(snapshot:MemorySnapshot):string {
  const active=snapshot.items.filter(i=>i.status==="active"||i.status==="stale");
  const by=(kind:MemoryItem["kind"])=>active.filter(i=>i.kind===kind).map(i=>`- ${i.text}${i.status==="stale"?" (待核验)":""}`).join("\n")||"- 无";
  return ["[Rolling Context checkpoint v1]",`目标/焦点：${snapshot.focus.taskId||"当前任务"}`,"用户约束与任务计划：",by("constraint"),by("task"),"当前焦点：",by("focus"),"阻塞/待确认：",snapshot.focus.openQuestions.join("\n")||"- 未记录","文件/项目观察与工具证据（带来源，需按当前状态核验）：",by("project"),"相关 Design Intent（只读历史投影；设计敏感操作前必须重新查询当前文件）：",snapshot.intentRefs.length?snapshot.intentRefs.map(i=>`- ${i.id} @ ${i.storeRevision} (${i.sourceHash.slice(0,12)})${i.projection?`: ${i.projection}`:""}`).join("\n"):"- 未查询或未配置", "当前任务执行决策 (task-decision)：",by("task-decision"),"修改/验证/错误状态：",[...by("change").split("\n"),...by("test").split("\n")].join("\n"),"下一步：",snapshot.focus.nextSteps.map((s,i)=>`${i+1}. ${s}`).join("\n")||"- 未指定","历史证据仅可按当前分支来源召回；过期/待核验内容不可视为当前事实。"].join("\n");
}
export function estimateProjection(entries:ProjectedSessionEntry[]):number {
  return entries.reduce((sum,e)=>sum+e.messages.reduce((n,m)=>n+estimateTokens(m),0),0);
}
export function planTurn(args:{entries:ProjectedSessionEntry[];branch:SessionEntry[];eventEntries:SessionBoundaryDraft[];baseLeaf:string|null;config:RollingConfig;state:ReturnType<typeof rebuild>;sessionId:string;currentTokens?:number|null;turn?:number;cache?:{input?:number;cacheRead?:number};metrics?:PlanMetrics;preview?:(drafts:SessionBoundaryDraft[])=>ProjectedSessionEntry[]|undefined}):SessionBoundaryDraft[] {
  const {entries,branch,eventEntries,baseLeaf,config,state,sessionId}=args;
  if(config.mode==="off")return [];
  const drafts:SessionBoundaryDraft[]=[];
  const clock=turnClock(branch),turn=args.turn??clock.turn+1;
  const committed=ownedEdits(branch);
  const target=effectiveTarget(config),soft=Math.ceil(target*1.2);
  const hard=config.contextWindow===undefined?Infinity:Math.max(0,config.contextWindow-config.reserveTokens-Math.max(2048,Math.ceil(config.contextWindow*0.05)));
  const projectedTokens=estimateProjection(entries); // Usage is the previous request, never the candidate budget.
  const emergency=projectedTokens>hard;
  const preview=args.preview??((ds:SessionBoundaryDraft[])=>previewDrafts("/tmp",{type:"session",version:3,id:sessionId,timestamp:new Date(0).toISOString(),cwd:"/tmp"},branch,[...eventEntries,...ds]) as ProjectedSessionEntry[]|undefined);
  let snapshot=structuredClone(state.snapshot);
  const foreignTargets=new Set([...branch,...eventEntries].filter(e=>e.type==="context_edit"&&!committed.has(e.targetId)).map(e=>e.type==="context_edit"?e.targetId:""));
  snapshot.items=snapshot.items.filter(i=>!i.sourceEntryIds.some(id=>foreignTargets.has(id)));
  if(foreignTargets.size)snapshot.intentRefs=[]; // Older references have no source-entry field; revoke conservatively.
  boundMemory(snapshot);
  if(!snapshot.focus.taskId){const firstUser=entries.find(e=>e.messages.some(m=>m.role==="user"));if(firstUser)snapshot.focus.taskId=`RC-T-${firstUser.sourceEntry.id}`;}
  for(const projected of entries){
    for(const message of projected.messages){
      const projection=foreignTargets.has(projected.sourceEntry.id)?undefined:message.role==="custom"&&message.customType==="design-intent.projection.v1"
        ? message.details as any
        : message.role==="toolResult"
          ? (message.details as any)?.projection
          : undefined;
      if(!isReadyIntentProjection(projection))continue;
      for(const item of projection.items){
        if(!item||typeof item.id!=="string"||!item.id.trim())continue;
        const ref:IntentReference={storePath:projection.storePath,storeRevision:projection.storeRevision,sourceHash:projection.sourceHash,id:item.id,projection:typeof item.statement==="string"?item.statement.slice(0,600):undefined};
        const oldIndex=snapshot.intentRefs.findIndex(old=>old.id===ref.id&&old.storePath===ref.storePath);
        if(oldIndex<0)snapshot.intentRefs.push(ref);else snapshot.intentRefs[oldIndex]=ref;
      }
    }
    const user=projected.messages.find((m):m is Extract<AgentMessage,{role:"user"}>=>m.role==="user");
    if(!user||snapshot.items.some(item=>item.sourceEntryIds.includes(projected.sourceEntry.id)&&item.kind==="constraint"))continue;
    const text=typeof user.content==="string"?user.content:user.content.filter(part=>part.type==="text").map(part=>part.type==="text"?part.text:"").join("\n");
    if(!text.trim())continue;
    const constraint:MemoryItem={id:`rc-user-${projected.sourceEntry.id}`,key:`user:${projected.sourceEntry.id}`,kind:"constraint",text,status:"active",authority:"user",sourceEntryIds:[projected.sourceEntry.id],taskId:snapshot.focus.taskId||`RC-T-${projected.sourceEntry.id}`,dependencies:[],observedAtEntryId:projected.sourceEntry.id,pinned:true};
    snapshot.items.push(constraint);
  }
  const toolGroups=groups(entries);
  const groupAnalysis=analyzeGroups(entries,snapshot);const groupReasons=new Map(groupAnalysis.map(group=>[group.assistantId,group.reasons]));
  const edits=[...committed.values()].filter(edit=>entries.some(e=>e.sourceEntry.id===edit.targetId&&e.messages.length)).map(({replacement,...edit})=>({...edit,warmTurn:edit.warmTurn??clock.turn}));
  const candidates:Array<{edit:StateEnvelope["edits"][number];draft:SessionBoundaryDraft;saving:number}>=[];
  const coveredIndex=branch.findIndex(e=>e.id===snapshot.coveredThroughEntryId);
  const newSource=(id:string)=>coveredIndex<0||branch.findIndex(e=>e.id===id)>coveredIndex;
  const upsert=(item:MemoryItem)=>{const index=snapshot.items.findIndex(i=>i.key===item.key&&!i.pinned);if(index>=0)snapshot.items.splice(index,1);snapshot.items.push(item);};
  for(const group of toolGroups) {
    if(!group.complete) continue;
    for(const result of group.results) {
      const capsuleAllowed=(groupReasons.get(group.assistantId)?.length??1)===0;
      const foreignEdit=branch.some(e=>e.type==="context_edit"&&e.targetId===result.id)&&!committed.has(result.id);
      if(foreignEdit||foreignTargets.has(result.id))continue;
      const source=branch.find(e=>e.id===result.id);
      const raw=source?.type==="message"&&source.message.role==="toolResult"?textContent(source.message):undefined;
      const capsule=capsuleAllowed&&!foreignEdit&&!committed.has(result.id)&&raw===textContent(result.message)?makeCapsule(group,branch,result.id):undefined;
      const original=textContent(result.message);
      if(original===undefined)continue;
      const call=group.message.content.find((part):part is Extract<typeof part,{type:"toolCall"}>=>part.type==="toolCall"&&part.id===result.message.toolCallId);
      const args=call?JSON.stringify(call.arguments).slice(0,400):"{}";
      const evidenceText=`Historical ${result.message.toolName} source=${result.id}; args=${args}; error=${result.message.isError}; contentHash=${hash(original).slice(0,16)}. Recall for exact evidence; not current filesystem truth.`;
      const changes=(result.message.details as any)?.changes;
      const changedPaths=Array.isArray(changes)?changes.map((change:any)=>change?.path).filter((path:any):path is string=>typeof path==="string"):[];
      if(newSource(result.id)&&result.message.toolName==="edit"&&changedPaths.length){
        for(const item of snapshot.items)if((item.dependencies.some(dep=>changedPaths.includes(dep.path))||item.kind==="test"&&item.dependencies.length===0)&&(item.kind==="project"||item.kind==="test"))item.status="stale";
        const changeItem:MemoryItem={id:`rc-change-${result.id}`,key:`change:${changedPaths.slice().sort().join(",")}`,kind:"change",text:`Edit reported changes to ${changedPaths.join(", ")}; source ${result.id}. This does not imply tests passed.`,status:"active",authority:"tool-evidence",sourceEntryIds:[result.id],taskId:snapshot.focus.taskId,dependencies:changedPaths.map(path=>({path})),observedAtEntryId:result.id,pinned:false};
        upsert(changeItem);
      }
      const command=call&&typeof call.arguments.command==="string"?call.arguments.command:"";
      const isTestCommand=/\b(test|vitest|jest|pytest|cargo test|go test|npm run test|pnpm test)\b/i.test(command);
      const knownReadOnly=/^\s*(?:pwd|ls|find|rg|grep|git\s+(?:status|diff|log|show)|cat|head|tail|sed\s+-n)\b/i.test(command);
      if(newSource(result.id)&&result.message.toolName==="bash"&&!knownReadOnly&&!isTestCommand){for(const item of snapshot.items)if(item.kind==="project"||item.kind==="test")item.status="stale";}
      if(newSource(result.id)&&result.message.toolName==="bash"&&isTestCommand){
        const testItem:MemoryItem={id:`rc-test-${result.id}`,key:`test:${command.slice(0,300)}`,kind:"test",text:`Test command evidence: ${command.slice(0,300)}; tool error=${result.message.isError}; output source=${result.id}. Scope and current file version still require verification.`,status:result.message.isError?"stale":"active",authority:"tool-evidence",sourceEntryIds:[result.id],taskId:snapshot.focus.taskId,dependencies:changedPaths.map(path=>({path})),observedAtEntryId:result.id,pinned:false};
        upsert(testItem);
      }
      const dependencies=changedPaths.length?changedPaths.map(path=>({path})):call&&typeof call.arguments.path==="string"?[{path:call.arguments.path}]:[];
      const evidenceItem:MemoryItem={id:`rc-evidence-${result.id}`,key:`project:${dependencies.map(d=>d.path).join(",")||result.message.toolName}`,kind:"project",text:evidenceText,status:"active",authority:"tool-evidence",sourceEntryIds:[result.id,group.assistantId],taskId:snapshot.focus.taskId,dependencies,observedAtEntryId:result.id,pinned:false};
      if(newSource(result.id))upsert(evidenceItem);
      if(!capsule||original.length-capsule.length<config.minSavingTokens*4)continue;
      if(edits.some(e=>e.targetId===result.id&&e.replacementHash===hash(capsule)))continue;
      const edit={targetId:result.id,originalHash:hash(original),replacementHash:hash(capsule),warmTurn:turn};
      const replacement={...result.message,content:[{type:"text" as const,text:capsule}]};
      candidates.push({edit,draft:{type:"context_edit",targetId:result.id,replacement:{content:replacement.content}},saving:estimateTokens(result.message)-estimateTokens(replacement)});
    }
  }
  // Aging is recalculated each turn; prefix mutation is a batch, not housekeeping.
  const saving=candidates.reduce((n,c)=>n+c.saving,0);
  const cache=args.cache;
  const totalInput=cache?.input!==undefined&&cache.cacheRead!==undefined?cache.input+cache.cacheRead:undefined;
  const highCache=totalInput!==undefined&&totalInput>0&&cache!.cacheRead!/totalInput>=0.8;
  const batchThreshold=(config.minBatchSavingTokens??2048)*(highCache?2:1);
  const sinceWarm=turn-clock.lastWarmTurn;
  const normalBatch=sinceWarm>=(config.minWarmTurns??4)&&saving>=batchThreshold;
  const pressureBatch=projectedTokens>soft&&sinceWarm>=Math.max(2,Math.ceil((config.minWarmTurns??4)/2))&&saving>=(config.minBatchSavingTokens??2048)/2;
  if(candidates.length&&(emergency||pressureBatch||normalBatch)){
    for(const candidate of candidates){edits.push(candidate.edit);drafts.push(candidate.draft);}
  }
  const afterWarm=preview(drafts);
  if(!afterWarm)return [];
  const afterWarmTokens=estimateProjection(afterWarm);
  if(args.metrics)args.metrics.afterWarmTokens=afterWarmTokens;
  const maybeCheckpoint=afterWarmTokens>target&&(emergency||turn-clock.lastCheckpointTurn>=config.minCheckpointTurns);
  boundMemory(snapshot);
  // Generic assistant/tool history stays in L0, not a second transcript in L1.
  const covered=new Set(entries.filter(e=>e.messages.length>0&&e.messages.every(m=>m.role==="system"||m.role==="assistant"||m.role==="user"||m.role==="bashExecution"||m.role==="toolResult")).map(e=>e.sourceEntry.id));
  let checkpoint:StateEnvelope["checkpoint"];
  if(maybeCheckpoint) {
    const latest=entries.filter(e=>e.messages.some(m=>m.role==="user")).at(-1);
    const latestIndex=latest?entries.findIndex(e=>e.sourceEntry.id===latest.sourceEntry.id):-1;
    const recentIds=new Set(toolGroups.filter(group=>group.complete).slice(-3).map(group=>group.assistantId));
    const protectedIndices=toolGroups.filter(group=>!group.complete||!group.consumed||recentIds.has(group.assistantId)||(groupReasons.get(group.assistantId)??[]).some(r=>r==="PINNED_SOURCE"||r==="ACTIVE_PATH_DEPENDENCY")||(!emergency&&capsuleSafe(group)&&group.resultIds.some(id=>!committed.has(id)||turn-(committed.get(id)?.warmTurn??turn)<config.minCheckpointTurns))).map(group=>entries.findIndex(e=>e.sourceEntry.id===group.assistantId)).filter(index=>index>=0);
    for(const item of snapshot.items.filter(i=>i.pinned&&i.authority!=="user"))for(const id of item.sourceEntryIds){
      const group=toolGroups.find(g=>g.resultIds.includes(id));
      const index=entries.findIndex(e=>e.sourceEntry.id===(group?.assistantId??id));
      if(index>=0)protectedIndices.push(index);
    }
    const firstKeptIndex=protectedIndices.length?Math.min(...protectedIndices):(latestIndex<0?entries.length:latestIndex);
    const firstKept=entries[firstKeptIndex]?.sourceEntry.id;
    const hasImage=entries.slice(0,firstKeptIndex).some(e=>e.messages.some(m=>m.role==="user"&&Array.isArray(m.content)&&m.content.some(c=>c.type==="image")));
    const hasForeign=branch.some(e=>(e.type==="custom_message"&&e.customType!=="design-intent.projection.v1")||e.type==="branch_summary");
    const rawCutIndex=firstKept?branch.findIndex(entry=>entry.id===firstKept):-1;
    const rawPrefixIds=new Set(rawCutIndex>=0?branch.slice(0,rawCutIndex).map(entry=>entry.id):[]);
    const latestEdits=new Map<string,Extract<SessionEntry,{type:"context_edit"}>>();for(const entry of branch)if(entry.type==="context_edit")latestEdits.set(entry.targetId,entry);
    const hasForeignEdit=rawCutIndex<0||eventEntries.some(draft=>draft.type==="context_edit")||Array.from(rawPrefixIds).some(targetId=>{
      const edit=latestEdits.get(targetId);if(!edit)return false;if(!edit.replacement)return true;
      const content=edit.replacement.content;const text=typeof content==="string"?content:Array.isArray(content)&&content.every(part=>part.type==="text")?content.map(part=>part.type==="text"?part.text:"").join("\n"):undefined;
      return text===undefined||committed.get(targetId)?.replacementHash!==hash(text);
    });
    const hasExistingCompaction=[...eventEntries,...drafts].some(d=>d.type==="compaction");
    const unknownToolCrossed=toolGroups.some(group=>{
      const groupIndex=entries.findIndex(entry=>entry.sourceEntry.id===group.assistantId);
      return groupIndex>=0&&groupIndex<firstKeptIndex&&!checkpointSafe(group);
    });
    const contentCovered=!unknownToolCrossed&&entries.slice(0,firstKeptIndex).every(entry=>entry.messages.every(message=>{
      if(message.role==="system")return true;
      if(message.role==="custom")return message.customType==="design-intent.projection.v1"&&snapshot.intentRefs.some(ref=>ref.id);
      if(message.role==="compactionSummary")return ownedCheckpoint(entry.sourceEntry);
      if(message.role==="branchSummary")return false;
      return covered.has(entry.sourceEntry.id);
    }));
    if(firstKept&&!hasImage&&!hasForeign&&!hasForeignEdit&&!hasExistingCompaction&&contentCovered&&snapshot.items.some(i=>i.authority==="agent-report"&&i.status==="active"&&!i.id.startsWith("rc-assistant-"))) {
      const summary=renderCheckpoint(snapshot);
      const keptTokens=estimateProjection(afterWarm.filter(e=>entries.slice(firstKeptIndex).some(k=>k.sourceEntry.id===e.sourceEntry.id)));
      const candidateTokens=keptTokens+Math.ceil(summary.length/4);
      if(candidateTokens<afterWarmTokens&&candidateTokens<=target){
        const candidate={type:"compaction" as const,summary,firstKeptEntryId:firstKept,details:{type:CHECKPOINT_TYPE,turn,reason:emergency?"hard":"after-warm-budget",planId:hash([sessionId,baseLeaf,snapshot.revision,summary]).slice(0,24),stateRevision:snapshot.revision,firstKeptEntryId:firstKept,summaryHash:hash(summary)}};
        drafts.push(candidate); checkpoint={firstKeptEntryId:firstKept,summaryHash:hash(summary)};
        const checked=preview(drafts);
        if(!checked||estimateProjection(checked)>target||estimateProjection(checked)>=afterWarmTokens){drafts.pop();checkpoint=undefined;}
      }
    }
  }
  const sourceIndices=new Map(entries.map((entry,index)=>[entry.sourceEntry.id,index]));
  const retainedFrom=checkpoint?entries.findIndex(entry=>entry.sourceEntry.id===checkpoint!.firstKeptEntryId):Number.POSITIVE_INFINITY;
  const dispositions=new Map<string,"retained"|"extracted"|"recall-only">();
  for(const id of covered)dispositions.set(id,"recall-only");
  for(const item of snapshot.items)for(const sourceEntryId of item.sourceEntryIds){
    const index=sourceIndices.get(sourceEntryId);
    if(index!==undefined)dispositions.set(sourceEntryId,checkpoint&&index>=retainedFrom?"retained":"extracted");
  }
  snapshot.coverage=[...dispositions].slice(-64).map(([sourceEntryId,disposition])=>({sourceEntryId,disposition}));
  snapshot.coveredThroughEntryId=entries.filter(entry=>entry.messages.length>0).at(-1)?.sourceEntry.id??snapshot.coveredThroughEntryId;
  boundMemory(snapshot);
  if(checkpoint){const cut=branch.findIndex(e=>e.id===checkpoint!.firstKeptEntryId);const cold=new Set(branch.slice(0,cut).map(e=>e.id));for(let i=edits.length-1;i>=0;i--)if(cold.has(edits[i].targetId)&&edits[i].warmTurn!==turn)edits.splice(i,1);}
  if(!drafts.length&&hash(snapshot)===hash(state.snapshot)&&hash(edits)===hash(state.envelope?.edits??[]))return [];
  snapshot.revision=state.snapshot.revision+1;
  const planId=hash([sessionId,baseLeaf,snapshot.revision,edits.map(e=>e.replacementHash),checkpoint]).slice(0,24);
  const envelope:StateEnvelope={schemaVersion:1,revision:snapshot.revision,planId,baseLeafId:baseLeaf,snapshot,edits,checkpoint:checkpoint??state.envelope?.checkpoint};
  const stateBytes=serializedStateBytes(envelope);
  if(args.metrics)args.metrics.attemptedStateBytes=stateBytes;
  if(stateBytes>MAX_STATE_BYTES){if(args.metrics)args.metrics.rejection="STATE_SIZE_LIMIT";return [];}
  const finalProjection=preview(drafts);
  if(!finalProjection||checkpoint&&estimateProjection(finalProjection)>target){if(args.metrics)args.metrics.rejection="INVALID_FINAL_PROJECTION";return [];}
  if(args.metrics)args.metrics.afterCheckpointTokens=estimateProjection(finalProjection);
  for(const draft of drafts)if(draft.type==="compaction"&&(draft.details as any)?.type===CHECKPOINT_TYPE)Object.assign(draft.details as object,{stateEnvelope:envelope,stateRevision:envelope.revision,planId:envelope.planId});
  drafts.unshift({type:"custom",customType:STATE_TYPE,data:envelope});
  return drafts;
}
export function previewDrafts(cwd:string,header:any,branch:SessionEntry[],drafts:SessionBoundaryDraft[]):ProjectedSessionEntry[]|undefined {
  try {
    const manager=SessionManager.inMemory(cwd,undefined,[header,...branch]);
    for(const draft of drafts) {
      switch(draft.type) {
        case "custom": manager.appendCustomEntry(draft.customType,draft.data);break;
        case "custom_message": manager.appendCustomMessageEntry(draft.customType,draft.content,draft.display,draft.details);break;
        case "context_edit": manager.appendContextEdit(draft.targetId,draft.replacement);break;
        case "compaction": manager.appendCompaction(draft.summary,draft.firstKeptEntryId,0,draft.details,true,draft.usage);break;
      }
    }
    return manager.buildSessionProjection().entries;
  } catch { return; }
}
