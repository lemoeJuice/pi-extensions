import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import WebSocket from 'ws';

const daemonPath = resolve(__dirname, 'daemon/main.js');
const port = Number(process.env.PI_REMOTE_PORT || 4317);
const host = process.env.PI_REMOTE_HOST || '100.64.209.124';
const httpUrl = `http://${host}:${port}`;
const wsUrl = `ws://${host}:${port}/internal`;
const remoteCommands = [
  { name: 'abort', description: 'Stop the current Pi generation', source: 'remote' },
  { name: 'compact', description: 'Compact the current session context', source: 'remote' },
  { name: 'thinking', description: 'Set thinking level: off, minimal, low, medium, high', source: 'remote' },
  { name: 'name', description: 'Set the session display name', source: 'remote' },
];

async function ensureDaemon() {
  try { const r = await fetch(`${httpUrl}/health`, { signal: AbortSignal.timeout(800) }); if (r.ok) return; } catch { /* start below */ }
  const child = spawn(process.execPath, [daemonPath], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  for (let n = 0; n < 30; n++) {
    await new Promise(r => setTimeout(r, 250));
    try { const r = await fetch(`${httpUrl}/health`, { signal: AbortSignal.timeout(500) }); if (r.ok) return; } catch { /* retry */ }
  }
  throw new Error('Pi Remote daemon did not become available');
}

export default function (pi: ExtensionAPI) {
  let socket: WebSocket | undefined;
  let stopped = false;
  let seq = 0;
  let retry = 1000;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let model: string | undefined;
  let instanceId: string;
  let sessionId: string;
  let cwd: string;
  let sessionFile: string | undefined;
  let streamCounter = 0;
  let currentStreamId: string | undefined;
  const pendingRemoteMessages: Array<{ requestId: string; text: string }> = [];

  pi.on('session_start', async (_event, ctx) => {
    stopped = false; seq = 0; retry = 1000; streamCounter = 0; currentStreamId = undefined;
    cwd = ctx.cwd;
    sessionFile = ctx.sessionManager.getSessionFile();
    sessionId = ctx.sessionManager.getSessionId?.() || (typeof sessionFile === 'string' ? basename(sessionFile).replace(/\.jsonl$/, '') : randomUUID());
    instanceId = `${process.pid}-${randomUUID().slice(0, 8)}`;
    const activeModel = ctx.model;
    model = activeModel ? `${activeModel.provider}/${activeModel.id}` : undefined;
    void connect(ctx);
  });

  async function connect(ctx: any) {
    while (!stopped) {
      try {
        await ensureDaemon();
        if (stopped) break;
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(wsUrl); socket = ws;
          let registered = false;
          ws.on('open', () => ws.send(JSON.stringify({ type: 'register', instance: { instanceId, sessionId, pid: process.pid, cwd, model, title: undefined, startedAt: Date.now(), sessionFile, leafId: ctx.sessionManager.getLeafId(), metadata: collectMetadata(ctx), commands: pi.getCommands().map(({ name, description, source }) => ({ name, description, source })) } })));
          ws.on('message', async data => {
            let msg: any; try { msg = JSON.parse(data.toString()); } catch { return; }
            if (msg.type === 'registered') {
              registered = true; retry = 1000;
              heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() })); }, 10000);
            } else if (msg.type === 'get_commands') {
              const commands = [...remoteCommands, ...pi.getCommands().map(({ name, description, source }) => ({ name, description, source }))];
              ws.send(JSON.stringify({ type: 'commands', requestId: msg.requestId, commands }));
            } else if (msg.type === 'user_message') {
              try { pendingRemoteMessages.push({ requestId: msg.requestId, text: msg.text }); await pi.sendUserMessage(msg.text, { deliverAs: 'steer' }); ws.send(JSON.stringify({ type: 'request_ack', requestId: msg.requestId })); }
              catch (error) { const index = pendingRemoteMessages.findIndex(item => item.requestId === msg.requestId); if (index >= 0) pendingRemoteMessages.splice(index, 1); ws.send(JSON.stringify({ type: 'request_error', requestId: msg.requestId, error: String(error) })); }
            } else if (msg.type === 'abort') {
              try { ctx.abort(); ws.send(JSON.stringify({ type: 'request_ack', requestId: msg.requestId })); }
              catch (error) { ws.send(JSON.stringify({ type: 'request_error', requestId: msg.requestId, error: String(error) })); }
            } else if (msg.type === 'run_command') {
              const args = typeof msg.args === 'string' ? msg.args.trim() : '';
              if (msg.name === 'abort') { ctx.abort(); ws.send(JSON.stringify({ type: 'request_ack', requestId: msg.requestId })); return; }
              if (msg.name === 'compact') { ctx.compact(); ws.send(JSON.stringify({ type: 'request_ack', requestId: msg.requestId })); return; }
              if (msg.name === 'thinking') {
                if (!['off', 'minimal', 'low', 'medium', 'high'].includes(args)) { ws.send(JSON.stringify({ type: 'request_error', requestId: msg.requestId, error: 'Use /thinking off|minimal|low|medium|high' })); return; }
                pi.setThinkingLevel(args as any); ws.send(JSON.stringify({ type: 'request_ack', requestId: msg.requestId })); return;
              }
              if (msg.name === 'name') {
                if (!args) { ws.send(JSON.stringify({ type: 'request_error', requestId: msg.requestId, error: 'Session name is required' })); return; }
                pi.setSessionName(args); ws.send(JSON.stringify({ type: 'request_ack', requestId: msg.requestId })); return;
              }
              const available = pi.getCommands().some(command => command.name === msg.name);
              if (!available) { ws.send(JSON.stringify({ type: 'request_error', requestId: msg.requestId, error: 'Command is not available in this Pi session' })); return; }
              try { await pi.sendUserMessage(`/${msg.name}${args ? ` ${args}` : ''}`, { deliverAs: 'steer', expandPromptTemplates: true }); ws.send(JSON.stringify({ type: 'request_ack', requestId: msg.requestId })); }
              catch (error) { ws.send(JSON.stringify({ type: 'request_error', requestId: msg.requestId, error: String(error) })); }
            }
          });
          ws.on('error', reject);
          ws.on('close', () => { if (heartbeat) clearInterval(heartbeat); heartbeat = undefined; if (registered) reject(new Error('daemon disconnected')); else reject(new Error('connection closed')); });
        });
      } catch { /* Remote control is optional; keep Pi running and retry. */ }
      if (stopped) return;
      await new Promise(r => setTimeout(r, retry)); retry = Math.min(retry * 2, 30000);
    }
  }

  function sendStatus(status: string) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'status', status })); }
  function collectMetadata(ctx: any) {
    const totals = { input: 0, cacheRead: 0, output: 0 };
    for (const entry of ctx.sessionManager.getBranch()) {
      const usage = entry.type === 'usage' ? entry.usage : entry.type === 'compaction' ? entry.usage : entry.type === 'message' && entry.message?.role === 'assistant' ? entry.message.usage : undefined;
      if (!usage) continue;
      totals.input += Number(usage.input) || 0;
      totals.cacheRead += Number(usage.cacheRead) || 0;
      totals.output += Number(usage.output) || 0;
    }
    return { thinkingLevel: pi.getThinkingLevel(), contextUsage: ctx.getContextUsage(), totals };
  }
  function sendMetadata(ctx: any) {
    if (socket?.readyState === WebSocket.OPEN) sendEvent({ type: 'metadata', metadata: collectMetadata(ctx) });
  }
  function sendEvent(event: any) {
    if (socket?.readyState !== WebSocket.OPEN) return;
    try { socket.send(JSON.stringify({ type: 'event', seq: ++seq, timestamp: Date.now(), event })); } catch { /* event serialization must not affect Pi */ }
  }
  pi.on('agent_start', () => { sendStatus('running'); sendEvent({ type: 'agent_start' }); });
  pi.on('agent_end', (_event, ctx) => { sendStatus('waiting'); sendEvent({ type: 'agent_end', entryId: ctx.sessionManager.getLeafId() }); sendMetadata(ctx); });
  pi.on('message_update', event => {
    const update = event.assistantMessageEvent;
    if (update.type === 'start') currentStreamId = `${instanceId}:${++streamCounter}`;
    sendEvent({
      type: 'message_update',
      role: event.message.role,
      streamId: currentStreamId,
      update: {
        type: update.type,
        contentIndex: 'contentIndex' in update ? update.contentIndex : undefined,
        delta: 'delta' in update ? update.delta : undefined,
        content: 'content' in update ? update.content : undefined,
        thinking: 'thinking' in update ? update.thinking : undefined,
        toolCall: 'toolCall' in update ? update.toolCall : undefined,
        message: 'message' in update ? update.message : undefined,
      },
    });
  });
  pi.on('message_end', (event, ctx) => {
    const message = event.message as any;
    const content = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part: any) => part?.type === 'text'
          ? { type: 'text', text: part.text }
          : part?.type === 'image' ? { type: 'image' } : null).filter(Boolean)
        : '';
    let requestId: string | undefined;
    if (message.role === 'user') {
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: any) => part?.text || '').join('\n') : '';
      const index = pendingRemoteMessages.findIndex(item => item.text === text);
      if (index >= 0) requestId = pendingRemoteMessages.splice(index, 1)[0].requestId;
    }
    sendEvent({ type: 'message_end', entryId: ctx.sessionManager.getLeafId(), streamId: message.role === 'assistant' ? currentStreamId : undefined, requestId, message: { role: message.role, content } });
    if (message.role === 'assistant') sendMetadata(ctx);
    if (message.role === 'assistant') currentStreamId = undefined;
  });
  pi.on('thinking_level_select', (_event, ctx) => sendMetadata(ctx));
  pi.on('tool_execution_start', event => sendEvent({ type: 'tool_execution_start', ...event }));
  pi.on('tool_execution_update', event => sendEvent({ type: 'tool_execution_update', ...event }));
  pi.on('tool_execution_end', event => sendEvent({ type: 'tool_execution_end', ...event }));
  pi.on('session_shutdown', async () => {
    stopped = true; if (heartbeat) clearInterval(heartbeat);
    try { socket?.close(); } catch { /* ignored */ }
  });
}
