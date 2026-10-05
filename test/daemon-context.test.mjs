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
 assert.deepEqual(data.turns.map(r=>r.turn),[1,2]);assert.equal(data.turns[0].cacheRead,null);assert.equal(data.turns[0].cacheWrite,null);assert.equal(data.turns[1].cacheRead,400);assert.equal(data.turns[0].checkpointReason,null);assert.ok(!JSON.stringify(data).includes('do not export'));
 assert.equal((await readHistory(file,'graph','t2')).messages.length,1);
 await assert.rejects(readTelemetry(file,'other','t2'),e=>e.status===403);
 await assert.rejects(readTelemetry(file,'graph','missing-leaf'),e=>e.status===409);
 const outside=path.join(root,'outside.jsonl');await writeFile(outside,'{}');await assert.rejects(readTelemetry(outside,'graph'),e=>e.status===403);
});
test('graph renders three views, missing-value gaps, event markers and escaped labels',()=>{
 const rows=[{turn:1,rawTokens:1000,effectiveTokens:900,hotTokens:800,warmTokens:90,checkpointTokens:0,otherTokens:10,stateBytes:2000,capsulesCreated:1},{turn:2,rawTokens:2000,effectiveTokens:null,stateBytes:null},{turn:3,rawTokens:3000,effectiveTokens:1000,hotTokens:500,warmTokens:200,checkpointTokens:290,otherTokens:10,stateBytes:2100,checkpointCreated:true,checkpointReason:'<script>'}];
 const nodes=new Map();render({querySelector(id){if(!nodes.has(id))nodes.set(id,{innerHTML:''});return nodes.get(id)}},{turns:rows,checkpoints:[]});
 for(const id of ['#size','#composition','#memory'])assert.match(nodes.get(id).innerHTML,/<svg/);
 assert.match(nodes.get('#size').innerHTML,/warm-event/);assert.match(nodes.get('#size').innerHTML,/checkpoint-event/);assert.match(nodes.get('#composition').innerHTML,/<polygon/);assert.match(nodes.get('#memory').innerHTML,/KiB/);assert.match(nodes.get('#details').innerHTML,/&lt;script&gt;/);
 assert.ok(!nodes.get('#size').innerHTML.includes('NaN'));assert.ok(!chart([],[{key:'rawTokens',label:'Raw',color:'#333'}]).includes('Infinity'));
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
