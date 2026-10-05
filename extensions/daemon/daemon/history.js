'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TEXT_CHARS = 30000;

async function readBranch(sessionFile, sessionId, leafId) {
  if (typeof sessionFile !== 'string' || !sessionFile) throw httpError(404, 'Session history is unavailable');
  const sessionsRoot = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'sessions');
  let root, file;
  try { root = await fs.realpath(sessionsRoot); file = await fs.realpath(sessionFile); }
  catch { throw httpError(404, 'Session history file was not found'); }
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw httpError(403, 'Session history path is outside the Pi sessions directory');
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw httpError(413, 'Session history file is too large to read');
  const raw = await fs.readFile(file, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.id === 'string' && typeof entry.type === 'string') entries.push(entry);
    } catch { /* Ignore a partial final line while Pi is writing. */ }
  }
  const header = entries.find(entry => entry.type === 'session');
  if (!header || header.id !== sessionId) throw httpError(403, 'Session ID does not match the history file');
  const byId = new Map(entries.filter(entry => entry.type !== 'session').map(entry => [entry.id, entry]));
  if (leafId && !byId.has(leafId)) throw httpError(409, 'Active branch leaf is not available in the session file yet');
  let cursor = byId.has(leafId) ? leafId : entries.at(-1)?.id;
  const branch = [];
  const visited = new Set();
  while (cursor && byId.has(cursor) && !visited.has(cursor)) {
    visited.add(cursor);
    const entry = byId.get(cursor);
    branch.push(entry);
    cursor = entry.parentId;
  }
  branch.reverse();
  return branch;
}

async function readHistory(sessionFile, sessionId, leafId, { before, limit = 50 } = {}) {
  const branch = await readBranch(sessionFile, sessionId, leafId);
  const messages = branch.filter(entry => entry.type === 'message' && entry.message && ['user', 'assistant', 'toolResult'].includes(entry.message.role));
  let end = messages.length;
  if (before) {
    const index = messages.findIndex(entry => entry.id === before);
    if (index < 0) throw httpError(400, 'Invalid history cursor');
    end = index;
  }
  const start = Math.max(0, end - Math.max(1, Math.min(Number(limit) || 50, 100)));
  return {
    messages: messages.slice(start, end).map(entry => ({ id: entry.id, timestamp: entry.timestamp, message: sanitizeMessage(entry.message) })),
    hasMore: start > 0,
    before: start > 0 ? messages[start].id : null,
    snapshotTimestamp: branch.at(-1)?.timestamp || null,
  };
}

async function findSessionFile(sessionId) {
  const sessionsRoot = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'sessions');
  let root;
  try { root = await fs.realpath(sessionsRoot); } catch { return undefined; }
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let children;
    try { children = await fs.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      const file = path.join(directory, child.name);
      if (child.isDirectory()) pending.push(file);
      else if (child.isFile() && child.name.endsWith('.jsonl') && child.name.includes(sessionId)) {
        let handle;
        try {
          handle = await fs.open(file, 'r');
          const buffer = Buffer.alloc(4096);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0];
          if (JSON.parse(firstLine).id === sessionId) return file;
        } catch { /* Ignore unrelated, partial, or unreadable session files. */ }
        finally { await handle?.close().catch(() => {}); }
      }
    }
  }
  return undefined;
}

function sanitizeMessage(message) {
  let content = message.content;
  if (typeof content === 'string') content = content.slice(0, MAX_TEXT_CHARS);
  else if (Array.isArray(content)) {
    let remaining = MAX_TEXT_CHARS;
    content = content.map(part => {
      if (part?.type === 'text' && typeof part.text === 'string') {
        const text = part.text.slice(0, remaining); remaining -= text.length;
        return { type: 'text', text };
      }
      if (part?.type === 'thinking' && typeof part.thinking === 'string') {
        const thinking = part.thinking.slice(0, remaining); remaining -= thinking.length;
        return { type: 'thinking', thinking };
      }
      if (part?.type === 'toolCall') return { type: 'toolCall', id: part.id, name: part.name, arguments: part.arguments };
      if (part?.type === 'image') return { type: 'image' };
      return null;
    }).filter(Boolean);
  } else content = '';
  const result = { role: message.role, content };
  for (const key of ['toolCallId', 'toolName', 'isError']) if (message[key] !== undefined) result[key] = message[key];
  return result;
}
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
async function readTelemetry(sessionFile, sessionId, leafId) {
  const branch = await readBranch(sessionFile, sessionId, leafId);
  const numeric = ['turn','epoch','rawTokens','projectedTokens','effectiveTokens','afterWarmTokens','afterCheckpointTokens','hotTokens','warmTokens','checkpointTokens','otherTokens','capsulesCreated','capsuleTokensSaved','stateBytes','attemptedStateBytes','cacheRead','cacheWrite','input','providerContextTokens'];
  const turns = branch.filter(e => e.type === 'custom' && e.customType === 'rolling-context.telemetry.v1').map(e => {
    const d = e.data || {}, row = {};
    for (const key of numeric) row[key] = typeof d[key] === 'number' && Number.isFinite(d[key]) && d[key] >= 0 ? d[key] : null;
    row.mode = ['on','off','observe'].includes(d.mode) ? d.mode : 'unknown';
    row.checkpointCreated = d.checkpointCreated === true;
    row.planRejectedReason = ['STATE_SIZE_LIMIT','INVALID_FINAL_PROJECTION'].includes(d.planRejectedReason) ? d.planRejectedReason : null;
    row.checkpointReason = ['hard','after-warm-budget','manual','threshold','overflow'].includes(d.checkpointReason) ? d.checkpointReason : null;
    return row;
  }).filter(row => Number.isSafeInteger(row.turn) && row.turn > 0);
  const checkpoints = branch.filter(e => e.type === 'compaction').map(e => {
    const d = e.details, c = d?.stateEnvelope?.checkpoint;
    const summaryHash = require('node:crypto').createHash('sha256').update(e.summary || '').digest('hex');
    const rolling = d?.type === 'rolling-context.checkpoint.v1' && d.firstKeptEntryId === e.firstKeptEntryId && d.summaryHash === summaryHash && c?.firstKeptEntryId === e.firstKeptEntryId && c?.summaryHash === summaryHash;
    return {
      turn: Number.isSafeInteger(d?.turn) ? d.turn : null,
      rolling,
      reason: ['hard','after-warm-budget','manual','threshold','overflow'].includes(d?.reason) ? d.reason : null,
    };
  });
  return { turns, checkpoints, tokenBasis: 'host-estimate', rawBasis: 'raw message history (system/user/assistant/tool)', snapshotTimestamp: branch.at(-1)?.timestamp || null };
}
module.exports = { findSessionFile, readHistory, readTelemetry };
