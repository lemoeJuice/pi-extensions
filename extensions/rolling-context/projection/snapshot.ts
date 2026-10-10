import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { bytes, hash, text, tokens } from "./common.ts";
import { matchMessages } from "./evidence.ts";
import { CONTENT_V2, SNAPSHOT_V2, type Evidence, type MappingRow, type ProjectionState } from "./types.ts";
import codec from "./snapshot-codec.js";

/** Observe the full hook output after Pi restores system/tool state. Store refs, not transcripts. */
export function projectionSnapshot(messages: AgentMessage[], priorRows: MappingRow[], registry: Map<string, Evidence>, state: ProjectionState,
  branch: SessionEntry[], window: number, mode: string) {
  const priorByHash = new Map<string, MappingRow[]>();
  for (const row of priorRows) { const queue = priorByHash.get(row.projectedHash) ?? []; queue.push(row); priorByHash.set(row.projectedHash, queue); }
  const rawMatches = matchMessages(messages, registry);
  const contentHashes = new Set(branch.flatMap(entry => entry.type === "custom" && entry.customType === CONTENT_V2 ? [(entry.data as any)?.hash] : []));
  const blobs: Array<{type:"custom"; customType:string; data:unknown}> = [];
  const rows = messages.map((message, index): MappingRow => {
    const projectedHash = hash(message), prior = priorByHash.get(projectedHash)?.shift(), source = rawMatches[index];
    if (prior) return prior;
    const row: MappingRow = { sourceId: source?.sourceId ?? `request:${projectedHash}`, sourceEntryId: source?.entry.id ?? null,
      messageIndex: source?.messageIndex ?? 0, role: message.role, ...(message.role === "toolResult" ? {toolName:message.toolName} : {}),
      representation:"EXACT", desiredRepresentation:"EXACT", rawTokens:tokens(message), projectedTokens:tokens(message),
      sourceHash:projectedHash, projectedHash, reason:source ? "Exact hook output" : "Request-local prompt / extension content",
      bornTurn:source?.bornTurn ?? 0, lastUseTurn:source?.lastUseTurn ?? 0, generation:0, preview:text(message).slice(0,160) };
    if (!source) {
      row.contentRef = projectedHash;
      if (!contentHashes.has(projectedHash)) {
        // Content-addressed prompt/extension fragments are stored only once. Giant fragments
        // are explicitly unavailable after restart; never present a preview as full input.
        blobs.push({type:"custom", customType:CONTENT_V2, data:{hash:projectedHash,
          ...(bytes(message) <= 128*1024 ? {message} : {unavailable:"Request-local fragment exceeds archival limit"})}});
        contentHashes.add(projectedHash);
      }
    }
    return row;
  });
  const previous = codec.replaySnapshots(branch);
  // Reuse unchanged runs anywhere, including behind a changing system message. A pure
  // prefix delta would otherwise repeat every source mapping on each prompt change.
  const previousIndices=new Map<string,number[]>();
  if(previous)for(const [index,row] of previous.rows.entries()){const key=hash(row),q=previousIndices.get(key)??[];q.push(index);previousIndices.set(key,q);}
  const segments:Array<{from:number;count:number}|{rows:MappingRow[]}>=[];
  for(const row of rows){
    const from=previousIndices.get(hash(row))?.shift(),last=segments.at(-1);
    if(from!==undefined){if(last&&"from" in last&&last.from+last.count===from)last.count++;else segments.push({from,count:1});}
    else {if(last&&"rows" in last)last.rows.push(row);else segments.push({rows:[row]});}
  }
  const projectedTokens = messages.reduce((n,message)=>n+tokens(message),0);
  const rawEquivalent = branch.filter(e=>e.type==="message").reduce((n,e)=>n+tokens((e as any).message),0)
    + rows.filter(row=>row.role==="system"&&!row.sourceEntryId).reduce((n,row)=>n+row.rawTokens,0);
  const requestId = randomUUID();
  const totals = { rawTokens:rawEquivalent, projectedTokens, reduction:rawEquivalent ? 1-projectedTokens/rawEquivalent : 0, window,
    exactTokens:rows.filter(r=>r.representation==="EXACT"&&r.role!=="system").reduce((n,r)=>n+r.projectedTokens,0),
    capsuleTokens:rows.filter(r=>r.representation==="CAPSULE").reduce((n,r)=>n+r.projectedTokens,0),
    coldEquivalentTokens:rows.filter(r=>r.representation==="COLD").reduce((n,r)=>n+r.rawTokens,0),
    frameTokens:rows.filter(r=>r.role==="system").reduce((n,r)=>n+r.projectedTokens,0),
    coldRefTokens:rows.filter(r=>r.representation==="COLD").reduce((n,r)=>n+r.projectedTokens,0) };
  return { rows, totals, requestId, drafts:[...blobs, {type:"custom" as const, customType:SNAPSHOT_V2,
    data:{schemaVersion:2, turn:state.turn+1, requestId, generation:state.generation, mode, hook:"context_with_system",
      outputHash:hash(messages), messageCount:rows.length, prefixRequestId:previous?.requestId ?? null, segments, totals}}] };
}
