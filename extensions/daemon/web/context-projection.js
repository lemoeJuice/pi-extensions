(function(root){
  'use strict';
  const escape=v=>String(v??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const format=v=>typeof v==='number'?Math.round(v).toLocaleString():'—';
  let doc,sessionId,requestId,mode='rendered',data;
  function body(message){
    if(!message)return '';
    const parts=typeof message.content==='string'?[{type:'text',text:message.content}]:message.content||[];
    const content=parts.map(p=>p.type==='text'?p.text:p.type==='toolCall'?`Tool call ${p.name} (${p.id})\n${JSON.stringify(p.arguments,null,2)}`:p.type==='thinking'?`[thinking]\n${p.thinking}`:p.type==='image'?'[Image included in model input; binary payload hidden]':`[${p.type}]`).join('\n');
    return message.role==='system'?`${content}\n${message.sections?JSON.stringify(message.sections,null,2):''}\n${message.toolsAdded?'Tools added:\n'+JSON.stringify(message.toolsAdded,null,2):''}\n${message.toolsRemoved?'Tools removed: '+JSON.stringify(message.toolsRemoved):''}`:content;
  }
  function render(target,value){
    const snap=value.snapshot;
    if(!snap){target.innerHTML='<p>No actual request projection is archived for this branch. Legacy sessions retain Graph and recall.</p>';return;}
    const totals=snap.totals;
    let html=`<h2>Projection · Turn ${snap.turn} · Generation ${snap.generation}</h2><p>Request ${escape(snap.requestId)} · ${escape(snap.hook)} · ${value.verified?'All archived message hashes verified':'Some messages are unavailable or authorization has changed'}</p><div class="metric-grid">${[['Raw equivalent',totals.rawTokens],['Projected',totals.projectedTokens],['Reduction',`${Math.round(totals.reduction*100)}%`],['Window',totals.window]].map(([k,v])=>`<div class="metric"><small>${k}</small><strong>${typeof v==='number'?format(v):escape(v)}</strong></div>`).join('')}</div>`;
    if(mode==='mapping'){
      const fields=['sourceId','rawTokens','representation','projectedTokens','saving','reason','desiredRepresentation','representation','age','lastUseTurn','generation'];
      html+=`<div class="table-scroll"><table><thead><tr>${['Source','Raw tokens','Representation','Projected tokens','Saving','Reason','Desired','Committed','Age','Last use','Generation'].map(v=>`<th>${v}</th>`).join('')}</tr></thead><tbody>${value.rows.map(row=>`<tr>${fields.map(f=>`<td>${escape(row[f])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }else{
      html+=value.rows.map((row,index)=>`<article class="projection-message"><h3>${index+1}. [${escape(row.representation)}] ${escape(row.role.toUpperCase())}${row.toolName?' · '+escape(row.toolName):''}</h3><small>source ${escape(row.sourceId)} · original ${format(row.rawTokens)} · projected ${format(row.projectedTokens)} · saved ${format(row.saving)}</small><pre>${escape(row.unavailable||body(row.message))}</pre>${row.sourceEntryId?`<button data-recall-source="${escape(row.sourceEntryId)}">Recall raw</button><pre class="raw-recall" hidden></pre>`:''}</article>`).join('');
    }
    target.innerHTML=html;
    if(target.querySelectorAll)for(const button of target.querySelectorAll('[data-recall-source]'))button.onclick=async()=>{
      const output=button.nextElementSibling;output.hidden=false;output.textContent='Loading authorized source…';
      try{const response=await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/context-projection?sourceId=${encodeURIComponent(button.getAttribute('data-recall-source'))}`);const result=await response.json();if(!response.ok)throw new Error(result.error);output.textContent=result.messages.map(body).join('\n');}catch(error){output.textContent=error.message;}
    };
  }
  async function refresh(){
    if(!doc)return;
    try{
      const response=await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/context-projection${requestId?'?requestId='+encodeURIComponent(requestId):''}`);
      const result=await response.json();if(!response.ok)throw new Error(result.error);data=result;
      const select=doc.querySelector('#projection-request');
      select.innerHTML=result.snapshots.map(s=>`<option value="${escape(s.requestId)}">Turn ${s.turn} · Generation ${s.generation} · ${escape(s.requestId.slice(0,8))}</option>`).reverse().join('');
      select.value=result.snapshot?.requestId||'';
      render(doc.querySelector('#projection-output'),result);
    }catch(error){doc.querySelector('#projection-output').textContent=error.message;}
  }
  async function open(id){requestId=id;doc.querySelector('#graph-panel').hidden=true;doc.querySelector('#projection-panel').hidden=false;await refresh();}
  function bind(document,id){
    doc=document;sessionId=id;
    doc.querySelector('#show-projection').onclick=()=>open();
    doc.querySelector('#show-graph').onclick=()=>{doc.querySelector('#graph-panel').hidden=false;doc.querySelector('#projection-panel').hidden=true;};
    doc.querySelector('#projection-request').onchange=event=>open(event.target.value);
    doc.querySelector('#projection-mode').onchange=event=>{mode=event.target.value;if(data)render(doc.querySelector('#projection-output'),data);};
  }
  const api={bind,open,refresh,render,body};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PiProjectionView=api;
})(typeof globalThis!=='undefined'?globalThis:this);
