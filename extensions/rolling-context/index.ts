import type { ExtensionAPI, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { registerRecall } from "./recall.ts";
import { telemetry } from "./telemetry.ts";
import { evidenceRegistry } from "./projection/evidence.ts";
import { restoreMode, restoreProjectionState, stateDelta } from "./projection/state.ts";
import { ageEvidence, capacity } from "./projection/aging.ts";
import { compressionCandidates, materialize } from "./projection/materialize.ts";
import { planCommit } from "./projection/planner.ts";
import { projectionSnapshot } from "./projection/snapshot.ts";
import { semanticReducer } from "./projection/reducer.ts";
import { tokens } from "./projection/common.ts";
import { DEFAULT_CONFIG, TELEMETRY_V2, type CommitPlan, type MappingRow, type ProjectionConfig, type ProjectionState } from "./projection/types.ts";

function parseConfig(pi: ExtensionAPI): ProjectionConfig {
  const number = (name: string, fallback: number, min: number, max=1_000_000) => {
    const raw=pi.getFlag(name); if(raw===undefined)return fallback;
    const value=Number(raw);if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`Invalid --${name}: expected integer ${min}..${max}`);return value;
  };
  const mode=String(pi.getFlag("rolling-context-mode")??"on");
  if(!["on","off","observe"].includes(mode))throw new Error("--rolling-context-mode must be on, observe, or off");
  return {...DEFAULT_CONFIG,mode:mode as ProjectionConfig["mode"],reserveTokens:number("rolling-context-reserve",16384,0),
    minSavingTokens:number("rolling-context-min-saving",256,1),minBatchSavingTokens:number("rolling-context-batch-saving",512,1),
    recallMaxTokens:number("rolling-context-recall-tokens",2000,100,10000)};
}

export default function rollingContext(pi: ExtensionAPI) {
  pi.registerFlag("rolling-context-mode",{type:"string",default:"on",description:"Semantic context cache: on, observe, or off"});
  pi.registerFlag("rolling-context-reserve",{type:"string",default:"16384",description:"Output reserve in tokens"});
  pi.registerFlag("rolling-context-min-saving",{type:"string",default:"256",description:"Minimum saving for exact to capsule"});
  pi.registerFlag("rolling-context-batch-saving",{type:"string",default:"512",description:"Minimum economic compression batch saving"});
  pi.registerFlag("rolling-context-recall-tokens",{type:"string",default:"2000",description:"Maximum recall response estimate"});
  const config=parseConfig(pi);
  let mode=config.mode;
  let lastStatus=`mode=${mode}; projection v2`;
  let lastRows:MappingRow[]=[];
  let preflightCommit:CommitPlan|undefined;
  let lastRequest:{requestId:string;generation:number;totals:any;commit?:CommitPlan}|undefined;
  registerRecall(pi,config);

  const requestConfig=(ctx:any):ProjectionConfig=>({...config,mode,contextWindow:ctx.model?.contextWindow>0?ctx.model.contextWindow:ctx.getContextUsage?.()?.contextWindow??config.contextWindow});
  const registryFor=(ctx:any,state:ProjectionState)=>evidenceRegistry(ctx.sessionManager.getBranch(),ctx.sessionManager.buildSessionProjection().entries,ctx.sessionManager.getSessionId(),state);
  const restore=(ctx:any)=>{mode=restoreMode(ctx.sessionManager.getBranch(),config.mode);lastRows=[];lastRequest=undefined;lastStatus=`mode=${mode}; projection v2; generation=${restoreProjectionState(ctx.sessionManager.getBranch()).generation}`;};
  pi.on("session_start",(_event,ctx)=>{
    restore(ctx);
    const branch=ctx.sessionManager.getBranch(),state=restoreProjectionState(branch);
    if(branch.some(e=>e.type==="message"&&e.message.role==="assistant")||branch.some(e=>e.type==="custom"&&[TELEMETRY_V2,"rolling-context.telemetry.v1"].includes(e.customType)))return;
    const registry=registryFor(ctx,state),messages=ctx.sessionManager.buildSessionProjection().messages;
    const result=materialize(messages,registry,state,mode),plan=planCommit([],result.rows.reduce((n,r)=>n+r.projectedTokens,0),requestConfig(ctx));
    pi.appendEntry(TELEMETRY_V2,telemetry(state,result.rows,branch.filter(e=>e.type==="message").reduce((n,e)=>n+tokens((e as any).message),0),plan,mode));
  });
  pi.on("session_tree",(_event,ctx)=>restore(ctx));
  pi.on("session_shutdown",()=>{lastRows=[];lastRequest=undefined;});

  pi.on("context",async(event,ctx)=>{
    preflightCommit=undefined;
    const branch=ctx.sessionManager.getBranch(),state=restoreProjectionState(branch),registry=registryFor(ctx,state),cfg=requestConfig(ctx);
    let result=materialize(event.messages,registry,state,mode);
    // Newly appended evidence can bring a request close to capacity before a turn boundary.
    const systemTokens=[...registry.values()].filter(s=>s.message.role==="system").reduce((n,s)=>n+s.rawTokens,0);
    const projected=result.rows.reduce((n,r)=>n+r.projectedTokens,0)+systemTokens;
    if(mode==="on"&&projected>=capacity(cfg)*.9){
      const leaf=ctx.sessionManager.getLeafId(),before=structuredClone(state);
      await ageEvidence(registry,state,cfg,projected,semanticReducer(ctx));
      if(ctx.sessionManager.getLeafId()===leaf){
        const plan=planCommit(compressionCandidates(event.messages,registry,state,cfg),projected,cfg);
        applyCommit(state,plan.changes);
        if(plan.changes.length)preflightCommit=plan;
        const delta=stateDelta(before,state);if(delta)pi.appendEntry(delta.customType,delta.data);
        result=materialize(event.messages,registry,state,mode);
      }
    }
    lastRows=result.rows;
    // Pi's runner passes a structuredClone here. Preserve its message identities when
    // replacing content, so restoreSystemMessages keeps chronological prompt/tool deltas
    // instead of collapsing them into a newly rebuilt leading system frame.
    for(const [index,message] of result.messages.entries())if(message!==event.messages[index])
      event.messages[index].content=message.content as any;
    return {messages:event.messages};
  });
  pi.on("context_with_system",(event,ctx)=>{
    const state=restoreProjectionState(ctx.sessionManager.getBranch()),registry=registryFor(ctx,state),cfg=requestConfig(ctx);
    const snapshot=projectionSnapshot(event.messages,lastRows,registry,state,ctx.sessionManager.getBranch(),cfg.contextWindow,mode);
    for(const draft of snapshot.drafts)pi.appendEntry(draft.customType,draft.data);
    lastRequest={requestId:snapshot.requestId,generation:state.generation,totals:snapshot.totals,commit:preflightCommit};
    lastRows=snapshot.rows;
    // This observer returns the exact list it archived; no daemon approximation is involved.
    return {messages:event.messages};
  });

  pi.on("turn_end",async(event,ctx)=>{
    if(event.outcome!=="completed")return;
    const branch=ctx.sessionManager.getBranch();
    if(branch.some(e=>e.type==="custom"&&e.customType===TELEMETRY_V2&&(e.data as any)?.messageEntryId===event.messageEntryId))return;
    const before=restoreProjectionState(branch),state=structuredClone(before);state.turn++;
    const leaf=ctx.sessionManager.getLeafId(),sessionId=ctx.sessionManager.getSessionId(),cfg=requestConfig(ctx);
    // The host preview includes preceding extension drafts; never project raw branch blindly.
    const projection=event.context.contextEntries,registry=evidenceRegistry(branch,projection,sessionId,state);
    const messages=projection.flatMap(e=>e.messages),resident=materialize(messages,registry,state,mode);
    if(mode!=="off")await ageEvidence(registry,state,cfg,resident.rows.reduce((n,r)=>n+r.projectedTokens,0),mode==="on"?semanticReducer(ctx):undefined);
    if(ctx.sessionManager.getSessionId()!==sessionId||ctx.sessionManager.getLeafId()!==leaf)return;
    const candidates=mode==="off"?[]:compressionCandidates(messages,registry,state,cfg);
    const proposed=planCommit(candidates,resident.rows.reduce((n,r)=>n+r.projectedTokens,0),cfg);
    const plan=mode==="on"?proposed:{...proposed,changes:[],savingPerRequest:0,earliestMutationPosition:null,estimatedInvalidatedSuffixTokens:0,breakEvenRequests:null};
    applyCommit(state,plan.changes);
    const own:SessionBoundaryDraft[]=[];
    const delta=mode==="on"?stateDelta(before,state):undefined;if(delta)own.push(delta);
    const effective=materialize(messages,registry,state,mode);
    const raw=branch.filter(e=>e.type==="message").reduce((n,e)=>n+tokens((e as any).message),0);
    const data=telemetry(state,effective.rows,raw,plan,mode,event.message.role==="assistant"?event.message.usage:undefined,lastRequest,event.messageEntryId);
    data.contextWindow=cfg.contextWindow;
    lastStatus=`mode=${mode}; generation=${state.generation}; projected≈${data.effectiveTokens} / ${cfg.contextWindow}; raw≈${raw}; pendingGain=${proposed.pendingCompressionGain}; ${data.capacityStatus}`;
    own.push({type:"custom",customType:TELEMETRY_V2,data});
    return {entries:[...event.entries,...own]};
  });
  // A healthy v2 projection should not trigger a native threshold compact merely because
  // its immutable evidence log is large. Manual/overflow compact retains native behavior.
  pi.on("session_before_compact",(event,ctx)=>{
    if(mode!=="on"||event.reason!=="threshold"||event.customInstructions)return;
    const state=restoreProjectionState(ctx.sessionManager.getBranch()),registry=registryFor(ctx,state),cfg=requestConfig(ctx);
    const result=materialize(ctx.sessionManager.buildSessionProjection().messages,registry,state,mode);
    if(result.rows.reduce((n,r)=>n+r.projectedTokens,0)<capacity(cfg))return {cancel:true};
  });
  pi.on("session_compact",(_event,ctx)=>restore(ctx));
  pi.on("model_select",(_event,ctx)=>{lastStatus+=`; window=${requestConfig(ctx).contextWindow}`;});

  const verbs=["status","on","off","observe","inspect"];
  pi.registerCommand("rolling-context",{description:"Semantic context cache: status | on | off | observe | inspect",getArgumentCompletions:prefix=>{
    const matches=verbs.filter(v=>v.startsWith(prefix.trim()));return matches.length?matches.map(value=>({value,label:value,description:`Rolling Context ${value}`})):null;
  },handler:async(args,ctx)=>{
    const verb=args.trim()||"status";
    if(verb==="on"||verb==="off"||verb==="observe"){
      mode=verb;pi.appendEntry("rolling-context.config.v2",{schemaVersion:2,mode,explicit:true});ctx.ui.notify(`Rolling Context mode=${mode}; projection v2`,"info");return;
    }
    if(verb==="status"){ctx.ui.notify(lastStatus,"info");return;}
    if(verb==="inspect"){
      const state=restoreProjectionState(ctx.sessionManager.getBranch());
      ctx.ui.notify(`Projection generation ${state.generation}\n${[...state.sources.values()].map(r=>`${r.sourceId} · desired=${r.desiredRepresentation} · committed=${r.committedRepresentation} · ${r.reason}`).join("\n")||"All current evidence exact"}`,"info");return;
    }
    ctx.ui.notify("/rolling-context status | on | off | observe | inspect","warning");
  }});
}

function applyCommit(state:ProjectionState,changes:ReturnType<typeof planCommit>["changes"]) {
  if(!changes.length)return;
  state.generation++;
  for(const change of changes){const record=state.sources.get(change.sourceId)!;record.committedRepresentation=change.desired;record.generation=state.generation;record.changedTurn=state.turn;}
}
