import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Content hashes cover all package runtime dependencies, including new/deleted files. */
export function sourceFingerprint(root: string): string {
  const files = [join(root, 'package.json')];
  function walk(dir: string) {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (item.isDirectory() && !['node_modules', '.git'].includes(item.name)) walk(join(dir,item.name));
      else if (item.isFile() && /\.(?:ts|js|mjs|cjs|json)$/.test(item.name)) files.push(join(dir,item.name));
    }
  }
  walk(join(root,'extensions'));
  const hash=createHash('sha256');
  for(const file of files){hash.update(relative(root,file));hash.update('\0');hash.update(readFileSync(file));hash.update('\0');}
  return hash.digest('hex');
}

type Options = { fingerprint:()=>string; blocked:()=>string|undefined; dispatch:()=>Promise<void>; report:(error:unknown)=>void };

/** No await between the last local busy check and dispatch. The command rechecks again. */
export class SafeReloadController {
  private loaded: string;
  private observed: string;
  private changedAt=0;
  private pending=false;
  private dispatching=false;
  private stopped=false;
  private retryAt=0;
  private reason='';
  private failure:string|undefined;
  private ignored:string|undefined;
  private options:Options;
  private quietMs:number;
  public enabled:boolean;
  constructor(options:Options, enabled=true, quietMs=2000) {
    this.options=options;this.enabled=enabled;this.quietMs=quietMs;
    this.loaded=this.observed=options.fingerprint();
  }
  request(reason='Manual reload request'){this.pending=true;this.reason=reason;this.failure=undefined;this.retryAt=0;this.ignored=undefined;}
  cancel(){this.pending=false;this.reason='';this.ignored=this.observed;}
  stop(){this.stopped=true;this.pending=false;}
  status(){return {enabled:this.enabled,pending:this.pending,dispatching:this.dispatching,reason:this.reason,
    blocked:this.pending?this.options.blocked():undefined,failure:this.failure,loadedVersion:this.loaded.slice(0,12),observedVersion:this.observed.slice(0,12)};}
  async tick(now=Date.now()) {
    if(this.stopped||this.dispatching)return;
    try {
      if(this.enabled){
        const fingerprint=this.options.fingerprint();
        if(fingerprint!==this.observed){this.observed=fingerprint;this.changedAt=now;this.failure=undefined;this.retryAt=0;}
        if(this.observed!==this.loaded&&this.observed!==this.ignored&&!this.pending){this.pending=true;this.reason='Package source changed';}
        if(this.observed===this.loaded&&this.reason==='Package source changed'){this.pending=false;this.reason='';}
      }
      if(!this.pending||now<this.retryAt||now-this.changedAt<this.quietMs||this.options.blocked())return;
      this.dispatching=true;
      await this.options.dispatch();
    } catch(error) {this.failure=String(error);this.retryAt=now+30000;this.options.report(error);}
    finally {this.dispatching=false;}
  }
  async apply(reload:()=>Promise<void>) {
    if(this.stopped||!this.pending||this.options.blocked())return false;
    // Calling the host reload immediately is important: waiting on agent_end or idle
    // inside an event callback can deadlock, and a prior idle observation can be stale.
    await reload();
    if(!this.stopped){this.loaded=this.observed;this.pending=false;this.reason='';}
    return true;
  }
}
