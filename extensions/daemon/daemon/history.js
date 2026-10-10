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
  const numeric = ['requestRepresentationChanges','requestSavingPerRequest','requestMutationPosition','requestInvalidatedSuffixTokens','generation','representationChanges','sourcesCold','contextWindow','exactTokens','capsuleTokens','coldEquivalentTokens','coldRefTokens','frameTokens','pinnedExactTokens','pendingCompressionGain','savingPerRequest','breakEvenRequests','compressionTokens','occupancy','requestGeneration','turn','epoch','rawTokens','projectedTokens','effectiveTokens','afterWarmTokens','afterCheckpointTokens','targetTokens','softThresholdTokens','hardThresholdTokens','hotTokens','warmTokens','checkpointTokens','otherTokens','warmSourceTokens','warmCapsuleTokens','warmTokensSaved','warmEventSourceTokens','warmEventCapsuleTokens','warmEventTokensSaved','plannedWarmSourceTokens','plannedWarmCapsuleTokens','plannedWarmTokensSaved','eligibleHistoricalTokens','protectedTokens','earliestMutationPosition','projectedTokensBeforeMutation','estimatedInvalidatedSuffixTokens','checkpointKeptTokens','checkpointEstimatedTokens','checkpointPreviewTokens','capsulesCreated','capsuleTokensSaved','stateBytes','stateLimitBytes','attemptedStateBytes','cacheRead','cacheWrite','input','uncachedInput','cacheReuseRatio','providerContextTokens'];
  const blockedCodes = new Set(['MISSING_CONTINUITY_STATE','CHECKPOINT_CADENCE','WARM_REQUIRED','WARM_RESIDENCE','ACTIVE_DEPENDENCY','ACTIVE_PATH_DEPENDENCY','UNRESOLVED_ERROR','UNSUPPORTED_CONTENT','UNSUPPORTED_TOOL_OR_RESULT','IMAGE','FOREIGN_EDIT','NO_SAFE_BOUNDARY','NO_NET_SAVING','STATE_SIZE_LIMIT','INVALID_FINAL_PROJECTION','INCOMPLETE_TOOL_GROUP','NOT_CONSUMED','RECENT_GROUP','PINNED_SOURCE','LATEST_USER_REQUEST','PROTECTED_SET_OVER_BUDGET']);
  const turns = branch.filter(e => e.type === 'custom' && ['rolling-context.telemetry.v1','rolling-context.telemetry.v2'].includes(e.customType)).map(e => {
    const d = e.data || {}, row = {};
    for (const key of numeric) row[key] = typeof d[key] === 'number' && Number.isFinite(d[key]) && d[key] >= 0 ? d[key] : null;
    row.schemaVersion = e.customType.endsWith('.v2') ? 2 : 1;
    row.requestGenerationCommitted = d.requestGenerationCommitted === true;
    row.generationCommitted = d.generationCommitted === true;
    row.capacityStatus = ['HEALTHY','BUDGET_INFEASIBLE','CAPACITY_PRESSURE'].includes(d.capacityStatus) ? d.capacityStatus : null;
    row.requestId = typeof d.requestId === 'string' && d.requestId.length <= 128 ? d.requestId : null;
    row.mode = ['on','off','observe'].includes(d.mode) ? d.mode : 'unknown';
    row.timelineKind = d.timelineKind === 'initial' ? 'initial' : 'completed';
    row.eventPosition = d.eventPosition === 'after-turn' ? 'after-turn' : null;
    row.checkpointCreated = d.checkpointCreated === true;
    row.checkpointWanted = d.checkpointWanted === true;
    row.checkpointCandidate = d.checkpointCandidate === true;
    row.checkpointBlockedBy = Array.isArray(d.checkpointBlockedBy) ? [...new Set(d.checkpointBlockedBy.filter(code => blockedCodes.has(code)))].slice(0,16) : [];
    row.protectedTokensByReason = d.protectedTokensByReason && typeof d.protectedTokensByReason === 'object' && !Array.isArray(d.protectedTokensByReason) ? Object.fromEntries(Object.entries(d.protectedTokensByReason).filter(([key,value]) => blockedCodes.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0).slice(0,24)) : {};
    row.earliestMutationEntryId = typeof d.earliestMutationEntryId === 'string' && d.earliestMutationEntryId.length <= 128 ? d.earliestMutationEntryId : null;
    row.checkpointBoundaryEntryId = typeof d.checkpointBoundaryEntryId === 'string' && d.checkpointBoundaryEntryId.length <= 128 ? d.checkpointBoundaryEntryId : null;
    row.planRejectedReason = blockedCodes.has(d.planRejectedReason) ? d.planRejectedReason : null;
    row.checkpointReason = ['hard','after-warm-budget','manual','threshold','overflow'].includes(d.checkpointReason) ? d.checkpointReason : null;
    const usage = d.usage && typeof d.usage === 'object' ? d.usage : {};
    row.usage = {
      input: typeof usage.input === 'number' && Number.isFinite(usage.input) && usage.input >= 0 ? usage.input : row.input,
      uncachedInput: typeof usage.uncachedInput === 'number' && Number.isFinite(usage.uncachedInput) && usage.uncachedInput >= 0 ? usage.uncachedInput : row.uncachedInput ?? row.input,
      cacheRead: typeof usage.cacheRead === 'number' && Number.isFinite(usage.cacheRead) && usage.cacheRead >= 0 ? usage.cacheRead : row.cacheRead,
      cacheWrite: typeof usage.cacheWrite === 'number' && Number.isFinite(usage.cacheWrite) && usage.cacheWrite >= 0 ? usage.cacheWrite : row.cacheWrite,
      cacheReuseRatio: typeof usage.cacheReuseRatio === 'number' && Number.isFinite(usage.cacheReuseRatio) && usage.cacheReuseRatio >= 0 && usage.cacheReuseRatio <= 1 ? usage.cacheReuseRatio : row.cacheReuseRatio,
    };
    if (row.cacheReuseRatio === null && row.usage.cacheRead !== null && row.usage.uncachedInput !== null && row.usage.cacheRead + row.usage.uncachedInput > 0) row.cacheReuseRatio = row.usage.cacheRead / (row.usage.cacheRead + row.usage.uncachedInput);
    return row;
  }).filter(row => Number.isSafeInteger(row.turn) && row.turn >= 0);
  if (!turns.some(row => row.turn === 0 && row.timelineKind === 'initial')) {
    for (let i = turns.length - 1; i >= 0; i--) if (turns[i].turn === 0) turns.splice(i, 1);
    turns.unshift({ turn: 0, timelineKind: 'unknown', mode: 'unknown', gap: true, ...Object.fromEntries(numeric.filter(key => key !== 'turn').map(key => [key, null])), checkpointCreated: false, checkpointWanted: false, checkpointCandidate: false, checkpointBlockedBy: [], protectedTokensByReason: {}, usage: { input: null, uncachedInput: null, cacheRead: null, cacheWrite: null, cacheReuseRatio: null } });
  }
  turns.sort((a, b) => a.turn - b.turn);
  let observedTurn = 0;
  const checkpoints = [];
  for (const e of branch) {
    if (e.type === 'custom' && ['rolling-context.telemetry.v1','rolling-context.telemetry.v2'].includes(e.customType) && Number.isSafeInteger(e.data?.turn) && e.data.turn >= 0) observedTurn = Math.max(observedTurn, e.data.turn);
    if (e.type !== 'compaction') continue;
    const d = e.details, c = d?.stateEnvelope?.checkpoint;
    const summaryHash = require('node:crypto').createHash('sha256').update(e.summary || '').digest('hex');
    const rolling = d?.type === 'rolling-context.checkpoint.v1' && d.firstKeptEntryId === e.firstKeptEntryId && d.summaryHash === summaryHash && c?.firstKeptEntryId === e.firstKeptEntryId && c?.summaryHash === summaryHash;
    checkpoints.push({ turn: Number.isSafeInteger(d?.turn) ? d.turn : observedTurn > 0 ? observedTurn : null, rolling, kind: rolling ? 'checkpoint' : 'foreign', reason: ['hard','after-warm-budget','manual','threshold','overflow'].includes(d?.reason) ? d.reason : null, eventPosition: 'after-turn' });
  }
  return { turns, checkpoints, tokenBasis: 'host-estimate', usageBasis: 'Pi Usage.input is uncached input; cacheRead is reported cached input', turnZero: turns.find(row => row.turn === 0)?.timelineKind === 'initial' ? 'measured' : 'gap', rawBasis: 'raw message history (system/user/assistant/tool)', snapshotTimestamp: branch.at(-1)?.timestamp || null };
}
module.exports = { findSessionFile, readHistory, readTelemetry, readProjection };

/** Replay the archived hook mapping; no aging or planner is run by the daemon. */
async function readProjection(sessionFile, sessionId, leafId, { requestId, sourceId } = {}) {
  const branch = await readBranch(sessionFile, sessionId, leafId);
  const [{ SessionManager }, legacy, common, representation, codec] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('../../rolling-context/legacy/v1.ts'),
    import('../../rolling-context/projection/common.ts'),
    import('../../rolling-context/projection/state.ts'),
    import('../../rolling-context/projection/snapshot-codec.js'),
  ]);
  // readBranch has already verified the real file root, header identity and parent chain.
  const header = { type:'session', version:3, id:sessionId, cwd:'/tmp', timestamp:'' };
  const live = SessionManager.inMemory('/tmp', undefined, [header,...branch]).buildSessionProjection().entries;
  const authorized = legacy.recallProjection('/tmp', header, branch, live);
  const authorizedById = new Map(authorized.map(e=>[e.sourceEntry.id,e]));
  if (sourceId) {
    const source = branch.find(e=>e.id===sourceId), permitted = authorizedById.get(sourceId);
    if (!source || !permitted?.messages.length) throw httpError(403,'Source is not authorized in the current branch');
    const owned = legacy.ownedEdits(branch).get(sourceId);
    const messages = permitted.messages.map(message=> {
      if (owned && source.type==='message' && common.hash(common.text(message))===owned.replacementHash) return source.message;
      return message;
    });
    return {sourceId, messages:messages.map(message=>sanitizeMessage({...message,content:Array.isArray(message.content)?message.content.filter(p=>p.type!=='thinking'):message.content}))};
  }
  const snapshots = branch.filter(e=>e.type==='custom' && e.customType==='rolling-context.projection-snapshot.v2')
    .map(e=>({requestId:e.data?.requestId,turn:e.data?.turn,generation:e.data?.generation}));
  const snapshot = codec.default.replaySnapshots(branch,requestId);
  if (!snapshot) return { snapshots, snapshot:null, rows:[], reason:'No actual context hook snapshot on this branch' };
  const end = branch.findIndex(e=>e.type==='custom' && e.customType==='rolling-context.projection-snapshot.v2' && e.data?.requestId===snapshot.requestId);
  const atRequest = branch.slice(0,end+1);
  const projection = SessionManager.inMemory('/tmp', undefined, [header,...atRequest]).buildSessionProjection().entries;
  const byId = new Map(projection.map(e=>[e.sourceEntry.id,e]));
  const state = representation.restoreProjectionState(atRequest);
  const blobs = new Map(atRequest.filter(e=>e.type==='custom'&&e.customType==='rolling-context.projection-content.v2').map(e=>[e.data?.hash,e.data]));
  const rows = snapshot.rows.map(row=> {
    let message, unavailable;
    if(row.sourceEntryId) {
      const original = byId.get(row.sourceEntryId)?.messages[row.messageIndex];
      const current = authorizedById.get(row.sourceEntryId)?.messages[row.messageIndex];
      if (!current || common.hash(current)!==row.sourceHash) unavailable='Source changed or was withheld by current branch authorization';
      else if(!original || common.hash(original)!==row.sourceHash) unavailable='Source hash does not match archived hook input';
      else {
        message=original;
        if(row.representation!=='EXACT') {
          const record=state.sources.get(row.sourceId);
          if(!record || record.sourceHash!==row.sourceHash || !record.capsule) unavailable='Representation is unavailable';
          else message=common.replaceText(original,row.representation==='CAPSULE'?record.capsule.text:`[Cold evidence source=${row.sourceEntryId}; context_recall(entryId="${row.sourceEntryId}") for raw.]`);
        }
      }
    } else {
      const blob=blobs.get(row.contentRef);message=blob?.message;unavailable=blob?.unavailable;
    }
    if(!unavailable && (!message || common.hash(message)!==row.projectedHash)) unavailable='Projected message hash mismatch';
    // Never render bounded previews as complete messages or leak old previews after redaction.
    return {...row, preview:unavailable?'':row.preview, message:unavailable?null:message, unavailable:unavailable||null,
      age:Math.max(0,snapshot.turn-row.bornTurn),saving:row.rawTokens-row.projectedTokens};
  });
  const complete=rows.every(row=>!row.unavailable);
  const verified=complete && common.hash(rows.map(row=>row.message))===snapshot.outputHash;
  return {snapshots,snapshot:{requestId:snapshot.requestId,turn:snapshot.turn,generation:snapshot.generation,totals:snapshot.totals,hook:snapshot.hook,outputHash:snapshot.outputHash},rows,verified};
}
