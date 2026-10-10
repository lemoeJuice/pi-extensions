import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type Representation = "EXACT" | "CAPSULE" | "COLD";
export interface ProjectionConfig {
  mode: "on" | "observe" | "off";
  contextWindow: number;
  reserveTokens: number;
  minSavingTokens: number;
  minBatchSavingTokens: number;
  exactAge: number;
  coldAge: number;
  futureRequests: number;
  recallMaxTokens: number;
}
export const DEFAULT_CONFIG: ProjectionConfig = {
  mode: "on", contextWindow: 272000, reserveTokens: 16384,
  minSavingTokens: 256, minBatchSavingTokens: 512,
  exactAge: 3, coldAge: 16, futureRequests: 12, recallMaxTokens: 2000,
};
export interface Capsule {
  text: string;
  semanticRisk: number;
  compressionTokens: number;
  coldSafe: boolean;
  reducer: "specialized" | "generic-extractive" | "generic-semantic";
}
export interface Evidence {
  sourceId: string;
  sessionId: string;
  sourceHash: string;
  message: AgentMessage;
  entry: SessionEntry;
  messageIndex: number;
  bornTurn: number;
  lastUseTurn: number;
  rawTokens: number;
  entities: string[];
  call?: { name: string; arguments: Record<string, unknown> };
  pinned: boolean;
  reducible: boolean;
}
export interface RepresentationState {
  sourceId: string;
  sourceHash: string;
  desiredRepresentation: Representation;
  committedRepresentation: Representation;
  capsule?: Capsule;
  reason: string;
  generation: number;
  changedTurn: number;
  lastUseTurn: number;
  retryTurn?: number;
}
export interface ProjectionState {
  generation: number;
  turn: number;
  sources: Map<string, RepresentationState>;
  diagnostics: string[];
}
export interface MappingRow {
  sourceId: string;
  sourceEntryId: string | null;
  messageIndex: number;
  role: string;
  toolName?: string;
  representation: Representation;
  desiredRepresentation: Representation;
  rawTokens: number;
  projectedTokens: number;
  sourceHash: string;
  projectedHash: string;
  reason: string;
  bornTurn: number;
  lastUseTurn: number;
  generation: number;
  preview: string;
  contentRef?: string;
}
export interface Candidate {
  sourceId: string;
  current: Representation;
  desired: Representation;
  position: number;
  saving: number;
  rawTokens: number;
  projectedTokens: number;
  semanticRisk: number;
  futureRequests: number;
  compressionTokens: number;
  recallRisk: number;
}
export interface CommitPlan {
  changes: Candidate[];
  pendingCompressionGain: number;
  savingPerRequest: number;
  earliestMutationPosition: number | null;
  estimatedInvalidatedSuffixTokens: number;
  breakEvenRequests: number | null;
  score: number;
  occupancy: number;
  availableCapacity: number;
}
export const STATE_V2 = "rolling-context.representation.v2";
export const SNAPSHOT_V2 = "rolling-context.projection-snapshot.v2";
export const CONTENT_V2 = "rolling-context.projection-content.v2";
export const TELEMETRY_V2 = "rolling-context.telemetry.v2";
