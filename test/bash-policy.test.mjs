import test from "node:test";
import assert from "node:assert/strict";
import { analyzeBashCommand } from "../extensions/permissions/lib/bash-policy.ts";

test("allows configured simple read-only Bash commands", () => {
  for (const command of ["pwd", "ls -la", "rg TODO src", "git status --short", "git diff --stat"]) {
    assert.equal(analyzeBashCommand(command).reviewReason, undefined, command);
  }
});

test("routes mutations, unknown commands, and shell composition to review", () => {
  for (const command of [
    "rm -rf build",
    "pnpm test",
    "echo ok | sh",
    "git reset --hard",
    "find . -exec rm {} \\\;",
    "",
  ]) {
    assert.ok(analyzeBashCommand(command).reviewReason, command || "empty command");
  }
});

test("extracts file operands from allowlisted search commands for workspace checks", () => {
  assert.deepEqual(analyzeBashCommand("grep TODO src/main.ts").filePaths, ["src/main.ts"]);
  assert.deepEqual(analyzeBashCommand("grep -f /etc/patterns /tmp/data").filePaths, ["/etc/patterns", "/tmp/data"]);
  assert.deepEqual(analyzeBashCommand("rg -n 'TODO item' /etc/passwd").filePaths, ["/etc/passwd"]);
  assert.deepEqual(analyzeBashCommand("rg -F 'a|b' src/main.ts").filePaths, ["src/main.ts"]);
  assert.deepEqual(analyzeBashCommand("find . -name '*.ts'").filePaths, ["."]);
  assert.ok(analyzeBashCommand("rg --pre cat needle /tmp").reviewReason);
});
