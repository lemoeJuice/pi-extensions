#!/usr/bin/env node
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');
const { Registry } = require('./registry');
const { findSessionFile, readHistory } = require('./history');
const { getDaemonVersion } = require('./version');
const host = process.env.PI_REMOTE_HOST || '100.64.209.124';
const port = Number(process.env.PI_REMOTE_PORT || 4317);
const daemonVersion = getDaemonVersion();
const registry = new Registry();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('Access-Control-Allow-Origin', 'null');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/health') return json(200, { ok: true, daemonVersion, pid: process.pid });
  if (req.method === 'GET' && url.pathname === '/api/sessions') return json(200, registry.list().map(({ events, activeEvents, ...s }) => s));
  const history = url.pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
  if (req.method === 'GET' && history) {
    const sessionId = decodeURIComponent(history[1]);
    const state = registry.sessions.get(sessionId);
    return Promise.resolve(state?.sessionFile || findSessionFile(sessionId))
      .then(sessionFile => {
        if (!sessionFile) throw Object.assign(new Error('Session history is unavailable'), { status: 404 });
        return readHistory(sessionFile, sessionId, state?.leafId, { before: url.searchParams.get('before') || undefined, limit: url.searchParams.get('limit') });
      })
      .then(result => json(200, result))
      .catch(error => json(error.status || 500, { error: error.message || 'Could not read session history' }));
  }
  const commandList = url.pathname.match(/^\/api\/sessions\/([^/]+)\/commands$/);
  if (req.method === 'GET' && commandList) {
    const requestId = require('node:crypto').randomUUID();
    return registry.request(decodeURIComponent(commandList[1]), { type: 'get_commands', requestId })
      .then(result => json(result.error ? 409 : 200, result));
  }
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (req.method === 'GET' && match) { const s = registry.getSession(decodeURIComponent(match[1])); return s ? json(200, s) : json(404, { error: 'Session not found' }); }
  const msg = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (req.method === 'POST' && msg) {
    let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => { let value; try { value = JSON.parse(body); } catch { return json(400, { error: 'Invalid JSON' }); }
      if (typeof value.text !== 'string' || !value.text.trim()) return json(400, { error: 'text is required' });
      const requestId = require('node:crypto').randomUUID(); const result = registry.message(decodeURIComponent(msg[1]), value.text, requestId);
      return result.error ? json(409, result) : json(202, { requestId }); }); return;
  }
  const abort = url.pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/);
  if (req.method === 'POST' && abort) {
    const result = registry.control(decodeURIComponent(abort[1]), { type: 'abort', requestId: require('node:crypto').randomUUID() });
    return json(result.error ? 409 : 202, result.error ? result : { ok: true });
  }
  const command = url.pathname.match(/^\/api\/sessions\/([^/]+)\/commands$/);
  if (req.method === 'POST' && command) {
    let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      let value; try { value = JSON.parse(body); } catch { return json(400, { error: 'Invalid JSON' }); }
      if (typeof value.name !== 'string' || !/^[\w:-]+$/.test(value.name) || (value.args !== undefined && typeof value.args !== 'string')) return json(400, { error: 'Invalid command' });
      const requestId = require('node:crypto').randomUUID();
      return registry.request(decodeURIComponent(command[1]), { type: 'run_command', requestId, name: value.name, args: value.args || '' }, 10000)
        .then(result => json(result.error ? 409 : 202, result.error ? result : { ok: true, result: result.result || 'Command accepted by Pi' }));
    }); return;
  }
  const approval = url.pathname.match(/^\/api\/sessions\/([^/]+)\/approvals$/);
  if (req.method === 'POST' && approval) {
    let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 16 * 1024) req.destroy(); });
    req.on('end', () => {
      let value; try { value = JSON.parse(body); } catch { return json(400, { error: 'Invalid JSON' }); }
      if (typeof value.requestId !== 'string' || !['Allow once', 'Switch to auto', 'Deny'].includes(value.choice)) return json(400, { error: 'Invalid approval response' });
      const result = registry.respondApproval(decodeURIComponent(approval[1]), value.requestId, value.choice);
      return result.error ? json(409, result) : json(202, { ok: true });
    }); return;
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/s/'))) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return fs.createReadStream(path.join(__dirname, '../web/index.html')).pipe(res);
  }
  json(404, { error: 'Not found' });
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname !== '/internal' && pathname !== '/ws/sessions' && !pathname.startsWith('/ws/sessions/')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
wss.on('connection', (ws, req) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname === '/internal') {
    let registered;
    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { ws.send(JSON.stringify({ type: 'error', error: 'Malformed JSON' })); return; }
      if (!registered) {
        if (msg.type !== 'register' || !validInstance(msg.instance)) { ws.send(JSON.stringify({ type: 'error', error: 'register must be the first message' })); return ws.close(1008); }
        registered = msg.instance; const result = registry.register(ws, registered);
        ws.send(JSON.stringify({ type: 'registered', instanceId: registered.instanceId, writable: result.writable, conflict: result.conflict }));
      } else if (msg.type === 'heartbeat') ws.send(JSON.stringify({ type: 'heartbeat_ack', timestamp: Date.now() }));
      else if (msg.type === 'commands' && typeof msg.requestId === 'string') {
        const commands = Array.isArray(msg.commands) ? msg.commands.filter(c => c && typeof c.name === 'string').map(({ name, description, source, requiresArgs }) => ({ name, description, source, requiresArgs: requiresArgs === true })) : [];
        const s = registry.sessions.get(registered.sessionId);
        const instance = s?.instances.get(registered.instanceId);
        if (instance) instance.commands = commands;
        registry.resolveRequest(msg.requestId, { commands });
        registry.broadcastList();
      }
      else if ((msg.type === 'request_ack' || msg.type === 'request_error') && typeof msg.requestId === 'string') registry.resolveRequest(msg.requestId, msg.type === 'request_error' ? { error: msg.error || 'Pi rejected the command' } : { ok: true, result: msg.result });
      else if (msg.type === 'approval_request' && typeof msg.requestId === 'string') {
        const delivered = registry.approvalRequest(registered.sessionId, registered.instanceId, msg);
        ws.send(JSON.stringify({ type: 'approval_delivery', requestId: msg.requestId, delivered }));
      }
      else if (msg.type === 'approval_cancel' && typeof msg.requestId === 'string' && ['Allow once', 'Switch to auto', 'Deny'].includes(msg.choice)) {
        const result = registry.respondApproval(registered.sessionId, msg.requestId, msg.choice);
        if (result.error) ws.send(JSON.stringify({ type: 'approval_cancel_error', requestId: msg.requestId, error: result.error }));
      }
      else if (msg.type === 'event' && Number.isSafeInteger(msg.seq)) registry.event(registered.sessionId, registered.instanceId, { seq: msg.seq, timestamp: Number(msg.timestamp) || Date.now(), type: msg.event?.type || 'event', event: msg.event });
      else if (msg.type === 'status' && ['idle','running','waiting','error'].includes(msg.status)) { const s=registry.sessions.get(registered.sessionId); const i=s?.instances.get(registered.instanceId); if(i)i.status=msg.status; registry.broadcastList(); }
    });
    ws.on('close', () => { if (registered) registry.unregister(registered.sessionId, registered.instanceId); });
    return;
  }
  if (pathname === '/ws/sessions') {
    const client = { ws, sessionId: null }; registry.clients.add(client);
    ws.send(JSON.stringify({ type: 'sessions', sessions: registry.list().map(({ events, ...s }) => s) }));
    ws.on('close', () => registry.clients.delete(client));
    return;
  }
  const sessionId = decodeURIComponent(pathname.slice('/ws/sessions/'.length));
  if (!sessionId) return ws.close(1008);
  const client = { ws, sessionId }; registry.clients.add(client);
  const state = registry.sessions.get(sessionId);
  if (state) ws.send(JSON.stringify({ type: 'session_available', sessionId }));
  for (const approval of state?.approvals.values() || []) ws.send(JSON.stringify(approval.payload));
  ws.on('close', () => registry.clients.delete(client));
});
function validInstance(i) { return i && typeof i.instanceId === 'string' && typeof i.sessionId === 'string' && Number.isInteger(i.pid) && typeof i.cwd === 'string'; }
server.listen(port, host, () => console.log(`[daemon] listening on ${host}:${port}`));
server.on('error', e => { console.error(`[daemon] ${e.message}`); process.exitCode = 1; });
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[daemon] shutting down on ${signal}`);
  for (const client of wss.clients) {
    try { client.close(1012, 'Pi Remote daemon restarting'); } catch { client.terminate(); }
  }
  const forceClose = setTimeout(() => {
    for (const client of wss.clients) client.terminate();
    server.closeAllConnections?.();
  }, 1000);
  forceClose.unref();
  server.close(() => clearTimeout(forceClose));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
