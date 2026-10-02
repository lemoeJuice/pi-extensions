'use strict';

class Registry {
  constructor() { this.sessions = new Map(); this.clients = new Set(); this.pendingRequests = new Map(); }
  register(ws, instance) {
    let session = this.sessions.get(instance.sessionId);
    if (!session) {
      session = { sessionId: instance.sessionId, cwd: instance.cwd, model: instance.model, title: instance.title, metadata: instance.metadata, instances: new Map(), events: [], lastActivityAt: Date.now() };
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
    return { writable: instance.writable, conflict };
  }
  unregister(sessionId, instanceId) {
    const s = this.sessions.get(sessionId); if (!s) return;
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
