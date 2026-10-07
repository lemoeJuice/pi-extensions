import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCodexPatch } from "../extensions/edit/lib/codex-apply-patch.ts";
import { parseCodexPatch, isPathWithinWorkingDirectory } from "../extensions/shared/patch/codex.ts";

async function withTempDir(fn) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-guardrails-patch-"));
  try {
    await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("parses Codex Add, Update, Delete, Move, and EOF markers", () => {
  const patch = `*** Begin Patch
*** Add File: new.txt
+new content
*** Update File: old.txt
*** Move to: moved.txt
@@ heading
-old line
+new line
*** End of File
*** Delete File: remove.txt
*** End Patch`;
  const operations = parseCodexPatch(patch);
  assert.deepEqual(operations.map((operation) => operation.kind), ["add", "update", "delete"]);
  assert.equal(operations[1].moveTo, "moved.txt");
  assert.equal(operations[1].chunks[0].context, "heading");
  assert.equal(operations[1].chunks[0].eof, true);
});

test("applies update and add operations, preserving file contents", async () => {
  await withTempDir(async (cwd) => {
    await writeFile(join(cwd, "source.txt"), "first\nold\nlast\n");
    const patch = `*** Begin Patch
*** Update File: source.txt
@@
-old
+new
*** Add File: nested/added.txt
+hello
*** End Patch`;
    const changes = await applyCodexPatch(cwd, patch);
    assert.equal(await readFile(join(cwd, "source.txt"), "utf8"), "first\nnew\nlast\n");
    assert.equal(await readFile(join(cwd, "nested/added.txt"), "utf8"), "hello\n");
    assert.equal(changes.length, 2);
  });
});

test("applies move and delete operations", async () => {
  await withTempDir(async (cwd) => {
    await writeFile(join(cwd, "before.txt"), "content\n");
    await writeFile(join(cwd, "delete.txt"), "gone\n");
    const patch = `*** Begin Patch
*** Update File: before.txt
*** Move to: after.txt
@@
 content
*** Delete File: delete.txt
*** End Patch`;
    await applyCodexPatch(cwd, patch);
    assert.equal(await readFile(join(cwd, "after.txt"), "utf8"), "content\n");
    await assert.rejects(readFile(join(cwd, "before.txt")));
    await assert.rejects(readFile(join(cwd, "delete.txt")));
  });
});

test("rejects paths outside the working directory", async () => {
  await withTempDir(async (cwd) => {
    assert.equal(await isPathWithinWorkingDirectory("../outside.txt", cwd), false);
    await assert.rejects(
      applyCodexPatch(cwd, "*** Begin Patch\n*** Add File: ../outside.txt\n+no\n*** End Patch"),
      /outside the working directory/,
    );
  });
});

test("preflights all operations before writing", async () => {
  await withTempDir(async (cwd) => {
    await writeFile(join(cwd, "source.txt"), "old\n");
    const patch = `*** Begin Patch
*** Update File: source.txt
@@
-old
+new
*** Delete File: missing.txt
*** End Patch`;
    await assert.rejects(applyCodexPatch(cwd, patch), /missing file/);
    assert.equal(await readFile(join(cwd, "source.txt"), "utf8"), "old\n");
  });
});
