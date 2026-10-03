import test from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../extensions/daemon/daemon/registry.js";

function socket() {
  const frames = [];
  return { readyState: 1, frames, send(frame) { frames.push(JSON.parse(frame)); } };
}

test("routes a remote approval choice back to its originating Pi instance", () => {
  const registry = new Registry();
  const pi = socket();
  const browser = socket();
  registry.register(pi, { sessionId: "s", instanceId: "pi-1", pid: 1, cwd: "/tmp" });
  registry.clients.add({ ws: browser, sessionId: "s" });

  assert.equal(registry.approvalRequest("s", "pi-1", {
    requestId: "approval-1", toolName: "bash", intent: "Inspect project", reason: "Command needs review", behavior: "rg TODO .",
  }), true);
  assert.equal(browser.frames[0].type, "approval_request");
  assert.deepEqual(registry.respondApproval("s", "approval-1", "Allow once"), {});
  assert.deepEqual(pi.frames.at(-1), { type: "approval_choice", requestId: "approval-1", choice: "Allow once" });
  assert.equal(browser.frames.at(-1).type, "approval_resolved");
});

test("declines remote approval delivery when no session page is connected", () => {
  const registry = new Registry();
  registry.register(socket(), { sessionId: "s", instanceId: "pi-1", pid: 1, cwd: "/tmp" });
  assert.equal(registry.approvalRequest("s", "pi-1", { requestId: "approval-2" }), false);
  assert.equal(registry.sessions.get("s").approvals.size, 0);
});

test("notifies a session page that opened before its Pi instance registered", () => {
  const registry = new Registry();
  const browser = socket();
  registry.clients.add({ ws: browser, sessionId: "s" });
  registry.register(socket(), { sessionId: "s", instanceId: "pi-1", pid: 1, cwd: "/tmp" });
  assert.equal(browser.frames.at(-1).type, "session_available");
  assert.equal(browser.frames.at(-1).sessionId, "s");
});
