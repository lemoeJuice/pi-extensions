import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ProjectedSessionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { hash, text, textOnly, tokens } from "./common.ts";
import { TELEMETRY_V2, type Evidence, type ProjectionState } from "./types.ts";

/** Ingest the host-authorized projection, never resurrect an omitted raw source. */
export function evidenceRegistry(branch: SessionEntry[], projection: ProjectedSessionEntry[], sessionId: string, state: ProjectionState): Map<string, Evidence> {
  const born = new Map<string, number>();
  const calls = new Map<string, { name: string; arguments: Record<string, unknown> }>();
  let turn = 0;
  for (const entry of branch) {
    born.set(entry.id, turn);
    if (entry.type === "custom" && [TELEMETRY_V2, "rolling-context.telemetry.v1"].includes(entry.customType))
      turn = Math.max(turn, Number((entry.data as any)?.turn) || 0);
  }
  for (const entry of projection) for (const message of entry.messages) if (message.role === "assistant")
    for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, { name: part.name, arguments: part.arguments });
  const out = new Map<string, Evidence>();
  for (const projected of projection) for (const [index, message] of projected.messages.entries()) {
    const sourceId = index ? `${projected.sourceEntry.id}:${index}` : projected.sourceEntry.id;
    const call = message.role === "toolResult" ? calls.get(message.toolCallId) : undefined;
    const entities = new Set<string>();
    if (typeof call?.arguments.path === "string") entities.add(call.arguments.path);
    if (message.role === "toolResult") {
      const changes = (message.details as any)?.changes;
      if (Array.isArray(changes)) for (const change of changes) if (typeof change?.path === "string") entities.add(change.path);
    }
    const di = message.role === "custom" && message.customType === "design-intent.projection.v1"
      || message.role === "toolResult" && (message.details as any)?.projection?.type === "design-intent.projection.v1";
    const pinned = message.role === "user" || message.role === "system" || !!di;
    const reducible = !pinned && textOnly(message) && (message.role === "assistant" || message.role === "toolResult")
      && !(message.role === "toolResult" && message.isError);
    const sourceHash = hash(message);
    const previous = state.sources.get(sourceId);
    out.set(sourceId, { sourceId, sessionId, sourceHash, message, entry: projected.sourceEntry, messageIndex: index,
      bornTurn: born.get(projected.sourceEntry.id) ?? state.turn,
      lastUseTurn: previous?.sourceHash === sourceHash ? previous.lastUseTurn : born.get(projected.sourceEntry.id) ?? state.turn,
      rawTokens: tokens(message), entities: [...entities], call, pinned, reducible });
  }
  return out;
}

/** Match only unchanged messages in the incoming hook. Foreign transforms remain authoritative. */
export function matchMessages(messages: AgentMessage[], registry: Map<string, Evidence>): Array<Evidence | undefined> {
  const queues = new Map<string, Evidence[]>();
  for (const source of registry.values()) {
    const queue = queues.get(source.sourceHash) ?? []; queue.push(source); queues.set(source.sourceHash, queue);
  }
  return messages.map(message => queues.get(hash(message))?.shift());
}

export function referencedSources(messages: AgentMessage[], registry: Map<string, Evidence>): Set<string> {
  const result = new Set<string>();
  const recent = messages.slice(-8).map(text).join("\n");
  for (const source of registry.values()) if (recent.includes(source.sourceId)) result.add(source.sourceId);
  return result;
}
