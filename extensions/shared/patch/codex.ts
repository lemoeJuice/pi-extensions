import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * Codex apply_patch syntax and path-containment semantics shared by extensions.
 * Grammar follows OpenAI Codex's public codex-rs/apply-patch crate:
 * https://github.com/openai/codex/tree/main/codex-rs/apply-patch
 */
export type PatchOperation =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; chunks: UpdateChunk[] };

export interface UpdateChunk {
  context?: string;
  oldLines: string[];
  newLines: string[];
  eof: boolean;
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const EOF = "*** End of File";

function isHeader(line: string, allowLeadingWhitespace = false): boolean {
  // In a change hunk, a leading space means context, even if the text resembles a marker.
  const marker = (allowLeadingWhitespace ? line.trimStart() : line).trimEnd();
  return marker === END || marker.startsWith(ADD) || marker.startsWith(DELETE) || marker.startsWith(UPDATE);
}

/** Parse Codex apply_patch text (Begin/End Patch, Add/Delete/Update File, @@ chunks). */
export function parseCodexPatch(input: string): PatchOperation[] {
  let lines = input.trim().replace(/\r\n/g, "\n").split("\n");
  if (lines.length >= 4 && /^<<\s*['\"]?EOF['\"]?\s*$/.test(lines[0]) && lines.at(-1)?.trim() === "EOF") {
    lines = lines.slice(1, -1).map((line) => line);
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  }
  if (lines[0]?.trim() !== BEGIN) throw new Error(`The first line of the patch must be '${BEGIN}'`);
  if (lines.at(-1)?.trim() !== END) throw new Error(`The last line of the patch must be '${END}'`);

  const operations: PatchOperation[] = [];
  let index = 1;
  if (lines[index]?.trim().startsWith("*** Environment ID:")) {
    const env = lines[index].trim().slice("*** Environment ID:".length).trim();
    if (!env) throw new Error("apply_patch environment_id cannot be empty");
    index++;
  }

  while (index < lines.length - 1) {
    const header = lines[index].trim();
    if (header === END) break;
    if (header.startsWith(ADD)) {
      const path = header.slice(ADD.length);
      if (!path) throw new Error("Add File requires a path");
      index++;
      const content: string[] = [];
      while (index < lines.length - 1 && !isHeader(lines[index], true)) {
        if (!lines[index].startsWith("+")) throw new Error(`Invalid Add File line ${index + 1}: expected '+'`);
        content.push(lines[index].slice(1));
        index++;
      }
      operations.push({ kind: "add", path, contents: content.length ? `${content.join("\n")}\n` : "" });
      continue;
    }
    if (header.startsWith(DELETE)) {
      const path = header.slice(DELETE.length);
      if (!path) throw new Error("Delete File requires a path");
      operations.push({ kind: "delete", path });
      index++;
      continue;
    }
    if (header.startsWith(UPDATE)) {
      const path = header.slice(UPDATE.length);
      if (!path) throw new Error("Update File requires a path");
      index++;
      let moveTo: string | undefined;
      if (lines[index]?.startsWith(MOVE)) {
        moveTo = lines[index].slice(MOVE.length).trim();
        if (!moveTo) throw new Error("Move to requires a destination path");
        index++;
      }
      const chunks: UpdateChunk[] = [];
      while (index < lines.length - 1 && !isHeader(lines[index])) {
        const line = lines[index];
        const trimmedEnd = line.trimEnd();
        if (trimmedEnd === "@@" || trimmedEnd.startsWith("@@ ")) {
          const context = trimmedEnd === "@@" ? undefined : trimmedEnd.slice(3);
          if (chunks.at(-1) && !chunks.at(-1)!.oldLines.length && !chunks.at(-1)!.newLines.length) {
            throw new Error("Unexpected @@ marker in an empty update hunk");
          }
          chunks.push({ context, oldLines: [], newLines: [], eof: false });
          index++;
          continue;
        }
        if (trimmedEnd === EOF) {
          const chunk = chunks.at(-1);
          if (!chunk || (!chunk.oldLines.length && !chunk.newLines.length)) throw new Error("Update hunk does not contain any lines");
          chunk.eof = true;
          index++;
          continue;
        }
        if (chunks.at(-1)?.eof && line === "") {
          index++;
          continue;
        }
        if (!chunks.length) chunks.push({ oldLines: [], newLines: [], eof: false });
        const chunk = chunks.at(-1)!;
        if (line.startsWith(" ")) {
          const text = line.slice(1);
          chunk.oldLines.push(text);
          chunk.newLines.push(text);
        } else if (line.startsWith("+")) {
          chunk.newLines.push(line.slice(1));
        } else if (line.startsWith("-")) {
          chunk.oldLines.push(line.slice(1));
        } else if (line === "") {
          chunk.oldLines.push("");
          chunk.newLines.push("");
        } else {
          throw new Error(`Invalid update hunk line ${index + 1}: expected context, '+' or '-' line`);
        }
        index++;
      }
      if (!chunks.length || chunks.some((chunk) => !chunk.oldLines.length && !chunk.newLines.length)) {
        throw new Error(`Update file hunk for '${path}' is empty`);
      }
      operations.push({ kind: "update", path, moveTo, chunks });
      continue;
    }
    throw new Error(`Invalid apply_patch hunk header at line ${index + 1}: ${lines[index]}`);
  }
  return operations;
}

export function patchPaths(patch: string): string[] {
  return parseCodexPatch(patch).flatMap((operation) =>
    operation.kind === "update" && operation.moveTo
      ? [operation.path, operation.moveTo]
      : [operation.path],
  );
}

export async function resolvePatchTarget(root: string, patchPath: string): Promise<string> {
  if (!patchPath.trim()) throw new Error("Patch file path cannot be empty");
  const target = isAbsolute(patchPath) ? resolve(patchPath) : resolve(root, patchPath);
  // Resolve existing ancestors as well as the final path so a symlink cannot silently
  // turn an apparently in-workspace patch into an out-of-workspace file operation.
  let cursor = target;
  const tail: string[] = [];
  while (true) {
    try {
      const resolved = await realpath(cursor);
      return resolve(resolved, ...tail.reverse());
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error(`Cannot resolve patch path: ${patchPath}`);
      tail.push(cursor.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
      cursor = parent;
    }
  }
}

export function isWithinDirectory(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel));
}

export async function isPathWithinWorkingDirectory(path: string, cwd: string): Promise<boolean> {
  const root = await realpath(cwd);
  const target = await resolvePatchTarget(root, path);
  return isWithinDirectory(root, target);
}

