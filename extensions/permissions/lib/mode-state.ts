export type PermissionMode = "manual" | "auto";
export type ModeScope = "run" | "session";
export const MODE_ENTRY = "permissions.config.v1";
export type ModeState = { mode: PermissionMode; scope: ModeScope | "default"; diagnostic?: string };

// This extension's own process-local state, not another plugin's status Map.
// Survives extension reload, never serialized, and remains keyed by session identity.
const RUN_STATE = Symbol.for("pi-guardrails.permissions.run-modes.v1");
function processModes(): Map<string, PermissionMode> {
  const host = globalThis as any;
  if (!(host[RUN_STATE] instanceof Map)) host[RUN_STATE] = new Map();
  return host[RUN_STATE];
}

export function sessionIdentity(ctx: any) {
  const sessionId = ctx.sessionManager?.getSessionId();
  if (typeof sessionId !== "string" || !sessionId) throw new Error("Permission mode requires a valid session identity");
  const sessionFile = ctx.sessionManager.getSessionFile?.();
  return { sessionId, sessionFile, key: JSON.stringify([sessionId, sessionFile ?? ctx.cwd]) };
}

export function restoreMode(entries: readonly any[], sessionId: string): ModeState {
  let state: ModeState = { mode: "manual", scope: "default" };
  // Operator preference is session-wide, not branch/task state. Tree navigation
  // must not resurrect an older auto setting. Forked/copied entries have another owner.
  for (const entry of entries) {
    if (entry.type !== "custom" || typeof entry.customType !== "string" || !entry.customType.startsWith("permissions.config.")) continue;
    const data = entry.data;
    if (typeof data?.sessionId === "string" && data.sessionId !== sessionId) continue;
    if (entry.customType !== MODE_ENTRY || !data || data.schemaVersion !== 1 || data.sessionId !== sessionId || !["manual", "auto"].includes(data.mode)) {
      state = { mode: "manual", scope: "default", diagnostic: "Invalid or unsupported saved permission mode; using manual review." };
    } else state = { mode: data.mode, scope: "session" };
  }
  return state;
}

export class PermissionModes {
  private runModes: Map<string, PermissionMode>;
  constructor(runModes = processModes()) { this.runModes = runModes; }
  get(ctx: any): ModeState {
    const { sessionId, key } = sessionIdentity(ctx);
    const run = this.runModes.get(key);
    if (run === "manual" || run === "auto") return { mode: run, scope: "run" };
    return restoreMode(ctx.sessionManager.getEntries(), sessionId);
  }
  setRun(ctx: any, mode: PermissionMode) { this.runModes.set(sessionIdentity(ctx).key, mode); }
  clearRun(ctx: any) { this.runModes.delete(sessionIdentity(ctx).key); }
  clearAllRun() { this.runModes.clear(); }
}
