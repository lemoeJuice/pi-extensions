import { randomUUID } from 'node:crypto';
import { UI_VERSION, MAX_TEXT, validRequest, validResponse } from '../daemon/ui-protocol.js';

type DialogOptions = { signal?: AbortSignal; timeout?: number };
type Request = { id: string; method: string; title: string; [key: string]: unknown };
type Outcome = { value?: unknown; error?: unknown; remote?: boolean };

/** Owns UI state, not business approvals. Transport failures never settle a prompt. */
export class UIBroker {
  readonly uiEpoch = randomUUID();
  private revision = 0;
  private queue: Promise<void> = Promise.resolve();
  private active?: { request: Request; choose?: (outcome: Outcome) => boolean };
  private localMarkers: Request[] = [];
  private disposed = false;
  private pendingDialogs = 0;
  private status: Record<string, string> = Object.create(null);

  private publish: (frame: any) => void;
  constructor(publish: (frame: any) => void) { this.publish = publish; }

  /** Includes queued dialogs before their native UI has been installed. */
  get hasPendingRequests(): boolean { return this.pendingDialogs > 0 || this.localMarkers.length > 0; }

  snapshot() {
    const request = this.active?.request ?? this.localMarkers.at(-1);
    return { type: 'ui_snapshot', version: UI_VERSION, uiEpoch: this.uiEpoch,
      revision: this.revision, pending: request ? [{ ...request,
        ...(Array.isArray(request.options) ? { options: [...request.options] } : {}) }] : [], status: { ...this.status } };
  }

  private emit(frame: any) { try { this.publish(frame); } catch { /* local UI is independent */ } }
  private changed() { this.revision++; if (!this.disposed) this.emit(this.snapshot()); }
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    this.pendingDialogs++;
    const result = this.queue.then(run, run).finally(() => { this.pendingDialogs--; });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  dialog(method: 'select' | 'confirm' | 'input', fields: Record<string, unknown>,
    opts: DialogOptions | undefined, local: (opts: DialogOptions) => Promise<unknown>): Promise<any> {
    return this.enqueue(async () => {
      const fallback = method === 'confirm' ? false : undefined;
      if (this.disposed || opts?.signal?.aborted) return fallback;
      const request: Request = { ...fields, id: randomUUID(), method, title: String(fields.title ?? ''),
        ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}) };
      const controller = new AbortController();
      let settled = false, resolve!: (outcome: Outcome) => void;
      const decision = new Promise<Outcome>(done => { resolve = done; });
      const choose = (outcome: Outcome) => {
        if (settled) return false;
        settled = true; resolve(outcome); return true;
      };
      const abort = () => { choose({ value: fallback, remote: true }); controller.abort(); };
      opts?.signal?.addEventListener('abort', abort, { once: true });
      // Oversized/unrepresentable UI still works locally; never truncate an approval.
      const wire = validRequest(request) ? request : { id: request.id, method: 'local-only', title: 'This prompt requires the local terminal', kind: 'oversized' };
      this.active = { request: wire, choose };
      this.changed();
      const localResult = Promise.resolve().then(() => local({ ...opts, signal: controller.signal }));
      void localResult.then(value => choose({ value }), error => choose({ error }));
      try {
        const outcome = await decision;
        if (outcome.remote) controller.abort();
        // Wait for native prompt cleanup before another prompt or business continuation.
        await localResult.catch(() => undefined);
        if ('error' in outcome) throw outcome.error;
        return outcome.value;
      } finally {
        opts?.signal?.removeEventListener('abort', abort);
        this.active = undefined;
        this.changed();
      }
    });
  }

  localOnly<T>(kind: 'custom' | 'editor', title: string, local: () => Promise<T>): Promise<T> {
    // Observe, don't queue/replace arbitrary components. They may themselves call
    // a standard dialog; putting them on that queue would deadlock nested UI.
    const candidate = { id: randomUUID(), method: 'local-only', title, kind };
    const marker = validRequest(candidate) ? candidate : { ...candidate, title: 'This prompt requires the local terminal' };
    this.localMarkers.push(marker); this.changed();
    const finish = () => { this.localMarkers = this.localMarkers.filter(item => item !== marker); this.changed(); };
    try { return local().finally(finish); }
    catch (error) { finish(); throw error; }
  }

  respond(uiEpoch: string, response: any): boolean {
    const active = this.active;
    if (this.disposed || uiEpoch !== this.uiEpoch || !active?.choose || !validResponse(active.request, response)) return false;
    const value = response.cancelled ? (active.request.method === 'confirm' ? false : undefined)
      : active.request.method === 'confirm' ? response.confirmed : response.value;
    return active.choose({ value, remote: true });
  }

  notify(message: string, notifyType = 'info') {
    if (message.length > MAX_TEXT || this.disposed) return;
    this.emit({ type: 'ui_notification', version: UI_VERSION, uiEpoch: this.uiEpoch, message, notifyType });
  }

  setStatus(key: string, text: string | undefined) {
    if (key.length > MAX_TEXT || (text !== undefined && text.length > MAX_TEXT) || this.disposed) return;
    const previous = { ...this.status };
    if (text === undefined) delete this.status[key];
    else if (Object.keys(this.status).length < 128 || key in this.status) this.status[key] = text;
    if (Buffer.byteLength(JSON.stringify(this.status), 'utf8') > 128 * 1024) { this.status = Object.assign(Object.create(null), previous); return; }
    this.changed();
  }

  dispose(): Promise<void> {
    this.disposed = true;
    // Runtime/session invalidation, never called on a transport disconnect.
    this.active?.choose?.({ value: this.active.request.method === 'confirm' ? false : undefined, remote: true });
    return this.queue;
  }
}
