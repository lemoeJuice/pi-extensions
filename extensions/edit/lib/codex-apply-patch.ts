import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isWithinDirectory, parseCodexPatch, resolvePatchTarget } from "../../shared/patch/codex.ts";
import type { UpdateChunk } from "../../shared/patch/codex.ts";

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
    const sourcePath = await resolvePatchTarget(root, operation.path);
    if (!allowOutsideWorkingDirectory && !isWithinDirectory(root, sourcePath)) throw new Error(`Patch path is outside the working directory: ${operation.path}`);
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
        const destination = await resolvePatchTarget(root, operation.moveTo);
        if (!allowOutsideWorkingDirectory && !isWithinDirectory(root, destination)) throw new Error(`Patch destination is outside the working directory: ${operation.moveTo}`);
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
