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

test("queues a remote approval when no session page is open and replays it on subscription", () => {
  const registry = new Registry();
  const pi = socket();
  registry.register(pi, { sessionId: "s", instanceId: "pi-1", pid: 1, cwd: "/tmp" });
  assert.equal(registry.approvalRequest("s", "pi-1", { requestId: "approval-2", toolName: "bash" }), true);
  assert.equal(registry.sessions.get("s").approvals.size, 1);
  const browser = socket();
  registry.subscribe(browser, "s");
  assert.deepEqual(browser.frames.map(frame => frame.type), ["session_available", "approval_request"]);
  assert.equal(browser.frames[1].requestId, "approval-2");
  assert.deepEqual(registry.respondApproval("s", "approval-2", "Deny"), {});
  assert.deepEqual(pi.frames.at(-1), { type: "approval_choice", requestId: "approval-2", choice: "Deny" });
});

test("routes Design Intent accept and reasoned reject choices only to their proposal origin", () => {
  const registry = new Registry();
  const pi = socket(), browser = socket();
  registry.register(pi, { sessionId: "s", instanceId: "pi-1", pid: 1, cwd: "/tmp" });
  registry.subscribe(browser, "s");
  const proposal = { kind: "design-intent", requestId: "proposal-1", proposalId: "DIP-123", proposalHash: "p-hash", storePath: "/tmp/.pi/design-intent.json", baseRevision: 2, sourceHash: "s-hash", candidateHash: "c-hash", statement: "Preserve the API", rationale: "Clients depend on it", acceptDiff: "+ DI-0003", effects: "Atomic project file replacement" };
  assert.equal(registry.approvalRequest("s", "pi-1", proposal), true);
  assert.equal(browser.frames.at(-1).kind, "design-intent");
  assert.match(browser.frames.at(-1).acceptDiff, /DI-0003/);
  assert.match(registry.respondApproval("s", "proposal-1", "Reject").error, /reason/);
  assert.deepEqual(registry.respondApproval("s", "proposal-1", "Reject", "Does not fit"), {});
  assert.deepEqual(pi.frames.at(-1), { type: "approval_choice", requestId: "proposal-1", choice: "Reject", reason: "Does not fit" });
  assert.deepEqual(registry.respondApproval("s", "proposal-1", "Accept"), { error: "Approval request is no longer active" });
});

test("notifies a session page that opened before its Pi instance registered", () => {
  const registry = new Registry();
  const browser = socket();
  registry.clients.add({ ws: browser, sessionId: "s" });
  registry.register(socket(), { sessionId: "s", instanceId: "pi-1", pid: 1, cwd: "/tmp" });
  assert.equal(browser.frames.at(-1).type, "session_available");
  assert.equal(browser.frames.at(-1).sessionId, "s");
});
