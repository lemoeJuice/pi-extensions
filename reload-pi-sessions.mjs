#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function ancestorPids(pid=process.ppid) {
  const pids=new Set();
  while(Number.isInteger(pid)&&pid>1&&!pids.has(pid)){
    pids.add(pid);
    try {pid=Number(readFileSync(`/proc/${pid}/status`,'utf8').match(/^PPid:\s+(\d+)$/m)?.[1]);}
    catch {break;}
  }
  return pids;
}

/** Sends only the registered idle-gated command. It never signals or replaces Pi. */
export async function queueReloads({url,sessionId,current=false,dryRun=false,ancestors=ancestorPids(),fetcher=fetch}) {
  const base=new URL(url);if(!['http:','https:'].includes(base.protocol))throw new Error('Daemon URL must use http or https');
  const endpoint=pathname=>new URL(pathname,base);
  const list=await fetcher(endpoint('/api/sessions'),{signal:AbortSignal.timeout(8000)});
  if(!list.ok)throw new Error(`Could not list Pi sessions: HTTP ${list.status}`);
  const sessions=await list.json();if(!Array.isArray(sessions))throw new Error('Invalid daemon session list');
  const results=[];
  for(const session of sessions){
    if(sessionId&&session.sessionId!==sessionId)continue;
    if(current&&!session.instances?.some(instance=>ancestors.has(instance.pid)))continue;
    const label=session.title||session.sessionId;
    if(!session.live||!session.writable){results.push({sessionId:session.sessionId,label,status:'skipped',reason:'Offline or conflicting session'});continue;}
    if(!session.commands?.some(command=>command.name==='reload-safe')){
      results.push({sessionId:session.sessionId,label,status:'skipped',reason:'Old Pi runtime: first use native /reload after its task finishes'});continue;
    }
    if(!session.metadata?.reload){results.push({sessionId:session.sessionId,label,status:'skipped',reason:'Safe reloader inactive (requires supported TUI with UI proxy)'});continue;}
    if(dryRun){results.push({sessionId:session.sessionId,label,status:'would-queue',activity:session.status});continue;}
    try {
      const response=await fetcher(endpoint(`/api/sessions/${encodeURIComponent(session.sessionId)}/commands`),{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'reload-safe',args:''}),signal:AbortSignal.timeout(8000)});
      const reply=await response.json();
      results.push({sessionId:session.sessionId,label,status:response.ok?'queued':'failed',reason:reply.error||reply.result,activity:session.status});
    }catch(error){results.push({sessionId:session.sessionId,label,status:'failed',reason:String(error)});}
  }
  return results;
}

export async function main(args=process.argv.slice(2)) {
  const options={url:process.env.PI_REMOTE_URL||`http://${process.env.PI_REMOTE_HOST||'100.64.209.124'}:${process.env.PI_REMOTE_PORT||4317}`};
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg==='--dry-run')options.dryRun=true;
    else if(arg==='--current')options.current=true;
    else if(arg==='--session'||arg==='--url'){if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(`${arg} requires a value`);options[arg==='--session'?'sessionId':'url']=args[++i];}
    else if(arg==='--help'){console.log('Usage: ./reload-pi-sessions.mjs [--dry-run] [--current | --session ID] [--url URL]\nDefault: queue safe resource reload for every registered writable Pi; active tasks finish first.');return;}
    else throw new Error(`Unknown option: ${arg}`);
  }
  if(options.current&&options.sessionId)throw new Error('Choose --current or --session');
  const results=await queueReloads(options);
  if(!results.length){console.log('No matching registered Pi sessions; no process was touched.');process.exitCode=1;return;}
  for(const result of results)console.log(`${result.status}: ${result.label} (${result.sessionId})${result.reason?` — ${result.reason}`:''}`);
  console.log('Queued means accepted for dispatch, not completed. Check /auto-reload status in Pi. Unregistered Pi processes are untouched.');
  if(results.some(result=>result.status==='failed'||result.status==='skipped'))process.exitCode=1;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
