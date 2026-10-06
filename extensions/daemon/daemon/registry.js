'use strict';
const { UI_VERSION, validSnapshot, validResponse } = require('./ui-protocol');

class Registry {
  constructor() { this.sessions = new Map(); this.clients = new Set(); this.pendingRequests = new Map(); }
  register(ws, instance) {
    let session = this.sessions.get(instance.sessionId);
    if (!session) {
      session = { sessionId: instance.sessionId, cwd: instance.cwd, model: instance.model, title: instance.title, metadata: instance.metadata, instances: new Map(), uiSnapshots: new Map(), events: [], lastActivityAt: Date.now() };
      this.sessions.set(instance.sessionId, session);
    }
    session.sessionFile = instance.sessionFile || session.sessionFile;
    session.leafId = instance.leafId || session.leafId;
    instance.connectedAt = Date.now();
    instance.status = 'idle';
    const previous = session.instances.get(instance.instanceId);
    if (previous && previous.ws !== ws) {
      session.uiSnapshots.delete(instance.instanceId);
      previous.ws.close?.(1008, 'Instance connection replaced');
    }
    const conflict = [...session.instances.keys()].some(id => id !== instance.instanceId);
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
  unregister(sessionId, instanceId, ws) {
    const s = this.sessions.get(sessionId); if (!s) return;
    if (ws && s.instances.get(instanceId)?.ws !== ws) return;
    s.uiSnapshots.delete(instanceId);
    this.broadcastUI(sessionId, { type: 'ui_unavailable', instanceId });
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
      for (const [instanceId, snapshot] of session.uiSnapshots) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ ...snapshot, sessionId, instanceId }));
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
  uiSnapshot(sessionId, instanceId, snapshot) {
    const s = this.sessions.get(sessionId), instance = s?.instances.get(instanceId);
    if (!instance || instance.uiVersion !== UI_VERSION || !validSnapshot(snapshot)) return false;
    const previous = s.uiSnapshots.get(instanceId);
    if (previous?.uiEpoch === snapshot.uiEpoch && previous.revision >= snapshot.revision) return false;
    const stored = { type: 'ui_snapshot', version: UI_VERSION, uiEpoch: snapshot.uiEpoch,
      revision: snapshot.revision, pending: snapshot.pending, status: snapshot.status };
    s.uiSnapshots.set(instanceId, stored);
    this.broadcastUI(sessionId, { ...stored, instanceId });
    return true;
  }
  respondUI(sessionId, uiEpoch, response) {
    const s = this.sessions.get(sessionId);
    const instance = s && [...s.instances.values()].find(i => i.writable && i.ws.readyState === 1);
    const snapshot = instance && s.uiSnapshots.get(instance.instanceId);
    const request = snapshot?.pending.find(item => item.id === response?.id);
    if (!request || snapshot.uiEpoch !== uiEpoch) return { error: 'UI request is stale, unavailable, or not writable' };
    if (!validResponse(request, response)) return { error: 'Invalid UI response' };
    try { instance.ws.send(JSON.stringify({ type: 'ui_response', version: UI_VERSION, uiEpoch, response })); }
    catch (error) { return { error: String(error) }; }
    // Only the Pi broker closes the actual prompt. Sending is not completion.
    return {};
  }
  uiResponseAck(sessionId, instanceId, frame) {
    const snapshot = this.sessions.get(sessionId)?.uiSnapshots.get(instanceId);
    if (frame.version !== UI_VERSION || !snapshot || snapshot.uiEpoch !== frame.uiEpoch || typeof frame.id !== 'string' || typeof frame.accepted !== 'boolean') return;
    this.broadcastUI(sessionId, { type: 'ui_response_ack', instanceId, uiEpoch: frame.uiEpoch, id: frame.id, accepted: frame.accepted });
  }
  uiNotification(sessionId, instanceId, frame) {
    const instance = this.sessions.get(sessionId)?.instances.get(instanceId);
    if (!instance || instance.uiVersion !== UI_VERSION || frame.version !== UI_VERSION || this.sessions.get(sessionId)?.uiSnapshots.get(instanceId)?.uiEpoch !== frame.uiEpoch || typeof frame.message !== 'string' || frame.message.length > 65536 || !['info', 'warning', 'error'].includes(frame.notifyType)) return;
    this.broadcastUI(sessionId, { type: 'ui_notification', instanceId, message: frame.message, notifyType: frame.notifyType });
  }
  broadcastUI(sessionId, frame) {
    const encoded = JSON.stringify({ ...frame, sessionId });
    for (const client of this.clients) if (client.sessionId === sessionId && client.ws.readyState === 1) client.ws.send(encoded);
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
