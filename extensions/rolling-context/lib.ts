import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ProjectedSessionEntry, SessionEntry, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { estimateTokens, SessionManager } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";

export const STATE_TYPE = "rolling-context.state.v1";
export const NOTE_TYPE = "rolling-context.note.v1";
export const CHECKPOINT_TYPE = "rolling-context.checkpoint.v1";
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
  edits: Array<{targetId:string; originalHash:string; replacementHash:string; replacement:string}>;
  checkpoint?: {firstKeptEntryId:string; summaryHash:string};
}
export interface RollingConfig {
  mode: "observe" | "on" | "off";
  targetTokens: number;
  reserveTokens: number;
  contextWindow?: number;
  minSavingTokens: number;
  minCheckpointTurns: number;
  recallMaxTokens: number;
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
      if (candidate.revision >= snapshot.revision) { snapshot=candidate.snapshot; envelope=candidate; }
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
      if (!snapshot.items.some(i=>i.id===item.id)) snapshot.items.push(item);
      if (note.kind==="next-step") snapshot.focus.nextSteps=[...snapshot.focus.nextSteps,item.text].slice(-3);
    }
    if (entry.type === "message" && entry.message.role === "user" && !snapshot.focus.taskId) snapshot.focus.taskId=`RC-T-${entry.id}`;
    if (entry.type === "compaction" && (entry.details as any)?.type===CHECKPOINT_TYPE) {
      const details=entry.details as any;const data=details.stateEnvelope as StateEnvelope|undefined;const actualSummaryHash=hash(entry.summary);
      const validCheckpoint=data&&data.checkpoint?.firstKeptEntryId===entry.firstKeptEntryId&&data.checkpoint?.summaryHash===actualSummaryHash&&details.firstKeptEntryId===entry.firstKeptEntryId&&details.summaryHash===actualSummaryHash;
      if(data&&validCheckpoint&&validSnapshot(data.snapshot)&&data.revision>=snapshot.revision){snapshot=data.snapshot;envelope=data;}
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
  return ["[Rolling Context checkpoint v1]",`目标/焦点：${snapshot.focus.taskId||"当前任务"}`,"用户约束与任务计划：",by("constraint"),by("task"),"文件/项目观察与工具证据（带来源，需按当前状态核验）：",by("project"),"相关 Design Intent（只读历史投影；设计敏感操作前必须重新查询当前文件）：",snapshot.intentRefs.length?snapshot.intentRefs.map(i=>`- ${i.id} @ ${i.storeRevision} (${i.sourceHash.slice(0,12)})${i.projection?`: ${i.projection}`:""}`).join("\n"):"- 未查询或未配置", "当前任务执行决策 (task-decision)：",by("task-decision"),"修改/验证/错误状态：",[...by("change").split("\n"),...by("test").split("\n")].join("\n"),"下一步：",snapshot.focus.nextSteps.map((s,i)=>`${i+1}. ${s}`).join("\n")||"- 未指定","历史证据仅可按当前分支来源召回；过期/待核验内容不可视为当前事实。"].join("\n");
}
export function estimateProjection(entries:ProjectedSessionEntry[]):number {
  return entries.reduce((sum,e)=>sum+e.messages.reduce((n,m)=>n+estimateTokens(m),0),0);
}
export function planTurn(args:{entries:ProjectedSessionEntry[];branch:SessionEntry[];eventEntries:SessionBoundaryDraft[];baseLeaf:string|null;config:RollingConfig;state:ReturnType<typeof rebuild>;sessionId:string;currentTokens?:number|null}):SessionBoundaryDraft[] {
  const {entries,branch,eventEntries,baseLeaf,config,state,sessionId}=args;
  if(config.mode==="off")return [];
  const drafts:SessionBoundaryDraft[]=[];
  let snapshot=structuredClone(state.snapshot);
  if(!snapshot.focus.taskId){const firstUser=entries.find(e=>e.messages.some(m=>m.role==="user"));if(firstUser)snapshot.focus.taskId=`RC-T-${firstUser.sourceEntry.id}`;}
  for(const projected of entries){
    for(const message of projected.messages){
      const projection=message.role==="custom"&&message.customType==="design-intent.projection.v1"
        ? message.details as any
        : message.role==="toolResult"&&["design_intent_query","design_intent_get"].includes(message.toolName)
          ? (message.details as any)?.projection
          : undefined;
      if(projection?.type!=="design-intent.projection.v1"||projection.availability!=="ready"||typeof projection.storePath!=="string"||typeof projection.sourceHash!=="string"||!Number.isSafeInteger(projection.storeRevision))continue;
      for(const item of Array.isArray(projection.items)?projection.items:[]){
        if(typeof item?.id!=="string")continue;
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
  const edits=state.envelope?.edits? [...state.envelope.edits]:[];
  for(const group of toolGroups) {
    if(!group.consumed) continue;
    for(const result of group.results) {
      const capsuleAllowed=(groupReasons.get(group.assistantId)?.length??1)===0;
      const capsule=capsuleAllowed?makeCapsule(group,branch,result.id):undefined;
      const original=textContent(result.message);
      if(original===undefined)continue;
      const call=group.message.content.find((part):part is Extract<typeof part,{type:"toolCall"}>=>part.type==="toolCall"&&part.id===result.message.toolCallId);
      const args=call?JSON.stringify(call.arguments).slice(0,400):"{}";
      const output=original.length>1400?`${original.slice(0,1000)}\n[… output abbreviated; source ${result.id} …]\n${original.slice(-300)}`:original;
      const evidenceText=`[${result.message.toolName} evidence; call args=${args}; source entry=${result.id}; isError=${result.message.isError}]\n${output}`;
      const changes=(result.message.details as any)?.changes;
      const changedPaths=Array.isArray(changes)?changes.map((change:any)=>change?.path).filter((path:any):path is string=>typeof path==="string"):[];
      if(result.message.toolName==="edit"&&changedPaths.length){
        for(const item of snapshot.items)if((item.dependencies.some(dep=>changedPaths.includes(dep.path))||item.kind==="test"&&item.dependencies.length===0)&&(item.kind==="project"||item.kind==="test"))item.status="stale";
        const changeItem:MemoryItem={id:`rc-change-${result.id}`,key:`change:${result.id}`,kind:"change",text:`Edit reported changes to ${changedPaths.join(", ")}; source ${result.id}. This does not imply tests passed.`,status:"active",authority:"tool-evidence",sourceEntryIds:[result.id],taskId:snapshot.focus.taskId,dependencies:changedPaths.map(path=>({path})),observedAtEntryId:result.id,pinned:false};
        if(!snapshot.items.some(i=>i.id===changeItem.id))snapshot.items.push(changeItem);
      }
      const command=call&&typeof call.arguments.command==="string"?call.arguments.command:"";
      const isTestCommand=/\b(test|vitest|jest|pytest|cargo test|go test|npm run test|pnpm test)\b/i.test(command);
      const knownReadOnly=/^\s*(?:pwd|ls|find|rg|grep|git\s+(?:status|diff|log|show)|cat|head|tail|sed\s+-n)\b/i.test(command);
      if(result.message.toolName==="bash"&&!knownReadOnly&&!isTestCommand){for(const item of snapshot.items)if(item.kind==="project"||item.kind==="test")item.status="stale";}
      if(result.message.toolName==="bash"&&isTestCommand){
        const testItem:MemoryItem={id:`rc-test-${result.id}`,key:`test:${result.id}`,kind:"test",text:`Test command evidence: ${command.slice(0,300)}; tool error=${result.message.isError}; output source=${result.id}. Scope and current file version still require verification.`,status:result.message.isError?"stale":"active",authority:"tool-evidence",sourceEntryIds:[result.id],taskId:snapshot.focus.taskId,dependencies:changedPaths.map(path=>({path})),observedAtEntryId:result.id,pinned:false};
        if(!snapshot.items.some(i=>i.id===testItem.id))snapshot.items.push(testItem);
      }
      const dependencies=changedPaths.length?changedPaths.map(path=>({path})):call&&typeof call.arguments.path==="string"?[{path:call.arguments.path}]:[];
      const evidenceItem:MemoryItem={id:`rc-evidence-${result.id}`,key:`source:${result.id}`,kind:"project",text:evidenceText,status:"active",authority:"tool-evidence",sourceEntryIds:[result.id,group.assistantId],taskId:snapshot.focus.taskId,dependencies,observedAtEntryId:result.id,pinned:false};
      if(!snapshot.items.some(i=>i.id===evidenceItem.id))snapshot.items.push(evidenceItem);
      if(!capsule||original.length-capsule.length<config.minSavingTokens*4)continue;
      if(edits.some(e=>e.targetId===result.id&&e.replacementHash===hash(capsule)))continue;
      const edit={targetId:result.id,originalHash:hash(original),replacementHash:hash(capsule),replacement:capsule};
      edits.push(edit);drafts.push({type:"context_edit",targetId:result.id,replacement:{content:[{type:"text",text:capsule}]}});
    }
  }
  for(const projected of entries){
    for(const message of projected.messages){
      if(message.role==="assistant"){
        const text=message.content.filter(part=>part.type==="text").map(part=>part.type==="text"?part.text:"").join("\n").trim();
        if(!snapshot.items.some(item=>item.sourceEntryIds.includes(projected.sourceEntry.id))){
          const report=text?`[Assistant task report; source ${projected.sourceEntry.id}] ${text.slice(0,1400)}`:`[Assistant turn structure covered by tool evidence; source ${projected.sourceEntry.id}]`;
          snapshot.items.push({id:`rc-assistant-${projected.sourceEntry.id}`,key:`assistant:${projected.sourceEntry.id}`,kind:"task",text:report,status:"active",authority:"agent-report",sourceEntryIds:[projected.sourceEntry.id],taskId:snapshot.focus.taskId,dependencies:[],observedAtEntryId:projected.sourceEntry.id,pinned:false});
        }
      }else if((message as any).role==="bashExecution"){
        const b=message as any;if(b.output&&!snapshot.items.some(item=>item.id===`rc-bash-${projected.sourceEntry.id}`))snapshot.items.push({id:`rc-bash-${projected.sourceEntry.id}`,key:`bash:${projected.sourceEntry.id}`,kind:"project",text:`[Historical shell evidence; source ${projected.sourceEntry.id}; command=${String(b.command).slice(0,300)}; exit=${b.exitCode??"unknown"}] ${String(b.output).slice(0,900)}`,status:"active",authority:"tool-evidence",sourceEntryIds:[projected.sourceEntry.id],taskId:snapshot.focus.taskId,dependencies:[],observedAtEntryId:projected.sourceEntry.id,pinned:false});
      }
    }
  }
  const projectedTokens=Number.isSafeInteger(args.currentTokens)&&args.currentTokens!>=0?args.currentTokens!:estimateProjection(entries);
  const target=effectiveTarget(config);
  const maybeCheckpoint=projectedTokens>target&&branch.length>config.minCheckpointTurns;
  let checkpoint:StateEnvelope["checkpoint"];
  if(maybeCheckpoint) {
    const latest=entries.filter(e=>e.messages.some(m=>m.role==="user")).at(-1);
    const latestIndex=latest?entries.findIndex(e=>e.sourceEntry.id===latest.sourceEntry.id):-1;
    const recentIds=new Set(toolGroups.filter(group=>group.complete).slice(-3).map(group=>group.assistantId));
    const protectedIndices=toolGroups.filter(group=>!group.complete||!group.consumed||recentIds.has(group.assistantId)).map(group=>entries.findIndex(e=>e.sourceEntry.id===group.assistantId)).filter(index=>index>=0);
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
      return text===undefined||!edits.some(owned=>owned.targetId===targetId&&owned.replacementHash===hash(text));
    });
    const hasExistingCompaction=[...eventEntries,...drafts].some(d=>d.type==="compaction");
    const covered=new Set(snapshot.items.flatMap(item=>item.sourceEntryIds));
    const unknownToolCrossed=toolGroups.some(group=>{
      const groupIndex=entries.findIndex(entry=>entry.sourceEntry.id===group.assistantId);
      return groupIndex>=0&&groupIndex<firstKeptIndex&&!capsuleSafe(group);
    });
    const contentCovered=!unknownToolCrossed&&entries.slice(0,firstKeptIndex).every(entry=>entry.messages.every(message=>{
      if(message.role==="system")return true;
      if(message.role==="custom")return message.customType==="design-intent.projection.v1"&&snapshot.intentRefs.some(ref=>ref.id);
      if(message.role==="compactionSummary"||message.role==="branchSummary")return false;
      return covered.has(entry.sourceEntry.id);
    }));
    if(firstKept&&!hasImage&&!hasForeign&&!hasForeignEdit&&!hasExistingCompaction&&contentCovered) {
      const summary=renderCheckpoint(snapshot);
      const keptTokens=estimateProjection(entries.slice(firstKeptIndex));
      const candidateTokens=keptTokens+Math.ceil(summary.length/4);
      if(candidateTokens<projectedTokens&&candidateTokens<=target){
        const candidate={type:"compaction" as const,summary,firstKeptEntryId:firstKept,details:{type:CHECKPOINT_TYPE,planId:hash([sessionId,baseLeaf,snapshot.revision,summary]).slice(0,24),stateRevision:snapshot.revision,firstKeptEntryId:firstKept,summaryHash:hash(summary)}};
        drafts.push(candidate); checkpoint={firstKeptEntryId:firstKept,summaryHash:hash(summary)};
      }
    }
  }
  const sourceIndices=new Map(entries.map((entry,index)=>[entry.sourceEntry.id,index]));
  const retainedFrom=checkpoint?entries.findIndex(entry=>entry.sourceEntry.id===checkpoint!.firstKeptEntryId):Number.POSITIVE_INFINITY;
  const dispositions=new Map<string,"retained"|"extracted">();
  for(const item of snapshot.items)for(const sourceEntryId of item.sourceEntryIds){
    const index=sourceIndices.get(sourceEntryId);
    if(index!==undefined)dispositions.set(sourceEntryId,checkpoint&&index>=retainedFrom?"retained":"extracted");
  }
  snapshot.coverage=[...dispositions].map(([sourceEntryId,disposition])=>({sourceEntryId,disposition}));
  snapshot.coveredThroughEntryId=entries.filter(entry=>entry.messages.length>0).at(-1)?.sourceEntry.id??snapshot.coveredThroughEntryId;
  if(!drafts.length&&hash(snapshot)===hash(state.snapshot))return [];
  snapshot.revision=state.snapshot.revision+1;
  const planId=hash([sessionId,baseLeaf,snapshot.revision,edits.map(e=>e.replacementHash),checkpoint]).slice(0,24);
  const envelope:StateEnvelope={schemaVersion:1,revision:snapshot.revision,planId,baseLeafId:baseLeaf,snapshot,edits,checkpoint:checkpoint??state.envelope?.checkpoint};
  if(serializedStateBytes(envelope)>MAX_STATE_BYTES)return [];
  for(const draft of drafts)if(draft.type==="compaction"&&(draft.details as any)?.type===CHECKPOINT_TYPE)(draft.details as any).stateEnvelope=envelope;
  drafts.unshift({type:"custom",customType:STATE_TYPE,data:envelope});
  return drafts;
}
export function previewDrafts(cwd:string,header:any,branch:SessionEntry[],drafts:SessionBoundaryDraft[]):SessionEntry[]|undefined {
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
