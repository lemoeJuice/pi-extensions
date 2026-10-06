'use strict';

class Registry {
  constructor() { this.sessions = new Map(); this.clients = new Set(); this.pendingRequests = new Map(); }
  register(ws, instance) {
    let session = this.sessions.get(instance.sessionId);
    if (!session) {
      session = { sessionId: instance.sessionId, cwd: instance.cwd, model: instance.model, title: instance.title, metadata: instance.metadata, instances: new Map(), approvals: new Map(), events: [], lastActivityAt: Date.now() };
      this.sessions.set(instance.sessionId, session);
    }
    session.sessionFile = instance.sessionFile || session.sessionFile;
    session.leafId = instance.leafId || session.leafId;
    instance.connectedAt = Date.now();
    instance.status = 'idle';
    const conflict = session.instances.size > 0;
    instance.writable = !conflict;
    session.instances.set(instance.instanceId, { ws, ...instance });
    session.cwd = instance.cwd || session.cwd;
    session.model = instance.model || session.model;
    session.title = instance.title || session.title;
    session.metadata = instance.metadata || session.metadata;
    session.lastActivityAt = Date.now();
    this.broadcastList();
    const available = JSON.stringify({ type: 'session_available', sessionId: instance.sessionId });
    for (const client of this.clients) if (client.sessionId === instance.sessionId && client.ws.readyState === 1) client.ws.send(available);
    return { writable: instance.writable, conflict };
  }
  unregister(sessionId, instanceId) {
    const s = this.sessions.get(sessionId); if (!s) return;
    for (const [requestId, approval] of s.approvals) {
      if (approval.instanceId !== instanceId) continue;
      clearTimeout(approval.timer);
      s.approvals.delete(requestId);
      this.broadcastApprovalResolved(sessionId, requestId);
    }
    s.instances.delete(instanceId);
    if (s.instances.size === 0) {
      this.sessions.delete(sessionId);
      this.broadcastList();
      return;
    }
    // Promote only when exactly one connected instance remains.
    for (const i of s.instances.values()) i.writable = s.instances.size === 1;
    s.lastActivityAt = Date.now(); this.broadcastList();
  }
  subscribe(ws, sessionId) {
    const client = { ws, sessionId };
    this.clients.add(client);
    const session = this.sessions.get(sessionId);
    if (session) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'session_available', sessionId }));
      for (const approval of session.approvals.values()) {
        if (ws.readyState === 1) ws.send(JSON.stringify(approval.payload));
      }
    }
    return client;
  }
  getSession(sessionId) {
    const s = this.sessions.get(sessionId); if (!s) return null;
    const instances = [...s.instances.values()];
    const statuses = instances.map(i => i.status);
    const status = instances.length > 1 ? 'conflict' : instances.length === 0 ? 'offline' : statuses.includes('error') ? 'error' : statuses.includes('waiting') ? 'waiting' : statuses.includes('running') ? 'running' : 'idle';
    const activeEvents = [];
    for (const instance of instances.filter(i => i.status === 'running')) {
      let start = -1;
      for (let index = s.events.length - 1; index >= 0; index--) {
        if (s.events[index].instanceId === instance.instanceId && s.events[index].type === 'agent_start') { start = index; break; }
      }
      if (start < 0) start = Math.max(0, s.events.length - 100);
      for (const event of s.events.slice(start)) {
        if (event.instanceId === instance.instanceId) activeEvents.push({ type: 'event', sessionId, instanceId: event.instanceId, seq: event.seq, timestamp: event.timestamp, event: event.event });
      }
    }
    return { sessionId: s.sessionId, title: s.title || s.cwd?.split(/[\\/]/).filter(Boolean).pop() || s.sessionId, cwd: s.cwd, model: s.model, metadata: instances.find(i => i.writable)?.metadata || s.metadata, status, live: instances.length > 0, writable: instances.some(i => i.writable), commands: instances.find(i => i.writable)?.commands || [], instances: instances.map(({ ws, sessionFile, commands, ...i }) => i), lastActivityAt: s.lastActivityAt, activeEvents };
  }
  list() { return [...this.sessions.keys()].map(id => this.getSession(id)).filter(s => s?.live).sort((a,b) => rank(a.status)-rank(b.status) || b.lastActivityAt-a.lastActivityAt); }
  event(sessionId, instanceId, event) {
    const s = this.sessions.get(sessionId); if (!s) return;
    const i = s.instances.get(instanceId); if (!i) return;
    if (event.event?.type === 'metadata') {
      i.metadata = event.event.metadata;
      s.metadata = event.event.metadata;
      i.model = event.event.metadata?.model || i.model;
      s.model = event.event.metadata?.model || s.model;
    }
    if (event.event?.entryId) s.leafId = event.event.entryId;
    i.status = event.type === 'agent_start' ? 'running' : event.type === 'agent_end' ? 'waiting' : i.status;
    s.lastActivityAt = Date.now();
    const storedEvent = { ...event, instanceId };
    s.events.push(storedEvent); if (s.events.length > 500) s.events.shift();
    const frame = JSON.stringify({ type: 'event', sessionId, instanceId, seq: event.seq, timestamp: event.timestamp, event: event.event });
    for (const c of this.clients) if (c.sessionId === sessionId && c.ws.readyState === 1) c.ws.send(frame);
    this.broadcastList();
  }
  message(sessionId, text, requestId) {
    const s = this.sessions.get(sessionId); if (!s) return { error: 'Session not found' };
    const instance = [...s.instances.values()].find(i => i.writable && i.ws.readyState === 1);
    if (!instance) return { error: s.instances.size ? 'Session has no writable instance (conflict)' : 'Session is offline' };
    instance.ws.send(JSON.stringify({ type: 'user_message', requestId, text })); return {};
  }
  control(sessionId, message) {
    const s = this.sessions.get(sessionId); if (!s) return { error: 'Session not found' };
    const instance = [...s.instances.values()].find(i => i.writable && i.ws.readyState === 1);
    if (!instance) return { error: s.instances.size ? 'Session has no writable instance (conflict)' : 'Session is offline' };
    instance.ws.send(JSON.stringify(message)); return {};
  }
  request(sessionId, message, timeoutMs = 2000) {
    const s = this.sessions.get(sessionId); if (!s) return Promise.resolve({ error: 'Session not found' });
    const instance = [...s.instances.values()].find(i => i.writable && i.ws.readyState === 1);
    if (!instance) return Promise.resolve({ error: s.instances.size ? 'Session has no writable instance (conflict)' : 'Session is offline' });
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pendingRequests.delete(message.requestId); resolve({ error: 'Pi request timed out' }); }, timeoutMs);
      this.pendingRequests.set(message.requestId, { resolve, timer });
      try { instance.ws.send(JSON.stringify(message)); }
      catch (error) { clearTimeout(timer); this.pendingRequests.delete(message.requestId); resolve({ error: String(error) }); }
    });
  }
  approvalRequest(sessionId, instanceId, request) {
    const s = this.sessions.get(sessionId);
    const instance = s?.instances.get(instanceId);
    if (!s || !instance || !request?.requestId) return false;
    if (s.approvals.has(request.requestId)) return false;
    const kind = request.kind === 'design-intent' ? 'design-intent' : 'permission';
    if (kind === 'design-intent' && (typeof request.proposalId !== 'string' || typeof request.proposalHash !== 'string' || typeof request.sourceHash !== 'string')) return false;
    const payload = kind === 'design-intent'
      ? { type: 'approval_request', kind, sessionId, requestId: request.requestId, proposalId: request.proposalId, proposalHash: request.proposalHash, storePath: request.storePath, baseRevision: request.baseRevision, sourceHash: request.sourceHash, candidateHash: request.candidateHash, statement: request.statement, rationale: request.rationale, effects: request.effects, acceptDiff: request.acceptDiff, acceptUnavailable: request.acceptUnavailable, timestamp: Date.now() }
      : { type: 'approval_request', kind, sessionId, requestId: request.requestId, toolName: request.toolName, intent: request.intent, reason: request.reason, behavior: request.behavior, timestamp: Date.now() };
    const timer = setTimeout(() => {
      if (kind === 'design-intent') this.expireApproval(sessionId, instanceId, request.requestId);
      else this.respondApproval(sessionId, request.requestId, 'Deny');
    }, 120000);
    s.approvals.set(request.requestId, { instanceId, timer, payload });
    for (const client of this.clients) if (client.sessionId === sessionId && client.ws.readyState === 1) client.ws.send(JSON.stringify(payload));
    return true;
  }
  respondApproval(sessionId, requestId, choice, reason) {
    const s = this.sessions.get(sessionId);
    const approval = s?.approvals.get(requestId);
    const instance = approval && s.instances.get(approval.instanceId);
    if (!s || !approval || !instance || instance.ws.readyState !== 1) return { error: 'Approval request is no longer active' };
    const choices = approval.payload.kind === 'design-intent' ? ['Accept', 'Reject'] : ['Allow once', 'Switch to auto', 'Deny'];
    if (!choices.includes(choice)) return { error: 'Invalid approval choice' };
    if (approval.payload.kind === 'design-intent' && choice === 'Reject' && (typeof reason !== 'string' || !reason.trim() || reason.length > 4000)) return { error: 'A rejection reason of at most 4000 characters is required' };
    try { instance.ws.send(JSON.stringify({ type: 'approval_choice', requestId, choice, ...(reason ? { reason } : {}) })); }
    catch (error) { return { error: String(error) }; }
    clearTimeout(approval.timer);
    s.approvals.delete(requestId);
    this.broadcastApprovalResolved(sessionId, requestId, { choice });
    return {};
  }
  dismissApproval(sessionId, instanceId, requestId) {
    const s = this.sessions.get(sessionId), approval = s?.approvals.get(requestId);
    if (!s || !approval || approval.instanceId !== instanceId) return false;
    clearTimeout(approval.timer); s.approvals.delete(requestId);
    this.broadcastApprovalResolved(sessionId, requestId, { dismissed: true });
    return true;
  }
  expireApproval(sessionId, instanceId, requestId) {
    const s = this.sessions.get(sessionId), approval = s?.approvals.get(requestId);
    if (!s || !approval || approval.instanceId !== instanceId) return false;
    const instance = s.instances.get(instanceId);
    clearTimeout(approval.timer); s.approvals.delete(requestId);
    if (instance?.ws.readyState === 1) instance.ws.send(JSON.stringify({ type: 'approval_expired', requestId }));
    this.broadcastApprovalResolved(sessionId, requestId, { expired: true });
    return true;
  }
  broadcastApprovalResolved(sessionId, requestId, result = {}) {
    const frame = JSON.stringify({ type: 'approval_resolved', sessionId, requestId, ...result });
    for (const client of this.clients) if (client.sessionId === sessionId && client.ws.readyState === 1) client.ws.send(frame);
  }
  broadcastApprovalOutcome(sessionId, requestId, outcome) {
    const frame = JSON.stringify({ type: 'approval_resolved', sessionId, requestId, outcome });
    for (const client of this.clients) if (client.sessionId === sessionId && client.ws.readyState === 1) client.ws.send(frame);
  }
  resolveRequest(requestId, result) {
    const pending = this.pendingRequests.get(requestId); if (!pending) return;
    clearTimeout(pending.timer); this.pendingRequests.delete(requestId); pending.resolve(result);
  }
  broadcastList() {
    const data = JSON.stringify({ type: 'sessions', sessions: this.list().map(({ events, activeEvents, ...s }) => s) });
    for (const c of this.clients) if (!c.sessionId && c.ws.readyState === 1) c.ws.send(data);
  }
}
function rank(status) { return ({ waiting: 0, running: 1, idle: 2, error: 3, conflict: 4, offline: 5 })[status] ?? 6; }
module.exports = { Registry };
