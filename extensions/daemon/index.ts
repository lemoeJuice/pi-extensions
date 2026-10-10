import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import WebSocket from 'ws';
import { getDaemonVersion } from './daemon/version.js';
import { UIBroker } from './ui/broker.ts';
import { installUIProxy } from './ui/adapter.ts';
import { dispatchRemoteCommand } from './ui/command-dispatch.ts';
import { UI_VERSION } from './daemon/ui-protocol.js';

const daemonPath = resolve(__dirname, 'daemon/main.js');
const daemonVersion = getDaemonVersion();
const port = Number(process.env.PI_REMOTE_PORT || 4317);
const host = process.env.PI_REMOTE_HOST || '100.64.209.124';
const httpUrl = `http://${host}:${port}`;
const wsUrl = `ws://${host}:${port}/internal`;
const remoteCommands = [
  { name: 'abort', description: 'Stop the current Pi generation', source: 'remote' },
  { name: 'compact', description: 'Compact the current session context', source: 'remote' },
  { name: 'thinking', description: 'Set thinking level: off, minimal, low, medium, high, xhigh, max', source: 'remote', requiresArgs: true },
  { name: 'model', description: 'Switch model using provider/model-id', source: 'remote', requiresArgs: true },
  { name: 'name', description: 'Set the session display name', source: 'remote', requiresArgs: true },
];
const STATUSLINE_REGISTRY = Symbol.for('@pi-plugins/statusline-registry');
const FAST_MODE_SEGMENT_TEXT = '[fast mode]';

/** Observe the same shared statusline projection rendered by Pi; absence is unknown, not off. */
function inspectFastModeSegment(): true | undefined {
  const segments = (globalThis as any)[STATUSLINE_REGISTRY];
  if (!(segments instanceof Map)) return undefined;
  for (const segment of segments.values()) {
    if (typeof segment?.text === 'string' && segment.text.trim().toLowerCase() === FAST_MODE_SEGMENT_TEXT) return true;
  }
  return undefined;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function daemonHealth(): Promise<any | undefined> {
  try {
    const response = await fetch(`${httpUrl}/health`, { signal: AbortSignal.timeout(800) });
    if (response.ok) return await response.json();
  } catch { /* daemon is not listening */ }
  return undefined;
}

function findLocalDaemonPid(): number | undefined {
  if (process.platform !== 'linux') return undefined;
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return undefined;
  const expectedAddress = octets.reverse().map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
  const listenerInodes = new Set<string>();
  try {
    for (const line of readFileSync('/proc/net/tcp', 'utf8').split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [address, hexPort] = (fields[1] || '').split(':');
      if (fields[3] === '0A' && Number.parseInt(hexPort, 16) === port && (address === expectedAddress || address === '00000000')) listenerInodes.add(fields[9]);
    }
  } catch { return undefined; }
  if (!listenerInodes.size) return undefined;
  let pids: string[];
  try { pids = readdirSync('/proc').filter(name => /^\d+$/.test(name)); } catch { return undefined; }
  for (const pid of pids) {
    try {
      const commandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!commandLine.includes(daemonPath)) continue;
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        const target = readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/)?.[1];
        if (target && listenerInodes.has(target)) return Number(pid);
      }
    } catch { /* process exited or procfs access denied */ }
  }
  return undefined;
}

async function stopStaleDaemon() {
  const pid = findLocalDaemonPid();
  if (!pid) throw new Error(`Pi Remote daemon at ${host}:${port} is outdated, but its local process could not be identified safely`);
  try { process.kill(pid, 'SIGTERM'); }
  catch (error: any) { if (error?.code !== 'ESRCH') throw error; }
  for (let n = 0; n < 32; n++) {
    await sleep(200);
    if (!(await daemonHealth())) return;
  }
  throw new Error(`Outdated Pi Remote daemon process ${pid} did not stop`);
}

async function ensureDaemon(isCurrent: () => boolean) {
  const current = await daemonHealth();
  if (!isCurrent()) return;
  if (current?.daemonVersion === daemonVersion) return;
  if (current?.ok) await stopStaleDaemon();
  if (!isCurrent()) return;
  const child = spawn(process.execPath, [daemonPath], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  for (let n = 0; n < 30; n++) {
    await sleep(250);
    if (!isCurrent()) return;
    if ((await daemonHealth())?.daemonVersion === daemonVersion) return;
  }
  throw new Error('Pi Remote daemon did not become available');
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag('remote-ui-proxy', { type: 'boolean', default: true, description: 'Mirror supported local TUI dialogs to the remote session page (compatibility adapter)' });
  let socket: WebSocket | undefined;
  let stopped = false;
  let connectionGeneration = 0;
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
  let broker: UIBroker | undefined;
  let restoreUI: (() => void) | undefined;
  let registeredSocket: WebSocket | undefined;

  function sendUI(frame: any) {
    if (socket !== registeredSocket || socket?.readyState !== WebSocket.OPEN) return;
    try { socket.send(JSON.stringify(frame)); } catch { /* keep the local prompt alive */ }
  }

  async function releaseUI() {
    const closed = broker?.dispose(); restoreUI?.(); broker = undefined; restoreUI = undefined;
    await closed;
  }

  pi.on('session_start', async (_event, ctx) => {
    await releaseUI();
    registeredSocket = undefined;
    const generation = ++connectionGeneration;
    try { socket?.close(); } catch { /* ignore stale connection close */ }
    socket = undefined;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    stopped = false; seq = 0; retry = 1000; streamCounter = 0; currentStreamId = undefined;
    cwd = ctx.cwd;
    sessionFile = ctx.sessionManager.getSessionFile();
    sessionId = ctx.sessionManager.getSessionId?.() || (typeof sessionFile === 'string' ? basename(sessionFile).replace(/\.jsonl$/, '') : randomUUID());
    instanceId = `${process.pid}-${randomUUID().slice(0, 8)}`;
    const activeModel = ctx.model;
    model = activeModel ? `${activeModel.provider}/${activeModel.id}` : undefined;
    if (ctx.mode === 'tui' && ctx.hasUI && pi.getFlag('remote-ui-proxy') !== false) {
      const next = new UIBroker(sendUI);
      try { restoreUI = installUIProxy(ctx.ui, next, () => sendMetadata(ctx)); broker = next; }
      catch (error) { next.dispose(); ctx.ui.notify(`Remote UI proxy unavailable; local UI unchanged: ${String(error)}`, 'warning'); }
    }
    void connect(ctx, generation);
  });

  async function connect(ctx: any, generation: number) {
    while (!stopped && generation === connectionGeneration) {
      try {
        await ensureDaemon(() => !stopped && generation === connectionGeneration);
        if (stopped || generation !== connectionGeneration) break;
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(wsUrl); socket = ws;
          let registered = false;
          ws.on('open', () => {
            if (generation !== connectionGeneration) { ws.close(); return; }
            ws.send(JSON.stringify({ type: 'register', instance: { instanceId, sessionId, pid: process.pid, cwd, model, title: undefined, startedAt: Date.now(), sessionFile, leafId: ctx.sessionManager.getLeafId(), metadata: collectMetadata(ctx), uiVersion: UI_VERSION, commands: [...remoteCommands, ...pi.getCommands().map(({ name, description, source }) => ({ name, description, source }))] } }));
          });
          ws.on('message', async data => {
            if (generation !== connectionGeneration) return;
            let msg: any; try { msg = JSON.parse(data.toString()); } catch { return; }
            if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
            if (msg.type === 'registered') {
              registered = true; retry = 1000;
              if (msg.uiVersion === UI_VERSION) { registeredSocket = ws; if (broker) sendUI(broker.snapshot()); }
              else if (broker) ctx.ui.notify('Remote UI proxy unavailable: incompatible UI protocol; local dialogs are unchanged.', 'warning');
              heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() })); }, 10000);
            } else if (msg.type === 'ui_response') {
              const accepted = msg.version === UI_VERSION && ws === registeredSocket && broker?.respond(msg.uiEpoch, msg.response) === true;
              ws.send(JSON.stringify({ type: 'ui_response_ack', version: UI_VERSION, uiEpoch: msg.uiEpoch, id: msg.response?.id, accepted }));
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
              if (msg.name === 'abort') { ctx.abort(); ws.send(JSON.stringify({ type: 'request_ack', requestId: msg.requestId, result: 'Stop requested' })); return; }
              if (msg.name === 'compact') { ctx.compact(); ws.send(JSON.stringify({ type: 'request_ack', requestId: msg.requestId, result: 'Compaction requested' })); return; }
              if (msg.name === 'thinking') {
                if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(args)) { ws.send(JSON.stringify({ type: 'request_error', requestId: msg.requestId, error: 'Use /thinking off|minimal|low|medium|high|xhigh|max' })); return; }
                pi.setThinkingLevel(args as any); ws.send(JSON.stringify({ type: 'request_ack', requestId: msg.requestId, result: `Thinking level set to ${pi.getThinkingLevel()}` })); return;
              }
              if (msg.name === 'model') {
                const separator = args.indexOf('/');
                if (separator < 1 || separator === args.length - 1) { ws.send(JSON.stringify({ type: 'request_error', requestId: msg.requestId, error: 'Use /model provider/model-id' })); return; }
                const selected = ctx.modelRegistry.find(args.slice(0, separator), args.slice(separator + 1));
                if (!selected) { ws.send(JSON.stringify({ type: 'request_error', requestId: msg.requestId, error: `Unknown model: ${args}` })); return; }
                try { if (!await pi.setModel(selected)) throw new Error('Authentication is not configured for this model'); model = `${selected.provider}/${selected.id}`; sendMetadata(ctx); ws.send(JSON.stringify({ type: 'request_ack', requestId: msg.requestId, result: `Model set to ${model}` })); }
                catch (error) { ws.send(JSON.stringify({ type: 'request_error', requestId: msg.requestId, error: String(error) })); }
                return;
              }
              if (msg.name === 'name') {
                if (!args) { ws.send(JSON.stringify({ type: 'request_error', requestId: msg.requestId, error: 'Session name is required' })); return; }
                pi.setSessionName(args); ws.send(JSON.stringify({ type: 'request_ack', requestId: msg.requestId, result: `Session name set to ${args}` })); return;
              }
              const available = pi.getCommands().some(command => command.name === msg.name);
              if (!available) { ws.send(JSON.stringify({ type: 'request_error', requestId: msg.requestId, error: 'Command is not available in this Pi session' })); return; }
              try {
                // Extension commands can wait indefinitely for generic remote UI confirmation.
                // Do not hold the HTTP command request open until that human decision arrives.
                dispatchRemoteCommand(
                  () => pi.sendUserMessage(`/${msg.name}${args ? ` ${args}` : ''}`, { deliverAs: 'steer', expandPromptTemplates: true }),
                  () => ws.send(JSON.stringify({ type: 'request_ack', requestId: msg.requestId, result: `Dispatched /${msg.name} to Pi` })),
                  error => ctx.ui.notify(`Remote command /${msg.name} failed: ${error instanceof Error ? error.message : String(error)}`, 'error'),
                );
              }
              catch (error) { ws.send(JSON.stringify({ type: 'request_error', requestId: msg.requestId, error: String(error) })); }
            }
          });
          ws.on('error', reject);
          ws.on('close', () => {
            if (socket === ws) socket = undefined;
            if (generation === connectionGeneration) { if (heartbeat) clearInterval(heartbeat); heartbeat = undefined; }
            if (registeredSocket === ws) registeredSocket = undefined;
            if (registered) reject(new Error('daemon disconnected')); else reject(new Error('connection closed'));
          });
        });
      } catch { /* Remote control is optional; keep Pi running and retry. */ }
      if (stopped || generation !== connectionGeneration) return;
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
    const activeModel = ctx.model;
    return { model: activeModel ? `${activeModel.provider}/${activeModel.id}` : model, thinkingLevel: pi.getThinkingLevel(), fastMode: inspectFastModeSegment(), contextUsage: ctx.getContextUsage(), totals };
  }
  function sendMetadata(ctx: any) {
    if (socket?.readyState === WebSocket.OPEN) sendEvent({ type: 'metadata', metadata: collectMetadata(ctx) });
  }
  function sendEvent(event: any) {
    if (socket?.readyState !== WebSocket.OPEN) return;
    try { socket.send(JSON.stringify({ type: 'event', seq: ++seq, timestamp: Date.now(), event })); } catch { /* event serialization must not affect Pi */ }
  }
  pi.on('agent_start', (_event, ctx) => { sendStatus('running'); sendEvent({ type: 'agent_start' }); sendMetadata(ctx); });
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
        reason: update.type === 'error' ? update.reason : undefined,
        error: update.type === 'error' ? { message: update.error.errorMessage, stopReason: update.error.stopReason } : undefined,
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
    sendEvent({ type: 'message_end', entryId: ctx.sessionManager.getLeafId(), streamId: message.role === 'assistant' ? currentStreamId : undefined, requestId, message: { role: message.role, content, stopReason: message.stopReason, errorMessage: message.errorMessage } });
    if (message.role === 'assistant') sendMetadata(ctx);
    if (message.role === 'assistant') currentStreamId = undefined;
  });
  pi.on('thinking_level_select', (_event, ctx) => sendMetadata(ctx));
  // Run after all model_select observers have refreshed their inspectable status projections.
  pi.on('model_select', (_event, ctx) => { setTimeout(() => sendMetadata(ctx), 0); });
  pi.on('tool_execution_start', event => sendEvent({ type: 'tool_execution_start', ...event }));
  pi.on('tool_execution_update', event => sendEvent({ type: 'tool_execution_update', ...event }));
  pi.on('tool_execution_end', event => sendEvent({ type: 'tool_execution_end', ...event }));
  pi.on('session_tree', async (_event, ctx) => {
    await releaseUI();
    if (ctx.mode === 'tui' && ctx.hasUI && pi.getFlag('remote-ui-proxy') !== false) {
      const next = new UIBroker(sendUI);
      try { restoreUI = installUIProxy(ctx.ui, next, () => sendMetadata(ctx)); broker = next; sendUI(next.snapshot()); }
      catch { next.dispose(); ctx.ui.notify('Remote UI proxy unavailable after tree navigation; local UI unchanged.', 'warning'); }
    }
  });
  pi.on('session_shutdown', async () => {
    await releaseUI(); registeredSocket = undefined;
    stopped = true; connectionGeneration++; if (heartbeat) clearInterval(heartbeat); heartbeat = undefined;
    try { socket?.close(); } catch { /* ignored */ }
    socket = undefined;
  });
}
