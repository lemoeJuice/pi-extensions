import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SafeReloadController, sourceFingerprint } from '../extensions/daemon/reload/controller.ts';
import { UIBroker } from '../extensions/daemon/ui/broker.ts';
import { queueReloads } from '../reload-pi-sessions.mjs';

function controller(){
  let fingerprint='a',blocked;let calls=0,dispatches=0;const errors=[];
  const c=new SafeReloadController({fingerprint:()=>fingerprint,blocked:()=>blocked,
    dispatch:async()=>{dispatches++;await c.apply(async()=>{calls++;});},report:error=>errors.push(error)});
  return {c,errors,setFingerprint:v=>fingerprint=v,setBlocked:v=>blocked=v,get calls(){return calls;},get dispatches(){return dispatches;}};
}

test('safe reload defers a running agent, queued work, UI and shell until every local guard is clear',async()=>{
  const h=controller();h.c.request();
  for(const reason of ['agent active','queued message','pending dialog','shell active']){
    h.setBlocked(reason);await h.c.tick(10000);assert.equal(h.calls,0);assert.equal(h.c.status().blocked,reason);
  }
  h.setBlocked(undefined);await h.c.tick(11000);assert.equal(h.calls,1);assert.equal(h.c.status().pending,false);
  await h.c.tick(12000);assert.equal(h.calls,1);
});

test('safe command rechecks idle when work starts after watcher observed idle',async()=>{
  let busy=false,calls=0;
  const c=new SafeReloadController({fingerprint:()=> 'a',blocked:()=>busy?'active':undefined,
    dispatch:async()=>{busy=true;assert.equal(await c.apply(async()=>{calls++;}),false);},report:assert.fail});
  c.request();await c.tick(10000);assert.equal(calls,0);assert.equal(c.status().pending,true);
  busy=false;assert.equal(await c.apply(async()=>{calls++;}),true);assert.equal(calls,1);
});

test('multiple source changes debounce into one reload and preserve a changed version while busy',async()=>{
  const h=controller();h.setFingerprint('b');await h.c.tick(10000);h.setFingerprint('c');await h.c.tick(11000);
  await h.c.tick(12500);assert.equal(h.calls,0);h.setBlocked('tool active');await h.c.tick(14000);assert.equal(h.calls,0);
  h.setBlocked(undefined);await h.c.tick(15000);assert.equal(h.calls,1);assert.equal(h.c.status().loadedVersion,'c');
});

test('off disables automatic changes but manual request remains safe; cancel suppresses only current change',async()=>{
  const h=controller();h.c.enabled=false;h.setFingerprint('b');await h.c.tick(10000);assert.equal(h.calls,0);
  h.c.request();await h.c.tick(11000);assert.equal(h.calls,1);
  h.c.enabled=true;await h.c.tick(12000);h.c.cancel();await h.c.tick(16000);assert.equal(h.calls,1);
  h.setFingerprint('c');await h.c.tick(17000);await h.c.tick(20000);assert.equal(h.calls,2);
});

test('shutdown cancels timers work and late apply; rejected reload is reported with retry backoff',async()=>{
  const h=controller();h.c.request();h.c.stop();await h.c.tick(10000);assert.equal(await h.c.apply(async()=>{throw Error('must not run');}),false);assert.equal(h.calls,0);
  let dispatches=0;const errors=[];
  const failing=new SafeReloadController({fingerprint:()=> 'a',blocked:()=>undefined,dispatch:async()=>{dispatches++;throw Error('failed');},report:e=>errors.push(e)});
  failing.request();await failing.tick(10000);await failing.tick(11000);assert.equal(dispatches,1);assert.equal(errors.length,1);assert.equal(failing.status().pending,true);
  await failing.tick(41000);assert.equal(dispatches,2);
});

test('runtime fingerprint covers nested/new/deleted sources and package manifest, ignores docs',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'pi-reload-hash-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'extensions','shared'),{recursive:true});await writeFile(path.join(root,'package.json'),'{}');
  await writeFile(path.join(root,'extensions','main.ts'),'export default 1');const first=sourceFingerprint(root);
  await writeFile(path.join(root,'extensions','README.md'),'docs');assert.equal(sourceFingerprint(root),first);
  const helper=path.join(root,'extensions','shared','helper.ts');await writeFile(helper,'export const x=1');assert.notEqual(sourceFingerprint(root),first);
  await rm(helper);assert.equal(sourceFingerprint(root),first);await writeFile(path.join(root,'package.json'),'{"version":"2"}');assert.notEqual(sourceFingerprint(root),first);
});

test('UI activity includes queued dialogs before microtasks and preserves local-only cleanup',async()=>{
  const broker=new UIBroker(()=>{});let done;
  const pending=broker.dialog('confirm',{title:'Approve',message:'Exact'},undefined,()=>new Promise(resolve=>{done=resolve;}));
  assert.equal(broker.hasPendingRequests,true);await new Promise(setImmediate);done(true);assert.equal(await pending,true);assert.equal(broker.hasPendingRequests,false);
  let finish;const local=broker.localOnly('custom','Custom',()=>new Promise(resolve=>{finish=resolve;}));
  assert.equal(broker.hasPendingRequests,true);finish(42);assert.equal(await local,42);assert.equal(broker.hasPendingRequests,false);await broker.dispose();
});

const session=(id,extra={})=>({sessionId:id,title:id,live:true,writable:true,status:'running',instances:[{pid:10}],commands:[{name:'reload-safe'}],metadata:{reload:{enabled:true}},...extra});
function transport(sessions){const posts=[];return {posts,fetcher:async(url,options)=>{
  if(options.method==='POST'){posts.push({url:String(url),body:JSON.parse(options.body)});return {ok:true,status:202,json:async()=>({result:'Dispatched'})};}
  return {ok:true,status:200,json:async()=>sessions};
}};}

test('batch script queues only safe reload commands, including running sessions; skips legacy/conflicts/unsupported',async()=>{
  const http=transport([session('busy'),session('idle',{status:'idle'}),session('conflict',{writable:false}),session('old',{commands:[]}),session('rpc',{metadata:{}})]);
  const result=await queueReloads({url:'http://127.0.0.1:4317',fetcher:http.fetcher});
  assert.deepEqual(result.map(r=>r.status),['queued','queued','skipped','skipped','skipped']);
  assert.equal(http.posts.length,2);assert.deepEqual(http.posts.map(p=>p.body),[{name:'reload-safe',args:''},{name:'reload-safe',args:''}]);
});

test('batch dry-run sends no command; current/session selection cannot guess by newest session file',async()=>{
  const http=transport([session('current'),session('other',{instances:[{pid:20}]})]);
  const dry=await queueReloads({url:'http://localhost',dryRun:true,fetcher:http.fetcher});assert.equal(http.posts.length,0);assert.equal(dry.length,2);
  const current=await queueReloads({url:'http://localhost',current:true,ancestors:new Set([10]),fetcher:http.fetcher});assert.equal(current.length,1);assert.equal(current[0].sessionId,'current');
  const selected=await queueReloads({url:'http://localhost',sessionId:'other',fetcher:http.fetcher});assert.equal(selected[0].sessionId,'other');
});

test('batch failure does not fall back to messages, abort, process signals or an unsafe native reload',async()=>{
  const posts=[];const result=await queueReloads({url:'http://localhost',fetcher:async(url,options)=>{
    if(options.method==='POST'){posts.push(String(url));throw Error('offline');}return {ok:true,json:async()=>[session('s')]};
  }});
  assert.equal(result[0].status,'failed');assert.deepEqual(posts,['http://localhost/api/sessions/s/commands']);
});
