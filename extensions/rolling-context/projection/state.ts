import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { hash } from "./common.ts";
import { STATE_V2, TELEMETRY_V2, type ProjectionState, type RepresentationState } from "./types.ts";

const representations = new Set(["EXACT", "CAPSULE", "COLD"]);
export function restoreProjectionState(branch: SessionEntry[]): ProjectionState {
  const state: ProjectionState = { generation: 0, turn: 0, sources: new Map(), diagnostics: [] };
  for (const entry of branch) {
    if (entry.type !== "custom") continue;
    const data = entry.data as any;
    if ([TELEMETRY_V2, "rolling-context.telemetry.v1"].includes(entry.customType) && Number.isSafeInteger(data?.turn))
      state.turn = Math.max(state.turn, data.turn);
    if (entry.customType === "rolling-context.recall-use.v2" && Array.isArray(data?.sourceIds)) {
      for (const id of data.sourceIds) { const record=state.sources.get(id); if(record)record.lastUseTurn=state.turn; }
    }
    if (entry.customType !== STATE_V2) continue;
    if (data?.schemaVersion !== 2 || data.parentGeneration !== state.generation || !Array.isArray(data.changes)
      || !Number.isSafeInteger(data.generation) || data.generation < state.generation || data.generation > state.generation + 1) {
      state.diagnostics.push(`Invalid representation delta: ${entry.id}`); continue;
    }
    const records = data.changes.map((r:any)=>({...r, capsule:r.capsule ?? (state.sources.get(r.sourceId)?.sourceHash===r.sourceHash?state.sources.get(r.sourceId)?.capsule:undefined)}));
    const valid = records.every((r: any) => typeof r.sourceId === "string" && typeof r.sourceHash === "string"
      && representations.has(r.committedRepresentation) && representations.has(r.desiredRepresentation)
      && Number.isSafeInteger(r.lastUseTurn) && r.lastUseTurn >= 0
      && (r.committedRepresentation === "EXACT" || typeof r.capsule?.text === "string" && r.capsule.text.length <= 6000));
    if (!valid) { state.diagnostics.push(`Invalid source state: ${entry.id}`); continue; }
    let mutation = false;
    for (const record of records as RepresentationState[]) {
      const old = state.sources.get(record.sourceId);
      if ((old?.sourceHash===record.sourceHash?old.committedRepresentation:"EXACT") !== record.committedRepresentation) mutation = true;
    }
    if (data.generation !== state.generation + (mutation ? 1 : 0)) {
      state.diagnostics.push(`Generation without representation commit: ${entry.id}`); continue;
    }
    for (const record of records) state.sources.set(record.sourceId, structuredClone(record));
    state.generation = data.generation;
  }
  return state;
}

/** Append deltas only; cold sources remain indexed by raw source IDs. */
export function stateDelta(before: ProjectionState, after: ProjectionState) {
  const changes = [...after.sources.values()].filter(record => hash(record) !== hash(before.sources.get(record.sourceId) ?? null)).map(record=>{
    const old=before.sources.get(record.sourceId);
    if(old?.sourceHash===record.sourceHash&&hash(old.capsule??null)===hash(record.capsule??null)) {const {capsule,...delta}=record;return delta;}
    return record;
  });
  return changes.length ? { type: "custom" as const, customType: STATE_V2,
    data: { schemaVersion: 2, parentGeneration: before.generation, generation: after.generation, turn: after.turn, changes } } : undefined;
}

export function restoreMode(branch: SessionEntry[], fallback: "on" | "observe" | "off") {
  for (const entry of [...branch].reverse()) if (entry.type === "custom" && ["rolling-context.config.v1", "rolling-context.config.v2"].includes(entry.customType)) {
    const data = entry.data as any;
    // v1 commands wrote {mode}; these are explicit. Old defaults did not write a command entry.
    if (["on", "off", "observe"].includes(data?.mode) && data.explicit !== false && data.origin !== "default") return data.mode as typeof fallback;
  }
  return fallback;
}
