import { reduceEvidence, type SemanticReducer } from "./reducer.ts";
import { text } from "./common.ts";
import type { Evidence, ProjectionConfig, ProjectionState, RepresentationState } from "./types.ts";

export function capacity(config: ProjectionConfig): number {
  return Math.max(0, config.contextWindow - config.reserveTokens - Math.max(2048, Math.ceil(config.contextWindow * .05)));
}

/** Semantic desire is independent of whether paying for a prefix mutation is worthwhile. */
export async function ageEvidence(registry: Map<string, Evidence>, state: ProjectionState, config: ProjectionConfig, projectedTokens: number, semantic?: SemanticReducer): Promise<void> {
  const pressure = projectedTokens / Math.max(1, capacity(config));
  const exactAge = pressure >= .9 ? 1 : pressure >= .75 ? Math.max(1, Math.floor(config.exactAge / 2)) : config.exactAge;
  const coldAge = pressure >= .9 ? Math.max(3, Math.floor(config.coldAge / 2)) : config.coldAge;
  const recentText=[...registry.values()].filter(source=>source.bornTurn>=state.turn-1&&(source.message.role==="user"||source.message.role==="assistant"))
    .slice(-16).map(source=>text(source.message).slice(0,2000)).join("\n");
  const latestByEntity=new Map<string,string>();
  for(const source of registry.values())for(const entity of source.entities)latestByEntity.set(entity,source.sourceId);
  let semanticJobs = 0;
  for (const source of registry.values()) {
    const previous = state.sources.get(source.sourceId);
    const record: RepresentationState = previous?.sourceHash === source.sourceHash ? { ...previous }
      : { sourceId: source.sourceId, sourceHash: source.sourceHash, desiredRepresentation: "EXACT", committedRepresentation: "EXACT",
        reason: "Recent evidence", generation: state.generation, changedTurn: source.bornTurn, lastUseTurn: source.lastUseTurn };
    // Ordinary agent/user references refresh relevance without an RC maintenance tool.
    // Only the latest observation of a path is refreshed; obsolete versions can still age.
    if(recentText.includes(source.sourceId)||source.entities.some(entity=>latestByEntity.get(entity)===source.sourceId&&recentText.includes(entity)))
      record.lastUseTurn=Math.max(record.lastUseTurn,state.turn-1);
    const age = state.turn - Math.max(source.bornTurn, record.lastUseTurn);
    if (source.pinned || !source.reducible) {
      // No need to persist the default EXACT state for every transcript entry.
      if (previous) { record.desiredRepresentation = "EXACT"; record.reason = "Required exact content"; state.sources.set(source.sourceId, record); }
      continue;
    }
    if (age < exactAge && record.committedRepresentation === "EXACT" && !record.capsule) {
      if (previous || record.lastUseTurn > source.bornTurn) state.sources.set(source.sourceId, record);
      continue;
    }
    if (!record.capsule && source.rawTokens >= config.minSavingTokens * 2 && state.turn >= (record.retryTurn ?? 0)) {
      const capsule = await reduceEvidence(source); // inexpensive deterministic pass first
      record.capsule = capsule;
      if (!capsule && semantic && semanticJobs < 2) { semanticJobs++; record.capsule = await reduceEvidence(source, semantic); }
      if (!record.capsule) { record.retryTurn = state.turn + 8; record.reason = "Compression risk or reducer unavailable; retain exact"; }
    }
    if (record.capsule) {
      // Never bind cold eligibility to warm residence or a global checkpoint.
      record.desiredRepresentation = age >= coldAge && record.capsule.coldSafe ? "COLD" : "CAPSULE";
      record.reason = record.desiredRepresentation === "COLD" ? "Old redundant execution evidence; raw remains recallable" : "Consumed historical evidence; semantic capsule sufficient";
      // A recall updates lastUse, bringing cold evidence back to resident capsule.
    }
    if (record.capsule || record.retryTurn) state.sources.set(source.sourceId, record);
  }
}
