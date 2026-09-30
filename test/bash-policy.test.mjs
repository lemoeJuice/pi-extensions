import test from "node:test";
import assert from "node:assert/strict";
import { bashReviewReason } from "../extensions/permissions/lib/bash-policy.ts";

test("allows configured simple read-only Bash commands", () => {
  for (const command of ["pwd", "ls -la", "rg TODO src", "git status --short", "git diff --stat"]) {
    assert.equal(bashReviewReason(command), undefined, command);
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
    assert.ok(bashReviewReason(command), command || "empty command");
  }
});
