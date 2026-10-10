import type { Candidate, CommitPlan, ProjectionConfig } from "./types.ts";
import { capacity } from "./aging.ts";

/** Choose a mutation frontier; the causal KV suffix cost is paid once per batch. */
export function planCommit(candidates: Candidate[], projectedTokens: number, config: ProjectionConfig): CommitPlan {
  const availableCapacity = capacity(config), occupancy = projectedTokens / Math.max(1, availableCapacity);
  const base: CommitPlan = { changes: [], pendingCompressionGain: candidates.reduce((n, c) => n + Math.max(0, c.saving), 0),
    savingPerRequest: 0, earliestMutationPosition: null, estimatedInvalidatedSuffixTokens: 0,
    breakEvenRequests: null, score: 0, occupancy, availableCapacity };
  const pressure = Math.max(0, occupancy - .75) * 8;
  const benefit = (c: Candidate) => c.saving * (c.futureRequests + .2 + pressure)
    - c.rawTokens * c.semanticRisk * 2 - c.compressionTokens - c.rawTokens * c.recallRisk;
  // Rehydration after recall is useful even though token savings are negative.
  const eligible = candidates.filter(c => benefit(c) > 0 || c.current === "COLD" && c.desired !== "COLD").sort((a,b) => a.position - b.position);
  let best = base;
  for (const frontier of eligible) {
    const changes = eligible.filter(c => c.position >= frontier.position);
    const suffix = Math.max(0, projectedTokens - frontier.position);
    const saving = changes.reduce((n, c) => n + c.saving, 0);
    const score = changes.reduce((n, c) => n + benefit(c), 0) - suffix;
    const recalling = changes.some(c => c.current === "COLD" && c.desired !== "COLD");
    const capacityRequired = occupancy >= .95 && saving > 0;
    if (!recalling && !capacityRequired && (score <= 0 || saving < config.minBatchSavingTokens)) continue;
    if (best.changes.length && !capacityRequired && !recalling && score <= best.score) continue;
    // Under imminent pressure prefer the batch that saves more, not an arbitrary target size.
    if (capacityRequired && best.changes.length && saving <= best.savingPerRequest) continue;
    best = { ...base, changes, savingPerRequest: saving, earliestMutationPosition: frontier.position,
      estimatedInvalidatedSuffixTokens: suffix, breakEvenRequests: saving > 0
        ? (suffix + changes.reduce((n,c) => n + c.compressionTokens + c.rawTokens * (c.semanticRisk * 2 + c.recallRisk), 0)) / saving : null, score };
  }
  return best;
}
