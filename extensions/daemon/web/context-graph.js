(function(root){
  'use strict';
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  const colors=['#8370b7','#369c94','#bf8b35','#bc527d'];
  const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function chart(rows,series,{stacked=false,bytes=false,checkpoints=[]}={}){
    const w=1040,h=290,left=72,right=18,top=18,bottom=38;
    const lo=Math.min(...rows.map(r=>r.turn),1),hi=Math.max(lo+1,...rows.map(r=>r.turn));
    const max=Math.max(1,...rows.map(r=>stacked?series.reduce((n,s)=>n+(finite(r[s.key])?r[s.key]:0),0):Math.max(0,...series.map(s=>finite(r[s.key])?r[s.key]:0))));
    const x=n=>left+(n-lo)/(hi-lo)*(w-left-right),y=n=>h-bottom-n/max*(h-top-bottom);
    let svg=`<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${escape(series.map(s=>s.label).join(', '))} over completed turns">`;
    for(let i=0;i<=4;i++){const n=max*i/4;svg+=`<line class="grid" x1="${left}" y1="${y(n)}" x2="${w-right}" y2="${y(n)}"/><text x="${left-8}" y="${y(n)+4}" text-anchor="end">${bytes?(n/1024).toFixed(1)+' KiB':Math.round(n).toLocaleString()}</text>`;}
    for(let i=0;i<=4;i++){const n=lo+(hi-lo)*i/4;svg+=`<text x="${x(n)}" y="${h-12}" text-anchor="middle">${Math.round(n)}</text>`;}
    svg+=`<text x="${w-right}" y="${h-12}" text-anchor="end">turn</text>`;
    series.forEach((s,index)=>{
      let runs=[],run=[];
      rows.forEach(r=>{if(!finite(r[s.key])||(stacked&&series.some(s=>!finite(r[s.key])))){if(run.length)runs.push(run);run=[];return;}const base=stacked?series.slice(0,index).reduce((n,s)=>n+r[s.key],0):0;run.push({x:x(r.turn),y:y(base+r[s.key]),base:y(base),turn:r.turn,value:r[s.key]});});if(run.length)runs.push(run);
      for(const points of runs){if(stacked){const polygon=[...points.map(p=>`${p.x},${p.y}`),...points.slice().reverse().map(p=>`${p.x},${p.base}`)].join(' ');svg+=`<polygon points="${polygon}" fill="${s.color}" opacity=".65"/>`;}
        svg+=`<polyline points="${points.map(p=>`${p.x},${p.y}`).join(' ')}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
        for(const p of points)svg+=`<circle cx="${p.x}" cy="${p.y}" r="2.5" fill="${s.color}"><title>turn ${p.turn}: ${escape(s.label)} ${p.value}</title></circle>`;
      }
    });
    const marks=[...rows.filter(r=>r.capsulesCreated>0).map(r=>({turn:r.turn,warm:true})),...checkpoints.filter(c=>c.rolling&&finite(c.turn)),...rows.filter(r=>r.checkpointCreated).map(r=>({turn:r.turn}))];
    for(const m of marks)svg+=`<line class="${m.warm?'warm-event':'checkpoint-event'}" x1="${x(m.turn)}" x2="${x(m.turn)}" y1="${top}" y2="${h-bottom}"><title>turn ${m.turn}: ${m.warm?'hot→warm':'checkpoint'}</title></line>`;
    return svg+'</svg><div class="legend">'+series.map(s=>`<span style="--color:${s.color}">${escape(s.label)}</span>`).join('')+'</div>';
  }
  function render(doc,data){
    const rows=data.turns||[],spec=(key,label,color)=>({key,label,color});
    doc.querySelector('#size').innerHTML=chart(rows,[spec('rawTokens','Raw history',colors[0]),spec('effectiveTokens','Effective projection',colors[1])],{checkpoints:data.checkpoints});
    doc.querySelector('#composition').innerHTML=chart(rows,[spec('hotTokens','Hot',colors[0]),spec('warmTokens','Warm',colors[2]),spec('checkpointTokens','Checkpoint',colors[3]),spec('otherTokens','Other/unmanaged',colors[1])],{stacked:true});
    doc.querySelector('#memory').innerHTML=chart(rows,[spec('stateBytes','State bytes',colors[0])],{bytes:true});
    const keys=['turn','epoch','afterWarmTokens','afterCheckpointTokens','capsulesCreated','capsuleTokensSaved','checkpointReason','stateBytes','cacheRead','cacheWrite','input'];
    doc.querySelector('#details').innerHTML='<table><thead><tr>'+keys.map(k=>'<th>'+k+'</th>').join('')+'</tr></thead><tbody>'+rows.slice(-100).map(r=>'<tr>'+keys.map(k=>'<td>'+escape(r[k]??'—')+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
  }
  const api={chart,render};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PiContextGraph=api;
})(typeof globalThis!=='undefined'?globalThis:this);
