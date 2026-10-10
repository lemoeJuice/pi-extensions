import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { hash, replaceText, text, tokens } from "./common.ts";
import { matchMessages } from "./evidence.ts";
import type { Candidate, Evidence, MappingRow, ProjectionConfig, ProjectionState, Representation } from "./types.ts";

export function representedMessage(source: Evidence, state: ProjectionState, representation?: Representation): AgentMessage {
  const record = state.sources.get(source.sourceId);
  if (!record || record.sourceHash !== source.sourceHash) return source.message;
  const rep = representation ?? record.committedRepresentation;
  if (rep === "EXACT" || !record.capsule) return source.message;
  if (rep === "CAPSULE") return replaceText(source.message, record.capsule.text);
  // Keep the tool protocol skeleton in chronology. COLD evidence itself is not resident.
  return replaceText(source.message, `[Cold evidence source=${source.entry.id}; context_recall(entryId="${source.entry.id}") for raw.]`);
}

export function materialize(messages: AgentMessage[], registry: Map<string, Evidence>, state: ProjectionState, mode: ProjectionConfig["mode"]) {
  const matches = matchMessages(messages, registry);
  const rows: MappingRow[] = [];
  const projected = messages.map((message, index) => {
    const source = matches[index], record = source && state.sources.get(source.sourceId);
    const applicable = mode === "on" && source && record?.sourceHash === source.sourceHash;
    const result = applicable ? representedMessage(source, state) : message;
    rows.push({ sourceId: source?.sourceId ?? `request:${hash(message)}:${index}`, sourceEntryId: source?.entry.id ?? null,
      messageIndex: source?.messageIndex ?? 0, role: message.role, ...(message.role === "toolResult" ? { toolName: message.toolName } : {}),
      representation: applicable ? record.committedRepresentation : "EXACT", desiredRepresentation: record?.desiredRepresentation ?? "EXACT",
      rawTokens: source?.rawTokens ?? tokens(message), projectedTokens: tokens(result), sourceHash: hash(message), projectedHash: hash(result),
      reason: applicable ? record.reason : source?.pinned ? "Pinned exact / user or prompt authority" : "Exact incoming context",
      bornTurn: source?.bornTurn ?? state.turn, lastUseTurn: record?.lastUseTurn ?? source?.lastUseTurn ?? state.turn,
      generation: applicable ? record.generation : 0, preview: text(result).slice(0,160) });
    return result;
  });
  return { messages: projected, rows };
}

export function compressionCandidates(messages: AgentMessage[], registry: Map<string, Evidence>, state: ProjectionState, config: ProjectionConfig): Candidate[] {
  const result: Candidate[] = []; let position = 0;
  const matches = matchMessages(messages, registry);
  for (const [index, message] of messages.entries()) {
    const source = matches[index], record = source && state.sources.get(source.sourceId);
    if (source && record?.sourceHash === source.sourceHash && record.capsule && record.desiredRepresentation !== record.committedRepresentation) {
      const current = representedMessage(source, state), desired = representedMessage(source, state, record.desiredRepresentation);
      const saving = tokens(current) - tokens(desired);
      if (saving >= config.minSavingTokens || record.desiredRepresentation === "COLD" && saving > 0 || record.committedRepresentation === "COLD")
        result.push({ sourceId: source.sourceId, current: record.committedRepresentation, desired: record.desiredRepresentation,
          position, saving, rawTokens: source.rawTokens, projectedTokens: tokens(current), semanticRisk: record.desiredRepresentation === "COLD" ? .005 : record.capsule.semanticRisk,
          futureRequests: config.futureRequests, compressionTokens: record.committedRepresentation === "EXACT" ? record.capsule.compressionTokens : 0,
          recallRisk: record.desiredRepresentation === "COLD" ? .01 : 0 });
    }
    position += source ? tokens(representedMessage(source, state)) : tokens(message);
  }
  return result;
}
