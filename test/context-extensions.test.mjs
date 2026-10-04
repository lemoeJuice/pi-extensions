import test from 'node:test';
import assert from 'node:assert/strict';
import rollingContext from '../extensions/rolling-context/index.ts';
import designIntent from '../extensions/design-intent/index.ts';

function mockPi(){
 const tools=new Map(),commands=new Map(),events=new Map(),flags=new Map();
 return{tools,commands,events,flags,
  registerTool(tool){assert.ok(!tools.has(tool.name));tools.set(tool.name,tool);},
  registerCommand(name,command){commands.set(name,command);},
  registerFlag(name,definition){flags.set(name,definition);},
  getFlag(name){return flags.get(name)?.default;},
  on(name,handler){const handlers=events.get(name)||[];handlers.push(handler);events.set(name,handlers);},
  appendEntry(){},
 };
}

test('both context extensions register their public tools, commands, and lifecycle hooks',()=>{
 const rolling=mockPi();rollingContext(rolling);
 assert.deepEqual([...rolling.tools.keys()],['context_note','context_recall']);
 assert.ok(rolling.commands.has('rolling-context'));
 assert.ok(rolling.events.has('turn_end'));
 const design=mockPi();designIntent(design);
 assert.deepEqual([...design.tools.keys()],['design_intent_query','design_intent_get','design_intent_propose','design_intent_check']);
 assert.ok(design.commands.has('design-intent'));
 assert.ok(design.events.has('before_agent_start'));
});
