'use strict';
// Shared by the hook recorder and daemon. This is replay, never a planner.
function replaySnapshots(branch, requestId) {
  const snapshots = new Map();
  let latest;
  for (const entry of branch) {
    if (entry.type !== 'custom' || entry.customType !== 'rolling-context.projection-snapshot.v2') continue;
    const data = entry.data;
    if (data?.schemaVersion !== 2 || typeof data.requestId !== 'string' || (!Array.isArray(data.segments)&&!Array.isArray(data.suffix))) continue;
    latest=data;snapshots.set(data.requestId,data);
  }
  const target=requestId?snapshots.get(requestId):latest;
  if(!target)return;
  const chain=[],seen=new Set();let cursor=target;
  while(cursor){
    if(seen.has(cursor.requestId))return;seen.add(cursor.requestId);chain.push(cursor);
    if(!cursor.prefixRequestId)break;
    cursor=snapshots.get(cursor.prefixRequestId);if(!cursor)return;
  }
  let rows=[];
  for(const data of chain.reverse()){
    if(Array.isArray(data.segments)){
      const next=[];
      for(const segment of data.segments){
        if(Array.isArray(segment.rows))next.push(...segment.rows);
        else if(Number.isSafeInteger(segment.from)&&segment.from>=0&&Number.isSafeInteger(segment.count)&&segment.count>0&&segment.from+segment.count<=rows.length)next.push(...rows.slice(segment.from,segment.from+segment.count));
        else return;
      }
      rows=next;
    }else{
      if(!Number.isSafeInteger(data.prefixLength)||data.prefixLength<0||data.prefixLength>rows.length)return;
      rows=[...rows.slice(0,data.prefixLength),...data.suffix];
    }
    if(rows.length!==data.messageCount)return;
  }
  return {...target,rows};
}
module.exports = { replaySnapshots };
