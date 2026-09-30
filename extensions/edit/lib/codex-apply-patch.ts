import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * Codex apply_patch-compatible parser and local filesystem applier.
 * Grammar/semantics are based on OpenAI Codex's public codex-rs/apply-patch crate:
 * https://github.com/openai/codex/tree/main/codex-rs/apply-patch
 */
export type PatchOperation =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; chunks: UpdateChunk[] };

interface UpdateChunk {
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

async function resolvedTarget(root: string, patchPath: string): Promise<string> {
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

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel));
}

export async function isPathWithinWorkingDirectory(path: string, cwd: string): Promise<boolean> {
  const root = await realpath(cwd);
  const target = await resolvedTarget(root, path);
  return isWithin(root, target);
}

function findSequence(lines: string[], pattern: string[], start: number, eof: boolean): number {
  if (!pattern.length) return eof ? lines.length : start;
  const exact = (at: number, mode: "exact" | "right" | "trim") =>
    pattern.every((line, offset) => {
      const source = lines[at + offset];
      if (source === undefined) return false;
      if (mode === "exact") return source === line;
      if (mode === "right") return source.trimEnd() === line.trimEnd();
      return source.trim() === line.trim();
    });
  const starts = eof ? [Math.max(0, lines.length - pattern.length), start] : [start];
  for (const mode of ["exact", "right", "trim"] as const) {
    for (const begin of starts) {
      for (let at = begin; at <= lines.length - pattern.length; at++) if (exact(at, mode)) return at;
    }
  }
  return -1;
}

function applyUpdate(contents: string, chunks: UpdateChunk[], path: string): string {
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = /\r?\n$/.test(contents);
  const source = contents.replace(/\r\n/g, "\n");
  const originalLines = source.split("\n");
  if (hadFinalNewline) originalLines.pop();
  const replacements: Array<{ start: number; oldLength: number; newLines: string[] }> = [];
  let cursor = 0;

  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      const contextIndex = findSequence(originalLines, [chunk.context], cursor, false);
      if (contextIndex < 0) throw new Error(`Failed to find context '${chunk.context}' in ${path}`);
      cursor = contextIndex + 1;
    }
    let match = findSequence(originalLines, chunk.oldLines, cursor, chunk.eof);
    let oldLines = chunk.oldLines;
    let newLines = chunk.newLines;
    // Codex accepts an extra empty old line as a representation of a final newline.
    if (match < 0 && oldLines.at(-1) === "") {
      oldLines = oldLines.slice(0, -1);
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
      match = findSequence(originalLines, oldLines, cursor, chunk.eof);
    }
    if (match < 0) throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`);
    replacements.push({ start: match, oldLength: oldLines.length, newLines });
    cursor = match + oldLines.length;
  }

  const result = [...originalLines];
  for (const replacement of replacements.reverse()) {
    result.splice(replacement.start, replacement.oldLength, ...replacement.newLines);
  }
  const body = result.join("\n");
  // Codex's default apply-patch update mode normalizes edited files to end in a newline.
  return body.replace(/\n/g, newline) + newline;
}

interface PlannedChange { path: string; kind: "add" | "update" | "delete"; before?: string; after?: string }

/** Validate and apply all Codex patch operations. Files are staged in memory before writes. */
export async function applyCodexPatch(cwd: string, patch: string, allowOutsideWorkingDirectory = false): Promise<PlannedChange[]> {
  const root = await realpath(cwd);
  const operations = parseCodexPatch(patch);
  if (!operations.length) throw new Error("No files were modified.");
  const staged = new Map<string, string | null>();
  const changes = new Map<string, PlannedChange>();
  const readCurrent = async (target: string): Promise<string | null> => {
    if (staged.has(target)) return staged.get(target)!;
    try {
      const buffer = await readFile(target);
      if (buffer.includes(0)) throw new Error(`Cannot apply text patch to binary file: ${target}`);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      staged.set(target, text);
      return text;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        staged.set(target, null);
        return null;
      }
      throw error;
    }
  };

  for (const operation of operations) {
    const sourcePath = await resolvedTarget(root, operation.path);
    if (!allowOutsideWorkingDirectory && !isWithin(root, sourcePath)) throw new Error(`Patch path is outside the working directory: ${operation.path}`);
    if (operation.kind === "add") {
      const before = await readCurrent(sourcePath);
      staged.set(sourcePath, operation.contents);
      changes.set(sourcePath, { path: operation.path, kind: before === null ? "add" : "update", before: before ?? undefined, after: operation.contents });
    } else if (operation.kind === "delete") {
      const before = await readCurrent(sourcePath);
      if (before === null) throw new Error(`Cannot delete missing file: ${operation.path}`);
      const info = await lstat(sourcePath);
      if (info.isDirectory()) throw new Error(`Cannot delete directory: ${operation.path}`);
      staged.set(sourcePath, null);
      changes.set(sourcePath, { path: operation.path, kind: "delete", before });
    } else {
      const before = await readCurrent(sourcePath);
      if (before === null) throw new Error(`Cannot update missing file: ${operation.path}`);
      const after = applyUpdate(before, operation.chunks, operation.path);
      if (operation.moveTo) {
        const destination = await resolvedTarget(root, operation.moveTo);
        if (!allowOutsideWorkingDirectory && !isWithin(root, destination)) throw new Error(`Patch destination is outside the working directory: ${operation.moveTo}`);
        staged.set(destination, after);
        staged.set(sourcePath, null);
        changes.set(sourcePath, { path: operation.path, kind: "delete", before });
        changes.set(destination, { path: operation.moveTo, kind: "add", after });
      } else {
        staged.set(sourcePath, after);
        changes.set(sourcePath, { path: operation.path, kind: "update", before, after });
      }
    }
  }

  // Preflight every destination before writing, then stage each file and rename atomically.
  for (const [target, text] of staged) {
    if (text === null) continue;
    await mkdir(dirname(target), { recursive: true });
  }
  const writtenTemps: string[] = [];
  try {
    for (const [target, text] of staged) {
      if (text === null) continue;
      const temp = `${target}.pi-patch-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
      await writeFile(temp, text, { flag: "wx" });
      writtenTemps.push(temp);
      await rename(temp, target);
      writtenTemps.pop();
    }
    for (const [target, text] of staged) if (text === null) await rm(target);
  } finally {
    await Promise.all(writtenTemps.map((temp) => rm(temp, { force: true }).catch(() => undefined)));
  }
  return [...changes.values()];
}
