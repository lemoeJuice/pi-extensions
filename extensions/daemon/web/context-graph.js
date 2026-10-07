(function(root){
  'use strict';
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  const colors=['#7863ae','#29968c','#bb7d25','#b54573','#64748b'];
  const escape=value=>String(value??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let selectedTurn=null,detailsMode='events';
  const format=n=>finite(n)?Math.round(n).toLocaleString():'—';
  const short=n=>!finite(n)?'—':n>=1000000?`${(n/1000000).toFixed(1)}m`:n>=1000?`${(n/1000).toFixed(n>=10000?0:1)}k`:String(Math.round(n));
  const ratio=n=>finite(n)?`${(n*100).toFixed(1)}%`:'—';
  function eventMarks(rows,checkpoints=[]){
    const marks=[];
    for(const row of rows){
      if(row.turn>0&&row.capsulesCreated>0)marks.push({turn:row.turn,kind:'warm',label:`W · HOT → WARM · ${row.capsulesCreated} capsules · ${format(row.capsuleTokensSaved)} tokens saved · estimated affected suffix ${format(row.estimatedInvalidatedSuffixTokens)} tokens`});
      if(row.turn>0&&row.checkpointCreated)marks.push({turn:row.turn,kind:'checkpoint',label:`C · Rolling checkpoint · ${row.checkpointReason??'checkpoint'}`});
      if(row.turn>0&&row.checkpointWanted&&!row.checkpointCreated&&(row.checkpointBlockedBy||[]).length)marks.push({turn:row.turn,kind:'blocked',label:`! · Checkpoint wanted but blocked · ${(row.checkpointBlockedBy||[]).join(', ')}`});
    }
    for(const compact of checkpoints||[])if(!compact.rolling&&finite(compact.turn))marks.push({turn:compact.turn,kind:'foreign',label:`F · Foreign/native compact · ${compact.reason??'host compaction'}`});
    return marks;
  }
  function chart(rows,series,{stacked=false,bytes=false,markers=[],thresholds=[],height=250,selected=null}={}){
    const w=1040,h=height,left=76,right=48,top=20,bottom=35,plotW=w-left-right;
    const last=Math.max(1,...rows.map(row=>finite(row.turn)?row.turn:0));
    const x=n=>left+Math.max(0,Math.min(last,n))/last*plotW;
    let max=Math.max(1,...rows.map(row=>stacked?series.reduce((sum,item)=>sum+(finite(row[item.key])?row[item.key]:0),0):Math.max(0,...series.map(item=>finite(row[item.key])?row[item.key]:0))));
    for(const t of thresholds)if(finite(t.value))max=Math.max(max,t.value);
    max*=1.08;
    const y=n=>h-bottom-n/max*(h-top-bottom);
    let svg=`<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${escape(series.map(item=>item.label).join(', '))} by completed turn; timeline begins at zero">`;
    for(let i=0;i<=4;i++){const value=max*i/4;svg+=`<line class="grid" x1="${left}" y1="${y(value)}" x2="${w-right}" y2="${y(value)}"/><text x="${left-9}" y="${y(value)+4}" text-anchor="end">${bytes?`${(value/1024).toFixed(value>1024*100?0:1)} KiB`:short(value)}</text>`;}
    const ticks=[...new Set([0,Math.round(last*.25),Math.round(last*.5),Math.round(last*.75),last])];
    for(const tick of ticks)svg+=`<text class="tick" x="${x(tick)}" y="${h-10}" text-anchor="middle">${tick}</text>`;
    thresholds.forEach((t,index)=>{if(!finite(t.value))return;svg+=`<line class="threshold threshold-${index}" x1="${left}" x2="${w-right}" y1="${y(t.value)}" y2="${y(t.value)}"/><text class="threshold-label" x="${left+5}" y="${y(t.value)-4}">${escape(t.label)}</text>`;});
    series.forEach((item,index)=>{
      const runs=[];let run=[];
      rows.forEach(row=>{
        const value=row[item.key];
        if(!finite(row.turn)||!finite(value)||(stacked&&series.some(part=>!finite(row[part.key])))){if(run.length)runs.push(run);run=[];return;}
        const base=stacked?series.slice(0,index).reduce((sum,part)=>sum+(finite(row[part.key])?row[part.key]:0),0):0;
        run.push({x:x(row.turn),y:y(base+value),base:y(base),turn:row.turn,value});
      });if(run.length)runs.push(run);
      for(const points of runs){
        if(stacked){const polygon=[...points.map(point=>`${point.x},${point.y}`),...points.slice().reverse().map(point=>`${point.x},${point.base}`)].join(' ');svg+=`<polygon points="${polygon}" fill="${item.color||colors[index%colors.length]}" opacity=".62"/>`;}
        svg+=`<polyline points="${points.map(point=>`${point.x},${point.y}`).join(' ')}" fill="none" stroke="${item.color||colors[index%colors.length]}" stroke-width="2"/>`;
        for(const point of points)svg+=`<circle class="point${selected===point.turn?' selected':''}" data-turn="${point.turn}" tabindex="0" role="button" aria-label="Select turn ${point.turn}" cx="${point.x}" cy="${point.y}" r="4" fill="${item.color||colors[index%colors.length]}"><title>Turn ${point.turn}: ${escape(item.label)} ${format(point.value)}</title></circle>`;
      }
    });
    for(const mark of markers){if(!finite(mark.turn))continue;const cls=`marker marker-${mark.kind}`;svg+=`<line class="${cls}" data-turn="${mark.turn}" tabindex="0" role="button" x1="${x(mark.turn)}" x2="${x(mark.turn)}" y1="${top}" y2="${h-bottom}"><title>After turn ${mark.turn}, before request ${mark.turn+1}: ${escape(mark.label)}</title></line>`;}
    if(finite(selected))svg+=`<line class="selected-line" x1="${x(selected)}" x2="${x(selected)}" y1="${top}" y2="${h-bottom}" pointer-events="none"/>`;
    return svg+`</svg><div class="legend">${series.map((item,index)=>`<span style="--color:${item.color||colors[index%colors.length]}">${escape(item.label)}</span>`).join('')}${thresholds.map((item,index)=>`<span class="threshold-legend threshold-legend-${index}">${escape(item.label)}</span>`).join('')}</div>`;
  }
  function rowAt(rows,turn){return rows.find(row=>row.turn===turn)||null;}
  function render(doc,data,requestedTurn){
    const rows=(data.turns||[]).slice().sort((a,b)=>a.turn-b.turn),compactions=data.checkpoints||[],markers=eventMarks(rows,compactions);
    const latest=rows.filter(row=>row.turn>0).at(-1)||rows.at(-1)||{};
    if(requestedTurn!==undefined)selectedTurn=requestedTurn;
    if(!rows.some(row=>row.turn===selectedTurn))selectedTurn=latest.turn??0;
    const selected=rowAt(rows,selectedTurn)||{};
    const target=latest.targetTokens,ratioValue=finite(target)&&target>0&&finite(latest.effectiveTokens)?latest.effectiveTokens/target:null;
    const stateLimit=latest.stateLimitBytes||128*1024,statePct=finite(latest.stateBytes)?latest.stateBytes/stateLimit:null;
    const lastRatio=finite(latest.cacheReuseRatio)?latest.cacheReuseRatio:latest.usage?.cacheReuseRatio;
    let status='Healthy',statusNote='Projection is within the configured target.';
    if(latest.mode==='off'||latest.mode==='observe'||!rows.some(row=>row.timelineKind==='initial')){status='Fallback';statusNote=latest.mode==='observe'?'Observe mode does not apply projection edits.':!rows.some(row=>row.timelineKind==='initial')?'Initial Turn 0 baseline is unavailable for this session.':'Rolling Context is off.';}
    if(latest.checkpointWanted&&(latest.checkpointBlockedBy||[]).length&&!latest.checkpointCreated){status='Blocked';statusNote=`Checkpoint wanted but blocked: ${(latest.checkpointBlockedBy||[]).join(', ')}`;}
    else if((ratioValue!==null&&ratioValue>1.2)||(statePct!==null&&statePct>=.8)){status='Degraded';statusNote=ratioValue!==null&&ratioValue>1.2?'Effective context is materially above target.':'Working state is approaching its hard limit.';}
    const foreignCount=compactions.filter(compaction=>!compaction.rolling).length;
    const effectiveOver=finite(latest.effectiveTokens)&&finite(target)&&target>0?`${short(latest.effectiveTokens)} / ${short(target)} (${ratioValue.toFixed(1)}×)`: '—';
    const reduction=finite(latest.rawTokens)&&finite(latest.effectiveTokens)?`${short(latest.rawTokens)} → ${short(latest.effectiveTokens)} (${latest.rawTokens?Math.round((1-latest.effectiveTokens/latest.rawTokens)*100):0}% reduction)`:'—';
    const warmCoverage=finite(latest.warmSourceTokens)&&finite(latest.eligibleHistoricalTokens)?`${short(latest.warmSourceTokens)} / ${short(latest.eligibleHistoricalTokens)} source tokens`:short(latest.warmSourceTokens);
    doc.querySelector('#overview').innerHTML=`<div class="status-card status-${status.toLowerCase()}"><strong>${status}</strong><span>${escape(statusNote)}</span></div><div class="metric-grid">${[
      ['Mode',latest.mode??'unknown'],['Turns',`${rows.filter(row=>row.turn>0).length} completed`],['Effective / target',effectiveOver],['Raw → effective',reduction],['RC epoch',latest.epoch??'—'],['Foreign/native compactions',foreignCount],['Warm source coverage',warmCoverage],['Cache reuse',ratio(lastRatio)],['Memory state',`${finite(latest.stateBytes)?short(latest.stateBytes)+' B':'—'} / ${short(stateLimit)} B (${statePct===null?'—':ratio(statePct)})`]
    ].map(([label,value])=>`<div class="metric"><small>${escape(label)}</small><strong>${escape(value)}</strong></div>`).join('')}</div>`;
    const sizeThresholds=[];
    if(finite(latest.targetTokens))sizeThresholds.push({value:latest.targetTokens,label:'Target'});
    if(finite(latest.softThresholdTokens))sizeThresholds.push({value:latest.softThresholdTokens,label:'Soft'});
    if(finite(latest.hardThresholdTokens)&&latest.hardThresholdTokens>0)sizeThresholds.push({value:latest.hardThresholdTokens,label:'Hard'});
    doc.querySelector('#size').innerHTML=chart(rows,[{key:'rawTokens',label:'Raw history',color:colors[0]},{key:'effectiveTokens',label:'Effective projection',color:colors[1]}],{markers,thresholds:sizeThresholds,selected:selectedTurn});
    doc.querySelector('#composition').innerHTML=chart(rows,[{key:'hotTokens',label:'Hot',color:colors[0]},{key:'warmTokens',label:'Warm resident capsules',color:colors[2]},{key:'checkpointTokens',label:'Checkpoint',color:colors[3]},{key:'otherTokens',label:'Other/unmanaged',color:colors[1]}],{stacked:true,markers,selected:selectedTurn});
    const ratioValueText=finite(latest.warmSourceTokens)&&latest.warmCapsuleTokens>0?`${(latest.warmSourceTokens/latest.warmCapsuleTokens).toFixed(1)}×`:latest.warmSourceTokens===0?'—':'∞';
    doc.querySelector('#warm-stats').innerHTML=[['Warm source coverage',format(latest.warmSourceTokens)],['Resident capsule tokens',format(latest.warmCapsuleTokens)],['Warm tokens saved',format(latest.warmTokensSaved??latest.capsuleTokensSaved)],['Warm compression ratio',ratioValueText],['Eligible historical coverage',format(latest.eligibleHistoricalTokens)]].map(([label,value])=>`<div class="metric"><small>${escape(label)}</small><strong>${escape(value)}</strong></div>`).join('');
    const stateGrowth=rows.filter(row=>row.turn>0&&finite(row.stateBytes));
    const growth=stateGrowth.length>1?(stateGrowth.at(-1).stateBytes-stateGrowth[0].stateBytes)/(stateGrowth.at(-1).turn-stateGrowth[0].turn):null;
    doc.querySelector('#memory-stats').innerHTML=`<span>Current <b>${finite(latest.stateBytes)?short(latest.stateBytes)+' B':'—'}</b></span><span>Limit <b>${short(stateLimit)} B</b></span><span>Usage <b>${statePct===null?'—':ratio(statePct)}</b></span><span>Observed average trend <b>${finite(growth)?`${growth>=0?'+':''}${Math.round(growth)} B/turn`:'—'}</b></span>`;
    doc.querySelector('#memory').innerHTML=chart(rows,[{key:'stateBytes',label:'Working state bytes',color:colors[0]}],{bytes:true,height:165,thresholds:[{value:stateLimit,label:'Hard limit'}],selected:selectedTurn});
    doc.querySelector('#cache-stats').innerHTML=`<div class="metric"><small>Measured cache reuse</small><strong>${ratio(lastRatio)}</strong><small>cacheRead / (cacheRead + uncached input)</small></div><div class="metric"><small>Latest uncached input</small><strong>${format(latest.uncachedInput??latest.input)}</strong></div><div class="metric"><small>Latest cacheRead / cacheWrite</small><strong>${format(latest.cacheRead)} / ${format(latest.cacheWrite)}</strong></div><div class="metric"><small>Attribution</small><strong>Provider usage is measured on its request turn; warm impact is estimated on the next request.</strong></div>`;
    doc.querySelector('#cache').innerHTML=chart(rows,[{key:'cacheRead',label:'cacheRead',color:colors[1]},{key:'uncachedInput',label:'Uncached input',color:colors[0]}],{markers,selected:selectedTurn});
    const events=[];
    for(const row of rows){
      if(row.turn===0)continue;
      if(row.capsulesCreated>0)events.push({turn:row.turn,kind:'warm',title:'HOT → WARM',detail:`${row.capsulesCreated} capsule(s) · source ${format(row.warmEventSourceTokens)} → capsules ${format(row.warmEventCapsuleTokens)} · ${format(row.warmEventTokensSaved??row.capsuleTokensSaved)} context tokens saved · estimated affected suffix ${format(row.estimatedInvalidatedSuffixTokens)} tokens`});
      if(row.checkpointCreated)events.push({turn:row.turn,kind:'checkpoint',title:'ROLLING CHECKPOINT',detail:`${escape(row.checkpointReason??'epoch transition')} · epoch ${row.epoch??'—'} · ${format(row.projectedTokens)} → ${format(row.effectiveTokens)} effective tokens`});
      else if(row.checkpointWanted&&(row.checkpointBlockedBy||[]).length)events.push({turn:row.turn,kind:'blocked',title:'CHECKPOINT BLOCKED',detail:`${(row.checkpointBlockedBy||[]).join(', ')} · protected ${format(row.protectedTokens)} tokens · eligible history ${format(row.eligibleHistoricalTokens)} tokens`});
      const previous=rowAt(rows,row.turn-1);
      if(previous?.capsulesCreated>0&&finite(row.cacheReuseRatio)){
        const oldRatio=previous.cacheReuseRatio,delta=finite(row.uncachedInput)&&finite(previous.uncachedInput)?row.uncachedInput-previous.uncachedInput:null;
        const next=rowAt(rows,row.turn+1);const recovered=finite(next?.cacheReuseRatio)&&finite(oldRatio)&&next.cacheReuseRatio>=oldRatio-.03?` · cache reuse recovered by turn ${next.turn}`:'';
        events.push({turn:row.turn,kind:'cache',title:'NEXT REQUEST · CACHE REBUILD',detail:`Measured on following request turn ${row.turn}: reuse ${ratio(oldRatio)} → ${ratio(row.cacheReuseRatio)} · uncached input ${delta===null?'—':`${delta>=0?'+':''}${format(delta)}`} · associated with warm event turn ${previous.turn}; association is not exact provider attribution${recovered}`});
      }
    }
    for(const compact of compactions)if(!compact.rolling&&finite(compact.turn))events.push({turn:compact.turn,kind:'foreign',title:'FOREIGN / NATIVE COMPACT',detail:`Host compaction · does not increment Rolling epoch${compact.reason?` · ${escape(compact.reason)}`:''}`});
    events.sort((a,b)=>a.turn-b.turn||(a.kind==='warm'?-1:1));
    doc.querySelector('#event-log').innerHTML=events.length?events.slice(-120).reverse().map(event=>`<button class="event event-${event.kind}${event.turn===selectedTurn?' selected':''}" data-turn="${event.turn}"><b>Turn ${event.turn} · ${escape(event.title)}</b><span>${event.detail}</span><small>Event boundary: after turn ${event.turn}, before request ${event.turn+1}</small></button>`).join(''):'<p class="empty">No Rolling Context events recorded on this branch.</p>';
    const detailKeys=['epoch','rawTokens','effectiveTokens','targetTokens','hotTokens','warmTokens','checkpointTokens','otherTokens','warmSourceTokens','warmCapsuleTokens','warmTokensSaved','eligibleHistoricalTokens','stateBytes','stateLimitBytes','input','uncachedInput','cacheRead','cacheWrite','cacheReuseRatio','checkpointWanted','checkpointCandidate','checkpointCreated','checkpointReason','protectedTokens','checkpointBoundaryEntryId','checkpointKeptTokens','checkpointEstimatedTokens','checkpointPreviewTokens','earliestMutationPosition','earliestMutationEntryId','projectedTokensBeforeMutation','estimatedInvalidatedSuffixTokens'];
    doc.querySelector('#all-turns').innerHTML=`<div class="table-scroll"><table><thead><tr><th>Turn</th>${detailKeys.map(key=>`<th>${escape(key)}</th>`).join('')}<th>checkpointBlockedBy</th></tr></thead><tbody>${rows.map(row=>`<tr data-turn="${row.turn}" tabindex="0"><th>${row.turn===0&&row.gap?'0 · unknown':row.turn}</th>${detailKeys.map(key=>`<td>${escape(row[key]??'—')}</td>`).join('')}<td>${escape((row.checkpointBlockedBy||[]).join(', ')||'—')}</td></tr>`).join('')}</tbody></table></div>`;
    const eventForTurn=events.filter(event=>event.turn===selectedTurn);
    const composition=['hotTokens','warmTokens','checkpointTokens','otherTokens'].map(key=>`${key}: ${format(selected[key])}`).join(' · ');
    const selectedBlocked=selected.checkpointBlockedBy||[];
    doc.querySelector('#inspector').innerHTML=`<div class="inspector-head"><small>Shared selection</small><h2>Turn ${selectedTurn===0&&selected.gap?'0 · unknown/gap':selectedTurn}</h2></div><dl>${[
      ['Epoch',selected.epoch],['Raw / effective / target',`${format(selected.rawTokens)} / ${format(selected.effectiveTokens)} / ${format(selected.targetTokens)}`],['Composition',composition],['Warm source / capsule / saved',`${format(selected.warmSourceTokens)} / ${format(selected.warmCapsuleTokens)} / ${format(selected.warmTokensSaved)}`],['Eligible historical tokens',format(selected.eligibleHistoricalTokens)],['State bytes',`${format(selected.stateBytes)} / ${format(selected.stateLimitBytes)}`],['Provider usage',`uncached ${format(selected.uncachedInput??selected.input)} · cacheRead ${format(selected.cacheRead)} · cacheWrite ${format(selected.cacheWrite)} · reuse ${ratio(selected.cacheReuseRatio)}`],['Warm mutation',`${selected.earliestMutationEntryId??'—'} at ${selected.earliestMutationPosition??'—'} · suffix estimate ${format(selected.estimatedInvalidatedSuffixTokens)}`],['Checkpoint wanted / candidate',`${selected.checkpointWanted?'yes':'no'} / ${selected.checkpointCandidate?'yes':'no'}`],['Checkpoint boundary / candidate cost',`${selected.checkpointBoundaryEntryId??'—'} · kept ${format(selected.checkpointKeptTokens)} + summary → ${format(selected.checkpointEstimatedTokens)} · preview ${format(selected.checkpointPreviewTokens)}`],['Blocked reasons',selectedBlocked.join(', ')||'—']
    ].map(([label,value])=>`<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`).join('')}</dl><h3>Events at turn ${selectedTurn}</h3>${eventForTurn.map(event=>`<p><b>${escape(event.title)}</b><br>${event.detail}</p>`).join('')||'<p>No event.</p>'}`;
    doc.querySelector('#status').textContent=`${status} · ${statusNote} · ${rows.filter(row=>row.turn>0).length} completed turns · Turn 0 ${data.turnZero==='measured'?'measured':'unknown/gap'} · ${compactions.filter(compaction=>compaction.rolling).length} RC epochs recorded`;
    const view=doc.querySelector('#event-view'),all=doc.querySelector('#all-view');if(view)view.hidden=detailsMode!=='events';if(all)all.hidden=detailsMode!=='all';
    const toggle=doc.querySelector('#details-toggle');if(toggle)toggle.textContent=detailsMode==='events'?'Events':'All turns';
    if(doc.querySelectorAll)for(const node of doc.querySelectorAll('[data-turn]')){
      node.onclick=()=>render(doc,data,Number(node.getAttribute('data-turn')));
      node.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();render(doc,data,Number(node.getAttribute('data-turn')));}};
    }
  }
  function bind(doc){const toggle=doc.querySelector('#details-toggle');if(toggle)toggle.onclick=()=>{detailsMode=detailsMode==='events'?'all':'events';if(root.PiContextGraphData)render(doc,root.PiContextGraphData);};}
  const api={chart,render,bind};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PiContextGraph=api;
})(typeof globalThis!=='undefined'?globalThis:this);
