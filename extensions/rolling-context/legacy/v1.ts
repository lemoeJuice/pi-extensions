import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ProjectedSessionEntry, SessionEntry, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { estimateTokens, SessionManager } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";

export const STATE_TYPE = "rolling-context.state.v1";
export const NOTE_TYPE = "rolling-context.note.v1";
export const CHECKPOINT_TYPE = "rolling-context.checkpoint.v1";
export const TELEMETRY_TYPE = "rolling-context.telemetry.v1";
export const MAX_STATE_BYTES=128*1024;
export const CHECKPOINT_BLOCK_CODES=["MISSING_CONTINUITY_STATE","CHECKPOINT_CADENCE","WARM_REQUIRED","WARM_RESIDENCE","ACTIVE_DEPENDENCY","UNRESOLVED_ERROR","UNSUPPORTED_CONTENT","IMAGE","FOREIGN_EDIT","NO_SAFE_BOUNDARY","NO_NET_SAVING","STATE_SIZE_LIMIT","INVALID_FINAL_PROJECTION"] as const;
export function serializedStateBytes(value:unknown):number{return new TextEncoder().encode(JSON.stringify(value)).byteLength;}

export interface MemoryItem {
  id: string;
  key: string;
  kind: "constraint" | "project" | "task-decision" | "change" | "test" | "task" | "focus";
  text: string;
  status: "active" | "resolved" | "superseded" | "stale";
  authority: "user" | "tool-evidence" | "agent-report" | "inference";
  sourceEntryIds: string[];
  sourceSpan?: { start: number; end: number };
  taskId: string;
  dependencies: Array<{ path: string; observedHash?: string }>;
  observedAtEntryId: string;
  supersedes?: string[];
  pinned: boolean;
  pinReason?: "current-request" | "user-constraint" | "task-goal" | "explicit";
}
export interface IntentReference {
  storePath: string; storeRevision: number; sourceHash: string; id: string; projection?: string;
}
export interface MemorySnapshot {
  schemaVersion: 1; revision: number; coveredThroughEntryId: string;
  items: MemoryItem[]; intentRefs: IntentReference[];
  focus: {
    taskId: string;
    nextSteps: string[];
    openQuestions: string[];
    goal?: { text: string; authority: "user" | "inference"; sourceEntryIds: string[]; sourceSpan?: { start: number; end: number } };
  };
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
  checkpointWanted?:boolean;
  checkpointCandidate?:boolean;
  checkpointBlockedBy?:string[];
  checkpointReason?:string|null;
  checkpointBoundaryEntryId?:string|null;
  checkpointKeptTokens?:number|null;
  checkpointEstimatedTokens?:number|null;
  checkpointPreviewTokens?:number|null;
  protectedTokens?:number;
  protectedTokensByReason?:Record<string,number>;
  eligibleHistoricalTokens?:number;
  warmSourceTokens?:number;
  warmCapsuleTokens?:number;
  warmTokensSaved?:number;
  earliestMutationPosition?:number|null;
  earliestMutationEntryId?:string|null;
  projectedTokensBeforeMutation?:number|null;
  estimatedInvalidatedSuffixTokens?:number;
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
const USER_CONSTRAINT = /\b(?:must|must not|mustn't|shall|shall not|do not|don't|never|avoid|preserve|keep\s+(?:the|its|all|existing|public)|without changing|only|requires?|should not|shouldn't)\b|(?:必须|务必|不得|不能|禁止|请勿|不要|保留|保持|不得改变|不要改变|必须保留)/i;
function userText(message:Extract<AgentMessage,{role:"user"}>):string {
  return typeof message.content==="string"?message.content:message.content.filter((part:any)=>part.type==="text").map((part:any)=>part.text).join("\n");
}
function ordinaryFollowUp(text:string):boolean {
  return /^\s*(?:continue|go on|keep going|look at this|please look at this|check this|this (?:effect|result) (?:is|looks) (?:bad|not good)|this doesn.t work|继续|接着来|你看一下这个|看一下这个|这个效果不好|这个不太好|这个不行)[\s.!?。！？]*$/iu.test(text);
}
export function explicitUserConstraints(text:string):Array<{text:string;start:number;end:number}> {
  const out:Array<{text:string;start:number;end:number}>=[];
  const expression=/[^\n.!?。！？]+[.!?。！？]?|\n/g;
  for(const match of text.matchAll(expression)){
    const value=match[0],start=match.index??0;
    if(!value.trim()||!USER_CONSTRAINT.test(value))continue;
    const left=value.search(/\S/),right=value.trimEnd().length;
    const content=value.slice(left,right);
    if(content)out.push({text:content,start:start+left,end:start+right});
  }
  return out;
}
export function continuitySufficient(snapshot:MemorySnapshot):boolean {
  return snapshot.items.some(item=>item.status==="active"&&item.authority==="agent-report"&&["task","focus","task-decision"].includes(item.kind))||
    snapshot.items.some(item=>item.id==="rc-fallback-continuity"&&item.status==="active"&&!!snapshot.focus.goal&&snapshot.focus.nextSteps.length>0);
}
/** Bounded, extractive fallback. It never scans earlier than the recent active window or upgrades a report to verified evidence. */
export function extractContinuityFallback(entries:ProjectedSessionEntry[],snapshot:MemorySnapshot):{ok:boolean;sourceEntryIds:string[]} {
  if(continuitySufficient(snapshot))return{ok:true,sourceEntryIds:[]};
  const window=entries.slice(-12);
  const windowChars=window.reduce((n,entry)=>n+entry.messages.reduce((m,message)=>m+(message.role==="user"||message.role==="assistant"?typeof message.content==="string"?message.content.length:Array.isArray(message.content)?message.content.reduce((x,part:any)=>x+(part.type==="text"?part.text.length:0),0):0:0),0),0);
  if(windowChars>12000)return{ok:false,sourceEntryIds:[]};
  const latestUser=[...window].reverse().flatMap(entry=>entry.messages.filter((message):message is Extract<AgentMessage,{role:"user"}>=>message.role==="user").map(message=>({entry,message,text:userText(message)})))[0];
  if(!latestUser||!latestUser.text.trim()||latestUser.text.length>8192)return{ok:false,sourceEntryIds:[]};
  const latestAssistant=[...window].reverse().flatMap(entry=>entry.messages.filter((message):message is Extract<AgentMessage,{role:"assistant"}>=>message.role==="assistant").map(message=>({entry,message}))).find(({message})=>message.content.some(part=>part.type==="text"));
  const report=latestAssistant?.message.content.filter((part):part is Extract<typeof part,{type:"text"}>=>part.type==="text").map(part=>part.text).join("\n").trim().slice(0,900);
  const requestId=latestUser.entry.sourceEntry.id;
  if(!snapshot.focus.taskId)snapshot.focus.taskId=`RC-T-${requestId}`;
  snapshot.focus.goal={text:latestUser.text,authority:"user",sourceEntryIds:[requestId],sourceSpan:{start:0,end:latestUser.text.length}};
  snapshot.items=snapshot.items.filter(item=>!(item.key==="latest-user-request"&&item.pinReason==="current-request"));
  const requestItem:MemoryItem={id:`rc-current-request-${requestId}`,key:"latest-user-request",kind:"task",text:latestUser.text,status:"active",authority:"user",sourceEntryIds:[requestId],sourceSpan:{start:0,end:latestUser.text.length},taskId:snapshot.focus.taskId||`RC-T-${requestId}`,dependencies:[],observedAtEntryId:requestId,pinned:true,pinReason:"current-request"};
  if(!snapshot.items.some(item=>item.id===requestItem.id))snapshot.items.push(requestItem);
  for(const [index,span] of explicitUserConstraints(latestUser.text).entries()){
    const id=`rc-constraint-${requestId}-${index}`;
    if(!snapshot.items.some(item=>item.id===id))snapshot.items.push({id,key:`user-constraint:${requestId}:${index}`,kind:"constraint",text:span.text,status:"active",authority:"user",sourceEntryIds:[requestId],sourceSpan:{start:span.start,end:span.end},taskId:snapshot.focus.taskId||`RC-T-${requestId}`,dependencies:[],observedAtEntryId:requestId,pinned:true,pinReason:"user-constraint"});
  }
  const nextStep="Continue the current user request; verify any reported state against current evidence before relying on it.";
  snapshot.focus.nextSteps=[nextStep];
  const sourceEntryIds=[requestId,...(latestAssistant?[latestAssistant.entry.sourceEntry.id]:[])];
  const text=["Bounded checkpoint fallback; extracted from the latest 12 projected entries only.",report?`Recent assistant report (unverified): ${report}`:"No recent assistant report was available; no progress fact inferred.",`Inferred next step: ${nextStep}`].join("\n");
  const item:MemoryItem={id:"rc-fallback-continuity",key:"fallback:continuity",kind:"task",text,status:"active",authority:"inference",sourceEntryIds:[...new Set(sourceEntryIds)],taskId:snapshot.focus.taskId||`RC-T-${requestId}`,dependencies:[],observedAtEntryId:latestAssistant?.entry.sourceEntry.id??requestId,pinned:false};
  const old=snapshot.items.findIndex(candidate=>candidate.id===item.id);if(old>=0)snapshot.items.splice(old,1);snapshot.items.push(item);
  return{ok:true,sourceEntryIds:item.sourceEntryIds};
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
  const notedNextSteps=snapshot.items.filter(i=>i.status==="active"&&i.key.startsWith("next-step:")).slice(-3).map(i=>i.text);
  const fallback=snapshot.items.find(i=>i.id==="rc-fallback-continuity"&&i.status==="active");
  if(notedNextSteps.length)snapshot.focus.nextSteps=notedNextSteps;
  else if(fallback?.text)snapshot.focus.nextSteps=[fallback.text.split("\n").at(-1)!.replace(/^Inferred next step: /,"")];
}
export function contextComposition(entries:ProjectedSessionEntry[],warmIds:Set<string>):{hotTokens:number;warmTokens:number;checkpointTokens:number;otherTokens:number} {
  const result={hotTokens:0,warmTokens:0,checkpointTokens:0,otherTokens:0};
  for(const entry of entries)for(const message of entry.messages){
    const key=message.role==="compactionSummary"?"checkpointTokens":warmIds.has(entry.sourceEntry.id)?"warmTokens":["user","assistant","toolResult","bashExecution"].includes(message.role)?"hotTokens":"otherTokens";
    result[key]+=estimateTokens(message);
  }
  return result;
}
export function warmEffectiveness(entries:ProjectedSessionEntry[],branch:SessionEntry[],warmIds:Set<string>):{warmSourceTokens:number;warmCapsuleTokens:number;warmTokensSaved:number} {
  const rawById=new Map(branch.filter((entry):entry is Extract<SessionEntry,{type:"message"}>=>(entry.type==="message"&&entry.message.role==="toolResult")).map(entry=>[entry.id,estimateTokens(entry.message)]));
  let warmSourceTokens=0,warmCapsuleTokens=0;
  for(const entry of entries)if(warmIds.has(entry.sourceEntry.id)){
    const source=rawById.get(entry.sourceEntry.id);if(source===undefined)continue;
    warmSourceTokens+=source;warmCapsuleTokens+=entry.messages.reduce((n,message)=>n+estimateTokens(message),0);
  }
  return{warmSourceTokens,warmCapsuleTokens,warmTokensSaved:Math.max(0,warmSourceTokens-warmCapsuleTokens)};
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
export function checkpointSafe(group:Group):boolean {
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
    if(group.results.some(result=>result.message.isError))reasons.push("UNRESOLVED_ERROR");
    else if(group.complete&&group.consumed&&!checkpointSafe(group))reasons.push("UNSUPPORTED_CONTENT");
    if(group.results.some(result=>Array.isArray(result.message.content)&&result.message.content.some(part=>part.type==="image")))reasons.push("IMAGE");
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
  const latest=active.find(i=>i.key==="latest-user-request");
  const constraints=active.filter(i=>i.kind==="constraint").map(i=>`- ${i.text} [user source=${i.sourceEntryIds.join(",")}${i.sourceSpan?`; span=${i.sourceSpan.start}:${i.sourceSpan.end}`:""}]`).join("\n")||"- 无";
  const goal=snapshot.focus.goal?`${snapshot.focus.goal.authority==="inference"?"[inferred; not verified] ":""}${snapshot.focus.goal.text} [source=${snapshot.focus.goal.sourceEntryIds.join(",")}${snapshot.focus.goal.sourceSpan?`; span=${snapshot.focus.goal.sourceSpan.start}:${snapshot.focus.goal.sourceSpan.end}`:""}]`:snapshot.focus.taskId||"当前任务";
  return ["[Rolling Context checkpoint v1]",`目标/焦点：${goal}`,"最新用户请求（精确保留，带来源）：",latest?`- ${latest.text} [source=${latest.sourceEntryIds.join(",")}]`:"- 未记录","明确用户约束（精确片段与来源）：",constraints,"任务计划/连续性：",by("task"),"当前焦点：",by("focus"),"阻塞/待确认：",snapshot.focus.openQuestions.join("\n")||"- 未记录","文件/项目观察与工具证据（带来源，需按当前状态核验）：",by("project"),"相关 Design Intent（只读历史投影；设计敏感操作前必须重新查询当前文件）：",snapshot.intentRefs.length?snapshot.intentRefs.map(i=>`- ${i.id} @ ${i.storeRevision} (${i.sourceHash.slice(0,12)})${i.projection?`: ${i.projection}`:""}`).join("\n"):"- 未查询或未配置", "当前任务执行决策 (task-decision)：",by("task-decision"),"修改/验证/错误状态：",[...by("change").split("\n"),...by("test").split("\n")].join("\n"),"下一步：",snapshot.focus.nextSteps.map((s,i)=>`${i+1}. ${s}`).join("\n")||"- 未指定","历史证据仅可按当前分支来源召回；过期/待核验内容不可视为当前事实。"].join("\n");
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
  if(!snapshot.focus.taskId){const firstUser=entries.find(e=>e.messages.some(m=>m.role==="user"));if(firstUser)snapshot.focus.taskId=`RC-T-${firstUser.sourceEntry.id}`;}
  const priorLatestIndex=snapshot.items.findIndex(item=>item.key==="latest-user-request"&&item.pinReason==="current-request");
  const priorLatest=priorLatestIndex>=0?snapshot.items[priorLatestIndex]:undefined;
  snapshot.items=snapshot.items.filter(item=>!(item.key==="latest-user-request"&&item.pinReason==="current-request"));
  const coveredIndex=branch.findIndex(e=>e.id===snapshot.coveredThroughEntryId);
  const newSource=(id:string)=>coveredIndex<0||branch.findIndex(e=>e.id===id)>coveredIndex;
  // Migrate only unambiguous low-risk legacy follow-ups. Unknown legacy pins remain protected.
  const retainedItems:MemoryItem[]=[],migratedItems:MemoryItem[]=[];
  for(const item of snapshot.items.slice()){
    if(!item.id.startsWith("rc-user-")||item.pinReason==="explicit"){retainedItems.push(item);continue;}
    const sourceId=item.sourceEntryIds[0];
    const source=entries.find(entry=>entry.sourceEntry.id===sourceId);
    const message=source?.messages.find((candidate):candidate is Extract<AgentMessage,{role:"user"}>=>candidate.role==="user");
    if(message&&ordinaryFollowUp(userText(message)))continue;
    const spans=message?explicitUserConstraints(userText(message)):[];
    if(spans.length){
      for(const [index,span] of spans.entries())if(!snapshot.items.some(candidate=>candidate.id===`rc-constraint-${sourceId}-${index}`))migratedItems.push({id:`rc-constraint-${sourceId}-${index}`,key:`user-constraint:${sourceId}:${index}`,kind:"constraint",text:span.text,status:"active",authority:"user",sourceEntryIds:[sourceId],sourceSpan:{start:span.start,end:span.end},taskId:item.taskId,dependencies:[],observedAtEntryId:sourceId,pinned:true,pinReason:"user-constraint"});
      continue;
    }
    const initial=sourceId===snapshot.focus.taskId.replace(/^RC-T-/ ,"");
    if(message&&initial&&!snapshot.items.some(candidate=>candidate.key==="initial-task-goal")){
      const text=userText(message);
      migratedItems.push({id:`rc-task-goal-${sourceId}`,key:"initial-task-goal",kind:"task",text,status:"active",authority:"user",sourceEntryIds:[sourceId],sourceSpan:{start:0,end:text.length},taskId:item.taskId,dependencies:[],observedAtEntryId:sourceId,pinned:true,pinReason:"task-goal"});
      continue;
    }
    retainedItems.push(item);
  }
  snapshot.items=[...retainedItems,...migratedItems];
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
  }
  const users=entries.flatMap(entry=>entry.messages.filter((message):message is Extract<AgentMessage,{role:"user"}>=>message.role==="user").map(message=>({entry,message,text:userText(message)})));
  const latestUser=users.at(-1);
  for(const candidate of users){
    const sourceId=candidate.entry.sourceEntry.id;
    const isLatest=candidate===latestUser;
    const initialGoal=sourceId===snapshot.focus.taskId.replace(/^RC-T-/ ,"")&&!snapshot.focus.goal;
    const hasLegacy=state.snapshot.items.some(item=>item.id===`rc-user-${sourceId}`);
    if(!candidate.text.trim())continue;
    const shouldExtract=isLatest||initialGoal||newSource(sourceId)||hasLegacy;
    if(!shouldExtract)continue;
    const spans=explicitUserConstraints(candidate.text);
    for(const [index,span] of spans.entries()){
      const id=`rc-constraint-${sourceId}-${index}`;
      if(!snapshot.items.some(item=>item.id===id))snapshot.items.push({id,key:`user-constraint:${sourceId}:${index}`,kind:"constraint",text:span.text,status:"active",authority:"user",sourceEntryIds:[sourceId],sourceSpan:{start:span.start,end:span.end},taskId:snapshot.focus.taskId||`RC-T-${sourceId}`,dependencies:[],observedAtEntryId:sourceId,pinned:true,pinReason:"user-constraint"});
    }
    if(initialGoal||!snapshot.focus.goal)snapshot.focus.goal={text:candidate.text,authority:"user",sourceEntryIds:[sourceId],sourceSpan:{start:0,end:candidate.text.length}};
    if(isLatest){
      const request:MemoryItem={id:`rc-current-request-${sourceId}`,key:"latest-user-request",kind:"task",text:candidate.text,status:"active",authority:"user",sourceEntryIds:[sourceId],sourceSpan:{start:0,end:candidate.text.length},taskId:snapshot.focus.taskId||`RC-T-${sourceId}`,dependencies:[],observedAtEntryId:sourceId,pinned:true,pinReason:"current-request"};
      if(priorLatest?.sourceEntryIds.includes(sourceId))snapshot.items.splice(Math.min(priorLatestIndex,snapshot.items.length),0,request);else snapshot.items.push(request);
    }
    if(hasLegacy&&!spans.length&&!ordinaryFollowUp(candidate.text)&&sourceId===snapshot.focus.taskId.replace(/^RC-T-/ ,"")&&!snapshot.items.some(item=>item.key==="initial-task-goal")){
      const goal:MemoryItem={id:`rc-task-goal-${sourceId}`,key:"initial-task-goal",kind:"task",text:candidate.text,status:"active",authority:"user",sourceEntryIds:[sourceId],sourceSpan:{start:0,end:candidate.text.length},taskId:snapshot.focus.taskId,dependencies:[],observedAtEntryId:sourceId,pinned:true,pinReason:"task-goal"};
      snapshot.items=snapshot.items.filter(item=>item.id!==`rc-user-${sourceId}`);snapshot.items.push(goal);
    }
  }
  if(priorLatest?.pinReason==="explicit")snapshot.items.push(priorLatest);
  boundMemory(snapshot);
  const toolGroups=groups(entries);
  const groupAnalysis=analyzeGroups(entries,snapshot);const groupReasons=new Map(groupAnalysis.map(group=>[group.assistantId,group.reasons]));
  const entryTokens=new Map(entries.map(entry=>[entry.sourceEntry.id,entry.messages.reduce((n,message)=>n+estimateTokens(message),0)]));
  const protectedIds=new Set<string>(),protectedTokensByReason:Record<string,number>={};let eligibleHistoricalTokens=0;
  for(const group of toolGroups){
    const ids=[group.assistantId,...group.resultIds];const reasons=groupReasons.get(group.assistantId)??[];
    if(!reasons.length){eligibleHistoricalTokens+=group.resultIds.reduce((n,id)=>n+(entryTokens.get(id)??0),0);continue;}
    for(const id of ids)protectedIds.add(id);
    for(const reason of reasons){const once=new Set(ids);protectedTokensByReason[reason]=(protectedTokensByReason[reason]??0)+[...once].reduce((n,id)=>n+(entryTokens.get(id)??0),0);}
  }
  const latestUserEntry=[...entries].reverse().find(entry=>entry.messages.some(message=>message.role==="user"));
  if(latestUserEntry){protectedIds.add(latestUserEntry.sourceEntry.id);protectedTokensByReason.LATEST_USER_REQUEST=entryTokens.get(latestUserEntry.sourceEntry.id)??0;}
  for(const entry of entries)if(entry.messages.some(message=>message.role==="user"&&Array.isArray(message.content)&&message.content.some(part=>part.type==="image"))){protectedIds.add(entry.sourceEntry.id);protectedTokensByReason.IMAGE=(protectedTokensByReason.IMAGE??0)+(entryTokens.get(entry.sourceEntry.id)??0);}
  if(args.metrics){args.metrics.eligibleHistoricalTokens=eligibleHistoricalTokens;args.metrics.protectedTokens=[...protectedIds].reduce((n,id)=>n+(entryTokens.get(id)??0),0);args.metrics.protectedTokensByReason=protectedTokensByReason;}
  const edits=[...committed.values()].filter(edit=>entries.some(e=>e.sourceEntry.id===edit.targetId&&e.messages.length)).map(({replacement,...edit})=>({...edit,warmTurn:edit.warmTurn??clock.turn}));
  const candidates:Array<{edit:StateEnvelope["edits"][number];draft:SessionBoundaryDraft;saving:number;position:number;entryId:string;sourceTokens:number;capsuleTokens:number}>=[];
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
      const position=entries.findIndex(entry=>entry.sourceEntry.id===result.id);
      const sourceTokens=estimateTokens(result.message),capsuleTokens=estimateTokens(replacement);
      candidates.push({edit,draft:{type:"context_edit",targetId:result.id,replacement:{content:replacement.content}},saving:Math.max(0,sourceTokens-capsuleTokens),position,entryId:result.id,sourceTokens,capsuleTokens});
    }
  }
  // Pay prefix invalidation once at a forward-moving warm frontier, then age the
  // eligible evidence behind it as one batch instead of repeatedly editing suffixes.
  const cache=args.cache;
  const totalInput=cache?.input!==undefined&&cache.cacheRead!==undefined?cache.input+cache.cacheRead:undefined;
  const highCache=totalInput!==undefined&&totalInput>0&&cache!.cacheRead!/totalInput>=0.8;
  const batchThreshold=(config.minBatchSavingTokens??2048)*(highCache?2:1);
  const sinceWarm=turn-clock.lastWarmTurn;
  const lastWarmPositions=[...committed.values()].filter(edit=>(edit.warmTurn??0)===clock.lastWarmTurn).map(edit=>entries.findIndex(entry=>entry.sourceEntry.id===edit.targetId)).filter(index=>index>=0);
  const warmFrontier=lastWarmPositions.length?Math.max(...lastWarmPositions):-1;
  const allowBackfill=projectedTokens>target;
  const eligible=candidates.filter(candidate=>allowBackfill||candidate.position>warmFrontier).sort((a,b)=>a.position-b.position);
  const expectedResidenceTurns=Math.max(1,config.minCheckpointTurns);
  let selected:{batch:typeof eligible;score:number;position:number;before:number;suffix:number}|undefined;
  const cacheOverride=projectedTokens>target||emergency;
  for(const first of eligible){
    const batch=eligible.filter(candidate=>candidate.position>=first.position);
    const before=entries.slice(0,first.position).reduce((sum,entry)=>sum+entry.messages.reduce((n,message)=>n+estimateTokens(message),0),0);
    const suffix=Math.max(0,projectedTokens-before);
    const benefit=batch.reduce((sum,candidate)=>sum+candidate.saving,0)*expectedResidenceTurns;
    const score=benefit-suffix;
    if(cacheOverride){if(!selected)selected={batch,score,position:first.position,before,suffix};continue;}
    if((score>0||cacheOverride&&batch.some(candidate=>candidate.saving>0))&&(!selected||score>selected.score||score===selected.score&&first.position>selected.position))selected={batch,score,position:first.position,before,suffix};
  }
  const saving=selected?.batch.reduce((n,c)=>n+c.saving,0)??0;
  const normalBatch=sinceWarm>=(config.minWarmTurns??4)&&saving>=batchThreshold;
  const pressureBatch=projectedTokens>soft&&sinceWarm>=Math.max(2,Math.ceil((config.minWarmTurns??4)/2))&&saving>=(config.minBatchSavingTokens??2048)/2;
  const warmAllowed=!!selected&&selected.batch.length>0&&(emergency||pressureBatch||normalBatch);
  if(args.metrics){
    args.metrics.warmSourceTokens=warmAllowed?selected!.batch.reduce((n,c)=>n+c.sourceTokens,0):0;
    args.metrics.warmCapsuleTokens=warmAllowed?selected!.batch.reduce((n,c)=>n+c.capsuleTokens,0):0;
    args.metrics.warmTokensSaved=warmAllowed?saving:0;
    args.metrics.earliestMutationPosition=warmAllowed?selected!.position:null;
    args.metrics.earliestMutationEntryId=warmAllowed?selected!.batch.find(c=>c.position===selected!.position)?.entryId??null:null;
    args.metrics.projectedTokensBeforeMutation=warmAllowed?selected!.before:null;
    args.metrics.estimatedInvalidatedSuffixTokens=warmAllowed?selected!.suffix:0;
  }
  if(warmAllowed)for(const candidate of selected!.batch){edits.push(candidate.edit);drafts.push(candidate.draft);}
  const afterWarm=preview(drafts);
  if(!afterWarm)return [];
  const afterWarmTokens=estimateProjection(afterWarm);
  if(args.metrics)args.metrics.afterWarmTokens=afterWarmTokens;
  const checkpointWanted=afterWarmTokens>target;
  const cadenceReady=emergency||turn-clock.lastCheckpointTurn>=config.minCheckpointTurns;
  const maybeCheckpoint=checkpointWanted&&cadenceReady;
  if(args.metrics){
    args.metrics.checkpointWanted=checkpointWanted;
    args.metrics.checkpointBlockedBy=checkpointWanted&&!cadenceReady?["CHECKPOINT_CADENCE"]:[];
    args.metrics.checkpointCandidate=false;
    args.metrics.checkpointReason=null;
  }
  boundMemory(snapshot);
  // Generic assistant/tool history stays in L0, not a second transcript in L1.
  const covered=new Set(entries.filter(e=>e.messages.length>0&&e.messages.every(m=>m.role==="system"||m.role==="assistant"||m.role==="user"||m.role==="bashExecution"||m.role==="toolResult")).map(e=>e.sourceEntry.id));
  let checkpoint:StateEnvelope["checkpoint"];
  if(maybeCheckpoint) {
    const block=(code:string)=>{if(args.metrics){const list=args.metrics.checkpointBlockedBy??[];if(!list.includes(code))args.metrics.checkpointBlockedBy=[...list,code];}};
    if(!continuitySufficient(snapshot)){
      const extracted=extractContinuityFallback(entries,snapshot);
      if(!extracted.ok)block("MISSING_CONTINUITY_STATE");
    }
    const latest=entries.filter(entry=>entry.messages.some(message=>message.role==="user")).at(-1);
    const latestIndex=latest?entries.findIndex(entry=>entry.sourceEntry.id===latest.sourceEntry.id):-1;
    const protectedIndices:number[]=[];
    const residence=Math.max(1,config.minCheckpointTurns);
    for(const group of toolGroups){
      const reasons=groupReasons.get(group.assistantId)??[];
      if(reasons.length){const index=entries.findIndex(entry=>entry.sourceEntry.id===group.assistantId);if(index>=0)protectedIndices.push(index);}
      const warmSources=group.resultIds.map(id=>edits.find(edit=>edit.targetId===id)).filter((edit):edit is StateEnvelope["edits"][number]=>!!edit);
      const hasYoungWarm=warmSources.some(edit=>turn-(edit.warmTurn??turn)<residence);
      if(hasYoungWarm&&!emergency){const index=entries.findIndex(entry=>entry.sourceEntry.id===group.assistantId);if(index>=0)protectedIndices.push(index);block("WARM_RESIDENCE");}
      const hasUnwarmedValuable=group.results.some(result=>{
        if(edits.some(edit=>edit.targetId===result.id)||committed.has(result.id))return false;
        const original=textContent(result.message),capsule=makeCapsule(group,branch,result.id);
        return !!original&&!!capsule&&original.length-capsule.length>=config.minSavingTokens*4;
      });
      if(hasUnwarmedValuable&&!emergency){const index=entries.findIndex(entry=>entry.sourceEntry.id===group.assistantId);if(index>=0)protectedIndices.push(index);block("WARM_REQUIRED");}
    }
    for(const entry of entries)if(entry.messages.some(message=>message.role==="user"&&Array.isArray(message.content)&&message.content.some(part=>part.type==="image"))){const index=entries.findIndex(candidate=>candidate.sourceEntry.id===entry.sourceEntry.id);if(index>=0)protectedIndices.push(index);}
    for(const entry of entries)if(entry.sourceEntry.type==="custom_message"&&entry.sourceEntry.customType!=="design-intent.projection.v1"||entry.messages.some(message=>message.role==="branchSummary")){const index=entries.findIndex(candidate=>candidate.sourceEntry.id===entry.sourceEntry.id);if(index>=0)protectedIndices.push(index);}
    for(const item of snapshot.items.filter(candidate=>candidate.pinned&&candidate.authority!=="user"))for(const id of item.sourceEntryIds){
      const group=toolGroups.find(candidate=>candidate.resultIds.includes(id));
      const index=entries.findIndex(entry=>entry.sourceEntry.id===(group?.assistantId??id));if(index>=0)protectedIndices.push(index);
    }
    if(latestIndex>=0&&entries[latestIndex].messages.some(message=>message.role==="user"&&Array.isArray(message.content)&&message.content.some(part=>part.type==="image")))protectedIndices.push(latestIndex);
    const lastAssistantIndex=entries.findLastIndex(entry=>entry.messages.some(message=>message.role==="assistant"));
    const firstKeptIndex=protectedIndices.length?Math.min(...protectedIndices):latestIndex>=0?Math.max(latestIndex+1,lastAssistantIndex):lastAssistantIndex;
    const firstKept=firstKeptIndex>=0?entries[firstKeptIndex]?.sourceEntry.id:undefined;
    if(!firstKept){block("NO_SAFE_BOUNDARY");}
    const prefix=firstKept?entries.slice(0,firstKeptIndex):[];
    const hasImage=prefix.some(entry=>entry.messages.some(message=>message.role==="user"&&Array.isArray(message.content)&&message.content.some(part=>part.type==="image")));
    if(hasImage)block("IMAGE");
    const hasForeign=prefix.some(entry=>(entry.sourceEntry.type==="custom_message"&&entry.sourceEntry.customType!=="design-intent.projection.v1")||entry.sourceEntry.type==="branch_summary");
    if(hasForeign)block("UNSUPPORTED_CONTENT");
    const rawCutIndex=firstKept?branch.findIndex(entry=>entry.id===firstKept):-1;
    const rawPrefixIds=new Set(rawCutIndex>=0?branch.slice(0,rawCutIndex).map(entry=>entry.id):[]);
    const latestEdits=new Map<string,Extract<SessionEntry,{type:"context_edit"}>>();for(const entry of branch)if(entry.type==="context_edit")latestEdits.set(entry.targetId,entry);
    const hasForeignEdit=rawCutIndex<0||Array.from(rawPrefixIds).some(targetId=>{
      const edit=latestEdits.get(targetId);if(!edit)return false;if(!edit.replacement)return true;
      const content=edit.replacement.content;const text=typeof content==="string"?content:Array.isArray(content)&&content.every(part=>part.type==="text")?content.map(part=>part.type==="text"?part.text:"").join("\n"):undefined;
      return text===undefined||committed.get(targetId)?.replacementHash!==hash(text);
    });
    if(hasForeignEdit)block("FOREIGN_EDIT");
    const hasExistingCompaction=[...eventEntries,...drafts].some(draft=>draft.type==="compaction");
    const groupsByResult=new Map(toolGroups.flatMap(group=>group.resultIds.map(id=>[id,group] as const)));
    const unknownToolCrossed=prefix.some(entry=>entry.messages.some(message=>message.role==="toolResult"&&!(message.toolName==="context_note"&&(message.details as any)?.type===NOTE_TYPE&&snapshot.items.some(item=>item.sourceEntryIds.includes(entry.sourceEntry.id)))&&(!groupsByResult.get(entry.sourceEntry.id)||!checkpointSafe(groupsByResult.get(entry.sourceEntry.id)!))));
    if(unknownToolCrossed){const reasons=toolGroups.filter(group=>group.resultIds.some(id=>rawPrefixIds.has(id))).flatMap(group=>groupReasons.get(group.assistantId)??[]);for(const reason of reasons)block(reason);if(!reasons.length)block("UNSUPPORTED_CONTENT");}
    const contentCovered=!unknownToolCrossed&&prefix.every(entry=>entry.messages.every(message=>{
      if(message.role==="system")return true;
      if(message.role==="custom")return message.customType==="design-intent.projection.v1"&&snapshot.intentRefs.some(ref=>ref.id);
      if(message.role==="compactionSummary")return ownedCheckpoint(entry.sourceEntry);
      if(message.role==="branchSummary")return false;
      if(message.role==="user")return !(Array.isArray(message.content)&&message.content.some(part=>part.type==="image"));
      if(message.role==="toolResult"){if(message.toolName==="context_note"&&(message.details as any)?.type===NOTE_TYPE)return snapshot.items.some(item=>item.sourceEntryIds.includes(entry.sourceEntry.id));const group=groupsByResult.get(entry.sourceEntry.id);return !!group&&checkpointSafe(group);}
      if(message.role==="assistant")return message.content.every(part=>part.type==="text"||part.type==="thinking"||part.type==="toolCall");
      return covered.has(entry.sourceEntry.id)&&message.role==="bashExecution";
    }));
    if(!contentCovered&&!unknownToolCrossed&&!hasImage&&!hasForeign)block("UNSUPPORTED_CONTENT");
    const hasContinuity=continuitySufficient(snapshot);
    if(!hasContinuity)block("MISSING_CONTINUITY_STATE");
    if(!hasExistingCompaction&&firstKept&&contentCovered&&!hasImage&&!hasForeign&&!hasForeignEdit&&hasContinuity){
      const summary=renderCheckpoint(snapshot);
      const keptIds=new Set(entries.slice(firstKeptIndex).map(entry=>entry.sourceEntry.id));
      const keptTokens=estimateProjection(afterWarm.filter(entry=>keptIds.has(entry.sourceEntry.id)));
      const candidateTokens=keptTokens+Math.ceil(summary.length/4);
      if(args.metrics){args.metrics.checkpointBoundaryEntryId=firstKept;args.metrics.checkpointKeptTokens=keptTokens;args.metrics.checkpointEstimatedTokens=candidateTokens;}
      if(candidateTokens<afterWarmTokens){
        const reason=emergency?"hard":"after-warm-budget";
        const candidate={type:"compaction" as const,summary,firstKeptEntryId:firstKept,details:{type:CHECKPOINT_TYPE,turn,reason,planId:hash([sessionId,baseLeaf,snapshot.revision,summary]).slice(0,24),stateRevision:snapshot.revision,firstKeptEntryId:firstKept,summaryHash:hash(summary)}};
        drafts.push(candidate);checkpoint={firstKeptEntryId:firstKept,summaryHash:hash(summary)};
        const checked=preview(drafts);
        if(args.metrics)args.metrics.checkpointPreviewTokens=checked?estimateProjection(checked):null;
        if(!checked||estimateProjection(checked)>=afterWarmTokens){drafts.pop();checkpoint=undefined;block("NO_NET_SAVING");if(!checked)block("INVALID_FINAL_PROJECTION");}
        else if(args.metrics){args.metrics.checkpointCandidate=true;args.metrics.checkpointReason=reason;args.metrics.checkpointBlockedBy=[];}
      }else block("NO_NET_SAVING");
    }else if(!hasExistingCompaction&&!firstKept)block("NO_SAFE_BOUNDARY");
    else if(hasExistingCompaction)block("NO_SAFE_BOUNDARY");
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
  if(stateBytes>MAX_STATE_BYTES){if(args.metrics){args.metrics.rejection="STATE_SIZE_LIMIT";args.metrics.checkpointCandidate=false;args.metrics.checkpointBlockedBy=[...new Set([...(args.metrics.checkpointBlockedBy??[]),"STATE_SIZE_LIMIT"])]};return [];}
  const finalProjection=preview(drafts);
  if(!finalProjection||checkpoint&&estimateProjection(finalProjection)>=afterWarmTokens){if(args.metrics){args.metrics.rejection="INVALID_FINAL_PROJECTION";args.metrics.checkpointCandidate=false;args.metrics.checkpointBlockedBy=[...new Set([...(args.metrics.checkpointBlockedBy??[]),"INVALID_FINAL_PROJECTION"])]};return [];}
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
