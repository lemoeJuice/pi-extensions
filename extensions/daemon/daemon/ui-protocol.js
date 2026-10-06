'use strict';

const UI_VERSION = 1;
const MAX_TEXT = 64 * 1024;
const text = value => typeof value === 'string' && value.length <= MAX_TEXT;
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validRequest(request) {
  if (!object(request) || !identity(request.id) || !text(request.title)) return false;
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 256 * 1024) return false;
  if (request.timeout !== undefined && (!Number.isFinite(request.timeout) || request.timeout < 0)) return false;
  switch (request.method) {
    case 'select': return Array.isArray(request.options) && request.options.length <= 256 && request.options.every(text);
    case 'confirm': return text(request.message);
    case 'input': return request.placeholder === undefined || text(request.placeholder);
    case 'local-only': return ['custom', 'editor', 'oversized'].includes(request.kind);
    default: return false;
  }
}

function validResponse(request, response) {
  if (!object(response) || response.id !== request.id) return false;
  const keys = Object.keys(response);
  if (response.cancelled === true) return keys.every(key => ['id', 'cancelled'].includes(key)) && request.method !== 'local-only';
  if (request.method === 'confirm') return typeof response.confirmed === 'boolean' && keys.every(key => ['id', 'confirmed'].includes(key));
  if (request.method === 'select') return text(response.value) && request.options.includes(response.value) && keys.every(key => ['id', 'value'].includes(key));
  if (request.method === 'input') return text(response.value) && keys.every(key => ['id', 'value'].includes(key));
  return false;
}

function validSnapshot(snapshot) {
  return object(snapshot) && snapshot.version === UI_VERSION && identity(snapshot.uiEpoch)
    && Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0
    && Array.isArray(snapshot.pending) && snapshot.pending.length <= 1 && snapshot.pending.every(validRequest)
    && object(snapshot.status) && Object.keys(snapshot.status).length <= 128
    && Object.entries(snapshot.status).every(([key, value]) => text(key) && text(value))
    && Buffer.byteLength(JSON.stringify(snapshot.status), 'utf8') <= 128 * 1024;
}

module.exports = { UI_VERSION, MAX_TEXT, validRequest, validResponse, validSnapshot };
