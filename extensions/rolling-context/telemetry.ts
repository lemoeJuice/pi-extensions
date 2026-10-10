import type { CommitPlan, MappingRow, ProjectionState } from "./projection/types.ts";
import { TELEMETRY_V2 } from "./projection/types.ts";
import { bytes } from "./projection/common.ts";

const metric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
export function telemetry(state: ProjectionState, rows: MappingRow[], rawTokens: number, plan: CommitPlan, mode: string,
  usage?: any, request?: {requestId:string; generation:number; totals:any; commit?:CommitPlan}, messageEntryId?: string) {
  const input=metric(usage?.input), cacheRead=metric(usage?.cacheRead), cacheWrite=metric(usage?.cacheWrite);
  const cacheReuseRatio=input!==null&&cacheRead!==null&&input+cacheRead>0?cacheRead/(input+cacheRead):null;
  const effectiveTokens=rows.reduce((n,r)=>n+r.projectedTokens,0);
  return {type:TELEMETRY_V2, turn:state.turn, timelineKind:state.turn===0?"initial":"completed", mode,
    ...(state.turn ? {eventPosition:"after-turn"} : {}), messageEntryId:messageEntryId??null, tokenBasis:"host-estimate",
    generation:state.generation, epoch:state.generation, generationCommitted:plan.changes.length>0,
    representationChanges:plan.changes.length, capsulesCreated:plan.changes.filter(c=>c.desired==="CAPSULE").length,
    sourcesCold:plan.changes.filter(c=>c.desired==="COLD").length,
    rawTokens, projectedTokens:request?.totals.projectedTokens??effectiveTokens, effectiveTokens,
    requestId:request?.requestId??null, requestGeneration:request?.generation??null,
    requestGenerationCommitted:!!request?.commit?.changes.length, requestRepresentationChanges:request?.commit?.changes.length??0,
    requestSavingPerRequest:request?.commit?.savingPerRequest??0, requestMutationPosition:request?.commit?.earliestMutationPosition??null,
    requestInvalidatedSuffixTokens:request?.commit?.estimatedInvalidatedSuffixTokens??0,
    contextWindow:request?.totals.window??272000, hardThresholdTokens:plan.availableCapacity,
    exactTokens:rows.filter(r=>r.representation==="EXACT"&&r.role!=="system").reduce((n,r)=>n+r.projectedTokens,0),
    capsuleTokens:rows.filter(r=>r.representation==="CAPSULE").reduce((n,r)=>n+r.projectedTokens,0),
    coldEquivalentTokens:rows.filter(r=>r.representation==="COLD").reduce((n,r)=>n+r.rawTokens,0),
    coldRefTokens:rows.filter(r=>r.representation==="COLD").reduce((n,r)=>n+r.projectedTokens,0),
    frameTokens:rows.filter(r=>r.role==="system").reduce((n,r)=>n+r.projectedTokens,0),
    pinnedExactTokens:rows.filter(r=>r.role==="user").reduce((n,r)=>n+r.projectedTokens,0),
    pendingCompressionGain:plan.pendingCompressionGain, savingPerRequest:plan.savingPerRequest,
    earliestMutationPosition:plan.earliestMutationPosition, estimatedInvalidatedSuffixTokens:plan.estimatedInvalidatedSuffixTokens,
    breakEvenRequests:plan.breakEvenRequests, compressionTokens:plan.changes.reduce((n,c)=>n+c.compressionTokens,0),
    occupancy:effectiveTokens/Math.max(1,plan.availableCapacity), capacityStatus:effectiveTokens>=plan.availableCapacity?"BUDGET_INFEASIBLE":"HEALTHY",
    stateBytes:bytes([...state.sources.values()]), input, uncachedInput:input, cacheRead, cacheWrite, cacheReuseRatio,
    usage:{input,uncachedInput:input,cacheRead,cacheWrite,cacheReuseRatio} };
}
