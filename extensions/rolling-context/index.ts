import type { ExtensionAPI, SessionBoundaryDraft, SessionEntry, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { emptySnapshot, estimateProjection, groups, hash, planTurn, previewDrafts, rebuild, renderCheckpoint, type RollingConfig } from "./lib.ts";

const NoteParams=Type.Object({intent:Type.String({minLength:1}),kind:Type.Union([Type.Literal("plan"),Type.Literal("task-decision"),Type.Literal("focus"),Type.Literal("next-step")]),text:Type.String({minLength:1,maxLength:2000}),replaces:Type.Optional(Type.Array(Type.String(),{maxItems:8})),paths:Type.Optional(Type.Array(Type.String({maxLength:256}),{maxItems:12}))},{additionalProperties:false});
const RecallParams=Type.Object({intent:Type.String({minLength:1}),entryId:Type.Optional(Type.String()),itemId:Type.Optional(Type.String()),query:Type.Optional(Type.String({maxLength:300})),cursor:Type.Optional(Type.Number({minimum:0})),limit:Type.Optional(Type.Number({minimum:1,maximum:8}))},{additionalProperties:false});
const NoteDetails=Type.Object({type:Type.Literal("rolling-context.note.v1"),noteId:Type.String(),taskId:Type.String(),kind:Type.String(),text:Type.String(),replaces:Type.Array(Type.String()),paths:Type.Array(Type.String())});

function parseConfig(pi:ExtensionAPI):RollingConfig {
  const mode=String(pi.getFlag("rolling-context-mode")??"observe");
  const number=(name:string,fallback:number,min=0,max=1_000_000)=>{
    const raw=pi.getFlag(name);if(raw===undefined)return fallback;
    const n=Number(raw);if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`Invalid --${name}: expected integer ${min}..${max}`);return n;
  };
  if(!["observe","on","off"].includes(mode))throw new Error("--rolling-context-mode must be observe, on, or off");
  return {mode:mode as RollingConfig["mode"],targetTokens:number("rolling-context-target",32768,2048),reserveTokens:number("rolling-context-reserve",16384),minSavingTokens:number("rolling-context-min-saving",256),minCheckpointTurns:number("rolling-context-checkpoint-interval",8),recallMaxTokens:number("rolling-context-recall-tokens",2000,100,10000)};
}

export default function rollingContext(pi:ExtensionAPI) {
  pi.registerFlag("rolling-context-mode",{type:"string",default:"observe",description:"Rolling Context mode: observe, on, or off"});
  pi.registerFlag("rolling-context-target",{type:"string",default:"32768",description:"Target context token estimate"});
  pi.registerFlag("rolling-context-reserve",{type:"string",default:"16384",description:"Conservative output reserve in tokens"});
  pi.registerFlag("rolling-context-min-saving",{type:"string",default:"256",description:"Minimum token saving per tool result"});
  pi.registerFlag("rolling-context-checkpoint-interval",{type:"string",default:"8",description:"Minimum branch entries before checkpoint"});
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
    const projectedById=new Map(projection.entries.map(e=>[e.sourceEntry.id,e.messages]));
    const allowed=new Set(projectedById.keys());
    const state=rebuild(branch,ctx.sessionManager.getSessionId());
    const start=Math.max(0,Math.floor(params.cursor??0));const limit=params.limit??5;
    let matches=branch.filter(e=>allowed.has(e.id)&&(e.type==="message"||e.type==="custom_message"&&e.customType==="design-intent.projection.v1"||e.type==="compaction"));
    if(params.entryId)matches=matches.filter(e=>e.id===params.entryId);
    else if(params.itemId){const item=state.snapshot.items.find(i=>i.id===params.itemId);matches=matches.filter(e=>item?.sourceEntryIds.includes(e.id));}
    else if(params.query){const q=params.query.toLowerCase();matches=matches.filter(e=>JSON.stringify(e).toLowerCase().includes(q));}
    const page=matches.slice(start,start+limit);
    let text=page.map(e=>{if(e.type==="message"){
      const effective=projectedById.get(e.id)?.[0]??e.message;
      const ownEdit=state.envelope?.edits.some(edit=>edit.targetId===e.id&&effective.role==="toolResult"&&hash(effective.content.filter((part:any)=>part.type==="text").map((part:any)=>part.text).join("\n"))===edit.replacementHash);
      // Only an exact edit owned by this extension may be expanded back to the stored historical bytes.
      const m=ownEdit&&e.message.role==="toolResult"?e.message:effective;
      if(m.role==="assistant"&&m.content.some(x=>x.type==="thinking"))return `[${e.id}] assistant (thinking omitted)`;
      if(m.role==="user"&&Array.isArray(m.content)){const safe=m.content.filter(part=>part.type==="text").map(part=>part.type==="text"?part.text:"[image omitted]").join("\n");return `[${e.id}] user: ${safe.slice(0,1800)}${m.content.some(part=>part.type==="image")?" [image omitted]":""}`;}
      if(m.role==="toolResult"){const safe=Array.isArray(m.content)?m.content.filter(part=>part.type==="text").map(part=>part.type==="text"?part.text:"").join("\n"):String(m.content);return `[${e.id}] toolResult ${m.toolName}: ${safe.slice(0,1800)}${m.content.some((part:any)=>part.type==="image")?" [image omitted]":""}`;}
      return `[${e.id}] ${m.role}: ${JSON.stringify(m.role==="assistant"?m.content.filter(x=>x.type!=="thinking"):m).slice(0,1800)}`;
    }if(e.type==="custom_message")return `[${e.id}] Design Intent projection: ${e.content.filter((part:any)=>part.type==="text").map((part:any)=>part.text).join("\n").slice(0,1200)}`;if(e.type==="compaction")return `[${e.id}] checkpoint: ${e.summary.slice(0,1200)}`;return `[${e.id}] ${e.type}: ${JSON.stringify(e).slice(0,1200)}`;}).join("\n\n");
    const truncated=text.length>config.recallMaxTokens*4;if(truncated)text=`${text.slice(0,config.recallMaxTokens*4)}\n[Recall truncated; request the next page or a specific source.]`;
    return {content:[{type:"text",text:text||"No matching evidence in the active projected branch."}],details:{nextCursor:start+limit<matches.length?start+limit:undefined,totalMatches:matches.length,returned:page.length,truncated}};
  }});

  const rebuildState=(ctx:any)=>rebuild(ctx.sessionManager.getBranch(),ctx.sessionManager.getSessionId());
  const checkpointCoverageValid=(branch:SessionEntry[],firstKeptId:string,state:ReturnType<typeof rebuild>):boolean=>{
    const cut=branch.findIndex(entry=>entry.id===firstKeptId);if(cut<0)return false;
    const covered=new Set(state.snapshot.items.flatMap(item=>item.sourceEntryIds));
    for(const entry of branch.slice(0,cut)){
      if(entry.type==="message"){
        const message=entry.message;
        if(message.role==="system")continue;
        if(message.role==="user"||message.role==="assistant"||message.role==="bashExecution"){
          if(!covered.has(entry.id))return false;
          continue;
        }
        if(message.role==="toolResult"){
          if(!covered.has(entry.id))return false;
          continue;
        }
      }
      if(entry.type==="custom_message"&&entry.customType==="design-intent.projection.v1"&&state.snapshot.intentRefs.length)continue;
      if(entry.type==="custom"||entry.type==="usage"||entry.type==="model_change"||entry.type==="thinking_level_change"||entry.type==="context_edit"||entry.type==="label"||entry.type==="session_info")continue;
      return false;
    }
    return true;
  };
  const restoreMode=(ctx:any)=>{const entry=[...ctx.sessionManager.getBranch()].reverse().find((e:SessionEntry)=>e.type==="custom"&&e.customType==="rolling-context.config.v1");const saved=(entry as any)?.data?.mode;if(saved==="on"||saved==="off"||saved==="observe")mode=saved;};
  pi.on("session_start",(_event,ctx)=>{restoreMode(ctx);const state=rebuildState(ctx);lastStatus=`mode=${mode}; items=${state.snapshot.items.length}; diagnostics=${state.diagnostics.length}`;});
  pi.on("session_tree",(_event,ctx)=>{restoreMode(ctx);const state=rebuildState(ctx);lastStatus=`mode=${mode}; branch=${ctx.sessionManager.getLeafId()??"empty"}; items=${state.snapshot.items.length}`;});
  pi.on("turn_end",async(event,ctx)=>{
    const state=rebuildState(ctx);
    const projection=event.context.contextEntries;
    const tokens=estimateProjection(projection);
    const current=ctx.getContextUsage();
    lastStatus=`mode=${mode}; projected≈${tokens}; usage=${current?.tokens??"unknown"}; groups=${groups(projection).length}; items=${state.snapshot.items.length}`;
    if(mode==="observe"||mode==="off")return;
    if(event.outcome!=="completed")return;
    const branch=ctx.sessionManager.getBranch();
    const own=planTurn({entries:projection,branch,eventEntries:event.entries,baseLeaf:ctx.sessionManager.getLeafId(),config:{...config,mode},state,sessionId:ctx.sessionManager.getSessionId()});
    if(!own.length)return;
    const candidate=[...event.entries,...own];
    const header=ctx.sessionManager.getHeader();
    if(!header||!previewDrafts(ctx.cwd,header,branch,candidate)){lastStatus+="; plan rejected by projection validation";return;}
    // Ensure inherited custom/context transformations don't invalidate original task/user content.
    const projectedUsers=projection.flatMap(e=>e.messages.filter(m=>m.role==="user"));
    if(projectedUsers.length===0){lastStatus+="; no user anchor";return;}
    return {entries:candidate};
  });
  pi.on("agent_before_settle",async(event,ctx)=>{
    if(event.outcome!=="completed"||config.mode!=="on")return;
    // turn_end handles normal incremental updates; final boundary intentionally avoids a second compaction.
    const state=rebuildState(ctx);lastStatus+=`; settled revision=${state.snapshot.revision}`;
  });
  pi.on("session_before_compact",async(event,ctx)=>{
    if(!manualCheckpoint||event.reason!=="manual"||ctx.sessionManager.getSessionId()!==manualCheckpoint.sessionId||ctx.sessionManager.getLeafId()!==manualCheckpoint.leafId)return;
    const state=rebuildState(ctx);
    const summary=renderCheckpoint(state.snapshot);
    const firstKeptEntryId=event.preparation.firstKeptEntryId;
    if(!firstKeptEntryId||!checkpointCoverageValid(event.branchEntries,firstKeptEntryId,state)){
      ctx.ui.notify("Rolling checkpoint cancelled: the task state does not cover every context entry before the proposed boundary. Native compaction is not substituted automatically.","warning");
      return {cancel:true};
    }
    const planId=hash([manualCheckpoint,summary]).slice(0,20);
    const envelope=state.envelope??{schemaVersion:1 as const,revision:state.snapshot.revision+1,planId,baseLeafId:manualCheckpoint.leafId,snapshot:{...state.snapshot,revision:state.snapshot.revision+1},edits:[]};
    return {compaction:{summary,firstKeptEntryId,tokensBefore:event.preparation.tokensBefore,details:{type:"rolling-context.checkpoint.v1",stateEnvelope:envelope,stateRevision:envelope.revision,planId}}};
  });
  pi.on("session_compact",()=>{manualCheckpoint=undefined;});
  pi.on("session_compact_failed",()=>{manualCheckpoint=undefined;});

  pi.registerCommand("rolling-context",{description:"Inspect or control Rolling Context",handler:async(args,ctx)=>{
    const [verb,...rest]=args.trim().split(/\s+/);const value=rest.join(" ");
    if(verb==="status"||!verb){const state=rebuildState(ctx);ctx.ui.notify(`${lastStatus}\nmode=${mode}; focus=${state.snapshot.focus.taskId||"none"}; next=${state.snapshot.focus.nextSteps.length}; intentRefs=${state.snapshot.intentRefs.length}`,"info");return;}
    if(verb==="inspect"){const state=rebuildState(ctx);ctx.ui.notify(renderCheckpoint(state.snapshot),"info");return;}
    if(verb==="observe"||verb==="on"||verb==="off"){mode=verb;pi.appendEntry("rolling-context.config.v1",{mode});ctx.ui.notify(`Rolling Context mode: ${mode}. Existing edits/checkpoints are unchanged.`,"info");return;}
    if(verb==="pin"||verb==="unpin"){
      const id=rest[0];if(!id){ctx.ui.notify(`Usage: /rolling-context ${verb} ITEM_ID`,"warning");return;}
      const state=rebuildState(ctx);const item=state.snapshot.items.find(candidate=>candidate.id===id);if(!item){ctx.ui.notify(`Unknown active-branch item ${id}`,"error");return;}
      item.pinned=verb==="pin";state.snapshot.revision++;
      const envelope={schemaVersion:1 as const,revision:state.snapshot.revision,planId:hash([ctx.sessionManager.getSessionId(),ctx.sessionManager.getLeafId(),id,verb,state.snapshot.revision]).slice(0,24),baseLeafId:ctx.sessionManager.getLeafId(),snapshot:state.snapshot,edits:state.envelope?.edits??[]};
      pi.appendEntry("rolling-context.state.v1",envelope);ctx.ui.notify(`${verb}ned ${id}`,"info");return;
    }
    if(verb==="checkpoint"){
      if(!ctx.hasUI){ctx.ui.notify("Manual checkpoint requires a confirmation-capable UI.","error");return;}
      await ctx.waitForIdle();
      if(ctx.hasPendingMessages()){ctx.ui.notify("Checkpoint skipped: pending messages exist.","warning");return;}
      const state=rebuildState(ctx);const summary=renderCheckpoint(state.snapshot);
      const ok=await ctx.ui.confirm("Rolling Context checkpoint",`Create a checkpoint from current validated task state?\n\n${summary.slice(0,3000)}`);
      if(!ok)return;
      const sessionId=ctx.sessionManager.getSessionId();const leafId=ctx.sessionManager.getLeafId();
      manualCheckpoint={sessionId,leafId};
      ctx.compact({customInstructions:"Use exactly the Rolling Context state supplied by the extension as the continuity summary. Do not add or infer project Design Intent. Preserve user instructions, task-local execution decisions, evidence freshness and next steps.",onComplete:()=>{manualCheckpoint=undefined;ctx.ui.notify("Rolling Context checkpoint completed.","info");},onError:error=>{manualCheckpoint=undefined;ctx.ui.notify(`Checkpoint failed: ${error.message}`,"error");}});
      return;
    }
    ctx.ui.notify("Usage: /rolling-context [status|inspect|checkpoint|on|off|observe]","warning");
  }});
}
