import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readTelemetry, readHistory } from '../extensions/daemon/daemon/history.js';
import graph from '../extensions/daemon/web/context-graph.js';
const { chart, render } = graph;

async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'pi-context-graph-'));const old=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=root;
 t.after(async()=>{if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;await rm(root,{recursive:true,force:true});});
 const dir=path.join(root,'sessions','project');await mkdir(dir,{recursive:true});const file=path.join(dir,'session-graph.jsonl');
 const entries=[{type:'session',version:3,id:'graph',cwd:root},
 {type:'message',id:'u',parentId:null,message:{role:'user',content:'Inspect',timestamp:0}},
 {type:'custom',customType:'rolling-context.telemetry.v1',id:'t1',parentId:'u',data:{turn:1,epoch:0,rawTokens:200,effectiveTokens:190,warmTokens:0,hotTokens:180,otherTokens:10,checkpointTokens:0,mode:'observe',stateBytes:1000,cacheRead:null,cacheWrite:undefined,input:null,secret:'do not export',checkpointReason:'<script>alert(1)</script>'}},
 {type:'custom',customType:'rolling-context.telemetry.v1',id:'t2',parentId:'t1',data:{turn:2,epoch:0,rawTokens:1000,effectiveTokens:600,hotTokens:300,warmTokens:290,otherTokens:10,checkpointTokens:0,capsulesCreated:2,stateBytes:1800,input:20,cacheRead:400,cacheWrite:30,mode:'on'}},
 {type:'custom',customType:'rolling-context.telemetry.v1',id:'other-branch',parentId:'u',data:{turn:99,rawTokens:99999,effectiveTokens:88888}}];
 await writeFile(file,entries.map(e=>JSON.stringify(e)).join('\n')+'\n');return {root,file};
}
test('telemetry endpoint data stays on the selected branch and exports only typed metrics',async t=>{
 const {file,root}=await fixture(t);const data=await readTelemetry(file,'graph','t2');
 assert.deepEqual(data.turns.map(r=>r.turn),[0,1,2]);assert.equal(data.turns[0].gap,true);assert.equal(data.turns[0].rawTokens,null);assert.equal(data.turns[1].cacheRead,null);assert.equal(data.turns[1].cacheWrite,null);assert.equal(data.turns[2].cacheRead,400);assert.ok(Math.abs(data.turns[2].cacheReuseRatio-400/420)<1e-12);assert.match(data.usageBasis,/uncached input/);assert.equal(data.turns[1].checkpointReason,null);assert.ok(!JSON.stringify(data).includes('do not export'));
 assert.equal((await readHistory(file,'graph','t2')).messages.length,1);
 await assert.rejects(readTelemetry(file,'other','t2'),e=>e.status===403);
 await assert.rejects(readTelemetry(file,'graph','missing-leaf'),e=>e.status===409);
 const outside=path.join(root,'outside.jsonl');await writeFile(outside,'{}');await assert.rejects(readTelemetry(outside,'graph'),e=>e.status===403);
});
test('measured initial telemetry replaces the legacy Turn 0 unknown gap',async t=>{
 const {file}=await fixture(t);const fs=await import('node:fs/promises');const entries=(await fs.readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
 const t0={type:'custom',customType:'rolling-context.telemetry.v1',id:'t0',parentId:'u',data:{turn:0,timelineKind:'initial',rawTokens:17,effectiveTokens:15,targetTokens:1000,hotTokens:15,warmTokens:0,cacheRead:null,cacheWrite:null,input:null}};
 entries.find(entry=>entry.id==='t1').parentId='t0';entries.splice(entries.findIndex(entry=>entry.id==='t1'),0,t0);await fs.writeFile(file,entries.map(entry=>JSON.stringify(entry)).join('\n')+'\n');
 const data=await readTelemetry(file,'graph','t2');assert.deepEqual(data.turns.map(row=>row.turn),[0,1,2]);assert.equal(data.turns[0].gap,undefined);assert.equal(data.turnZero,'measured');assert.equal(data.turns[0].rawTokens,17);
});
test('graph renders three views, missing-value gaps, event markers and escaped labels',()=>{
 const rows=[{turn:1,rawTokens:1000,effectiveTokens:900,hotTokens:800,warmTokens:90,checkpointTokens:0,otherTokens:10,stateBytes:2000,capsulesCreated:1},{turn:2,rawTokens:2000,effectiveTokens:null,stateBytes:null},{turn:3,rawTokens:3000,effectiveTokens:1000,hotTokens:500,warmTokens:200,checkpointTokens:290,otherTokens:10,stateBytes:2100,checkpointCreated:true,checkpointReason:'<script>'}];
 const nodes=new Map();render({querySelector(id){if(!nodes.has(id))nodes.set(id,{innerHTML:''});return nodes.get(id)}},{turns:rows,checkpoints:[]});
 for(const id of ['#size','#composition','#memory'])assert.match(nodes.get(id).innerHTML,/<svg/);
 assert.match(nodes.get('#size').innerHTML,/marker-warm/);assert.match(nodes.get('#size').innerHTML,/marker-checkpoint/);assert.match(nodes.get('#composition').innerHTML,/<polygon/);assert.match(nodes.get('#memory').innerHTML,/KiB/);assert.match(nodes.get('#inspector').innerHTML,/&lt;script&gt;/);
 assert.ok(!nodes.get('#size').innerHTML.includes('NaN'));assert.ok(!chart([],[{key:'rawTokens',label:'Raw',color:'#333'}]).includes('Infinity'));
 const long=chart([{turn:0,rawTokens:null},{turn:1,rawTokens:100},{turn:78,rawTokens:200}],[{key:'rawTokens',label:'Raw',color:'#333'}]);assert.match(long,/text class="tick"[^>]*>0</);assert.match(long,/text class="tick"[^>]*>78</);assert.doesNotMatch(long,/>turn</i);const tickX=[...long.matchAll(/text class="tick" x="([\d.]+)"/g)].map(match=>Number(match[1]));assert.equal(tickX.length,5);for(let i=1;i<tickX.length;i++)assert.ok(tickX[i]-tickX[i-1]>20);
 const stacked=chart([{turn:0,hotTokens:10,warmTokens:0},{turn:1,hotTokens:null,warmTokens:0},{turn:2,hotTokens:20,warmTokens:5}],[{key:'hotTokens',label:'Hot',color:'#333'},{key:'warmTokens',label:'Warm',color:'#999'}],{stacked:true});assert.doesNotMatch(stacked,/Turn 1:/);
});
test('cache rebuild events are attributed across the warm-event and following request boundary',()=>{
 const rows=[{turn:0,timelineKind:'initial',rawTokens:500,effectiveTokens:450},{turn:70,capsulesCreated:2,capsuleTokensSaved:4200,warmEventSourceTokens:6000,warmEventCapsuleTokens:1800,estimatedInvalidatedSuffixTokens:900,cacheRead:1000,uncachedInput:500,cacheReuseRatio:.667},{turn:71,cacheRead:88000,cacheWrite:3000,uncachedInput:22000,cacheReuseRatio:.805},{turn:72,cacheRead:110000,cacheWrite:500,uncachedInput:1600,cacheReuseRatio:.986}];
 const nodes=new Map();render({querySelector(id){if(!nodes.has(id))nodes.set(id,{innerHTML:''});return nodes.get(id)}},{turns:rows,checkpoints:[]});
 const events=nodes.get('#event-log').innerHTML;assert.match(events,/HOT → WARM/);assert.match(events,/source 6,000 → capsules 1,800/);assert.match(events,/CACHE REBUILD/);assert.match(events,/associated with warm event turn 70/);assert.match(events,/following request turn 71/);assert.match(events,/cache reuse recovered by turn 72/);assert.match(events,/not exact provider attribution/);
 const inspector=nodes.get('#inspector').innerHTML;assert.match(inspector,/uncached 1,600 · cacheRead 110,000/);
});
test('existing daemon serves Graph View and branch telemetry without importing Rolling Context',async t=>{
 const {file,root}=await fixture(t);const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 const child=spawn(process.execPath,['extensions/daemon/daemon/main.js'],{env:{...process.env,PI_REMOTE_HOST:'127.0.0.1',PI_REMOTE_PORT:String(port),PI_CODING_AGENT_DIR:root},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}});
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('daemon startup timed out')),5000);child.stdout.on('data',d=>{if(String(d).includes('listening')){clearTimeout(timeout);resolve();}});child.on('exit',code=>{clearTimeout(timeout);reject(new Error(`daemon exited ${code}`));});});
 const base=`http://127.0.0.1:${port}`;
 const graph=await fetch(base+'/s/graph/context');assert.equal(graph.status,200);assert.match(await graph.text(),/Context composition/);
 assert.equal((await fetch(base+'/context-graph.js')).status,200);
 // File discovery is shared with history; no caller-controlled filesystem path.
 const metrics=await fetch(base+'/api/sessions/graph/context-telemetry');assert.equal(metrics.status,200);const data=await metrics.json();assert.equal(data.tokenBasis,'host-estimate');assert.ok(data.turns.length);
 assert.equal((await fetch(base+'/api/sessions/not-found/context-telemetry')).status,404);
});
