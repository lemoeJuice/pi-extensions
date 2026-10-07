import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { applyCodexPatch } from "./lib/codex-apply-patch.ts";
import { parseCodexPatch } from "../shared/patch/codex.ts";
import { consumeOutsideWorkingDirectoryGrant } from "../shared/mutation-authorization.ts";

const EDIT_GUIDELINES = [
  "The edit tool requires exactly the intent and patch fields. patch must use Codex apply_patch syntax from *** Begin Patch through *** End Patch.",
  "Keep intent to one short phrase; do not repeat the patch or narrate the implementation.",
  "Do not call edit with the native path/edits/oldText/newText format. That format is unsupported; encode changes as *** Update File hunks with context, '-' lines, and '+' lines.",
  "Prefer edit to modify existing text files and for focused file changes.",
  "When creating or rewriting large amounts of content, generating many files, or when content is better generated programmatically, use bash instead.",
];

type Change = { path: string; kind: "add" | "update" | "delete"; before?: string; after?: string };

function asLines(text: string | undefined): string[] {
  if (text === undefined || text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Return changed lines only. Bound the LCS table for large files and fall back to one hunk. */
function changedLines(before: string | undefined, after: string | undefined): { removed: string[]; added: string[] } {
  const oldLines = asLines(before);
  const newLines = asLines(after);
  if (oldLines.length * newLines.length > 100_000) {
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
    let suffix = 0;
    while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines.at(-1 - suffix) === newLines.at(-1 - suffix)) suffix++;
    return {
      removed: oldLines.slice(prefix, oldLines.length - suffix),
      added: newLines.slice(prefix, newLines.length - suffix),
    };
  }

  const rows = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      rows[i][j] = oldLines[i] === newLines[j]
        ? rows[i + 1][j + 1] + 1
        : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      i++;
      j++;
    } else if (rows[i + 1][j] >= rows[i][j + 1]) {
      removed.push(oldLines[i++]);
    } else {
      added.push(newLines[j++]);
    }
  }
  removed.push(...oldLines.slice(i));
  added.push(...newLines.slice(j));
  return { removed, added };
}

function changeStats(change: Change) {
  const { removed, added } = changedLines(change.before, change.after);
  return { path: change.path, kind: change.kind, removed, added, deletions: removed.length, additions: added.length };
}

function patchCallSummary(patchText: string): string {
  try {
    const operations = parseCodexPatch(patchText);
    const headers = operations.map((operation) => {
      if (operation.kind === "add") return `Add ${operation.path} (+${asLines(operation.contents).length})`;
      if (operation.kind === "delete") return `Delete ${operation.path}`;
      const hunks = operation.chunks.map((chunk) => changedLines(chunk.oldLines.join("\n"), chunk.newLines.join("\n")));
      const removed = hunks.reduce((count, hunk) => count + hunk.removed.length, 0);
      const added = hunks.reduce((count, hunk) => count + hunk.added.length, 0);
      return `${operation.moveTo ? `Move ${operation.path} → ${operation.moveTo}` : `Update ${operation.path}`} (+${added} −${removed})`;
    });
    const visible = headers.slice(0, 12);
    if (headers.length > visible.length) visible.push(`${headers.length - visible.length} more file operations`);
    return visible.join("\n");
  } catch {
    return "Invalid patch";
  }
}

function resultSummary(stats: ReturnType<typeof changeStats>[]): string {
  const totalAdded = stats.reduce((sum, item) => sum + item.additions, 0);
  const totalRemoved = stats.reduce((sum, item) => sum + item.deletions, 0);
  const headers = stats.map((item) => `${item.kind}: ${item.path} (+${item.additions} −${item.deletions})`);
  return `Applied ${stats.length} file operation${stats.length === 1 ? "" : "s"} (+${totalAdded} −${totalRemoved}).\n${headers.join("\n")}`;
}

function resultDiff(stats: ReturnType<typeof changeStats>[]): string {
  const diffLines = stats.flatMap((item) => [
    `--- ${item.path}`,
    ...item.removed.map((line) => `- ${line}`),
    ...item.added.map((line) => `+ ${line}`),
  ]);
  const joined = diffLines.join("\n");
  const maxChars = 100_000;
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n[diff truncated at ${maxChars} characters]` : joined;
}

export default function (pi: ExtensionAPI) {
  // This edit implementation supports file creation, so it owns the native write loadout decision.
  pi.on("before_agent_start", () => {
    pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "write"));
  });

  pi.registerTool({
    name: "edit",
    label: "edit",
    description: "Use intent and patch only. patch must be a complete Codex apply_patch document (*** Begin Patch … *** End Patch); native edit's path/edits/oldText/newText arguments are not supported. Supports Add, Delete, Update, @@ context, End of File, and Move to.",
    promptSnippet: "Call edit with {intent, patch}; patch is Codex apply_patch syntax, not native path/edits",
    promptGuidelines: EDIT_GUIDELINES,
    parameters: Type.Object({
      intent: Type.String({ description: "One short phrase stating what this patch accomplishes.", minLength: 1 }),
      patch: Type.String({ description: "Required Codex apply_patch document, beginning with *** Begin Patch and ending with *** End Patch. Do not provide native path/edits/oldText/newText arguments." }),
    }),
    async execute(_id, params: { intent: string; patch: string }, _signal, _onUpdate, ctx) {
      const intent = typeof params.intent === "string" ? params.intent.trim() : "";
      if (!intent) throw new Error("edit requires a non-empty intent; retry with one short phrase stating what the patch accomplishes.");
      const allowOutside = consumeOutsideWorkingDirectoryGrant(params, ctx.cwd, params.patch);
      return withFileMutationQueue(ctx.cwd, async () => {
        const changes = await applyCodexPatch(ctx.cwd, params.patch, allowOutside);
        const stats = changes.map(changeStats);
        const summary = resultSummary(stats);
        const diff = resultDiff(stats);
        return {
          content: [{ type: "text", text: summary }],
          details: { changes: stats.map(({ path, kind, additions, deletions }) => ({ path, kind, additions, deletions })), intent, diff },
        };
      });
    },
    renderCall(args: { intent: string; patch: string }, theme: any) {
      const intent = String(args.intent ?? "(missing intent)").replace(/\s+/g, " ").slice(0, 100);
      return new Text(
        `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", intent)}\n${theme.fg("muted", patchCallSummary(args.patch))}`,
        0,
        0,
      );
    },
    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
      const output = result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
      const details = result.details as { changes?: Array<{ path: string; kind: string; additions: number; deletions: number }>; diff?: string } | undefined;
      const changes = details?.changes ?? [];
      const stats = changes.reduce((total, change) => ({ additions: total.additions + change.additions, deletions: total.deletions + change.deletions }), { additions: 0, deletions: 0 });
      const compact = result.isError
        ? (output.split("\n")[0] || "Edit failed")
        : `Applied ${changes.length} file operation${changes.length === 1 ? "" : "s"} · +${stats.additions} −${stats.deletions} · Ctrl+O to expand`;
      const expandedOutput = `${output}${details?.diff ? `\n\n${details.diff}` : ""}`;
      const display = expanded
        ? expandedOutput.split("\n").map((line: string) => {
          if (line.startsWith("- ")) return theme.fg("error", line);
          if (line.startsWith("+ ")) return theme.fg("success", line);
          if (line.startsWith("Applied ")) return theme.fg("success", line);
          return theme.fg("muted", line);
        }).join("\n")
        : theme.fg(result.isError ? "error" : "success", compact);
      return new Text(display || "Patch applied", 0, 0);
    },
  } as any);
}
