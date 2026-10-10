import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { recallProjection, ownedEdits, rebuild, hash } from "./legacy/v1.ts";
import type { ProjectionConfig } from "./projection/types.ts";
const RecallParams=Type.Object({intent:Type.String({minLength:1}),entryId:Type.Optional(Type.String()),itemId:Type.Optional(Type.String()),query:Type.Optional(Type.String({maxLength:300})),offset:Type.Optional(Type.Integer({minimum:0,maximum:100_000_000})),paths:Type.Optional(Type.Array(Type.String({minLength:1,maxLength:256}),{maxItems:12})),cursor:Type.Optional(Type.String({maxLength:2048})),limit:Type.Optional(Type.Number({minimum:1,maximum:8}))},{additionalProperties:false});

/** Authorization uses host/legacy redaction policy, independent of v2 residency. */
export function registerRecall(pi:ExtensionAPI,config:ProjectionConfig) {
  pi.registerTool({name:"context_recall",label:"Context recall",description:"Search or retrieve bounded evidence from the active session branch, including cold sources. For long sources use entryId + offset (nextOffset is returned), or query for matching excerpts. Historical content is not current filesystem truth.",parameters:RecallParams,annotations:{readOnlyHint:true,openWorldHint:false},async execute(_id,params,_signal,_update,ctx){
    const branch=ctx.sessionManager.getBranch();
    const projection=ctx.sessionManager.buildSessionProjection();
    const authorized=recallProjection(ctx.cwd,ctx.sessionManager.getHeader(),branch,projection.entries);
    const ownedSources=ownedEdits(branch);
    const projectedById=new Map(authorized.map(e=>[e.sourceEntry.id,e.messages]));
    const visibleIds=new Set(authorized.filter(e=>e.messages.length>0).map(e=>e.sourceEntry.id));
    const state=rebuild(branch,ctx.sessionManager.getSessionId());
    if(params.paths?.some(path=>path.startsWith("/")||path.includes("\0")||path.split(/[\\/]/).includes("..")))throw new Error("Recall paths must be project-relative and cannot traverse directories");
    const selectors=[params.entryId,params.itemId,params.query].filter(Boolean);if(selectors.length>1)throw new Error("Use only one of entryId, itemId or query; paths may be combined as a filter");
    if(params.offset!==undefined&&(!params.entryId||!Number.isSafeInteger(params.offset)||params.offset<0))throw new Error("Recall offset requires entryId and a nonnegative integer");
    const perEntryChars=Math.max(64,Math.min(1600,config.recallMaxTokens*4-300));
    const limit=Math.min(params.limit??5,Math.max(1,Math.floor(config.recallMaxTokens*4/1800)));const leafId=ctx.sessionManager.getLeafId();
    const projectionHash=hash(authorized.filter(e=>e.messages.length>0).map(e=>[e.sourceEntry.id,e.messages]));
    const queryHash=hash({entryId:params.entryId,itemId:params.itemId,query:params.query?.toLowerCase(),offset:params.offset,paths:params.paths?.map(p=>p.replace(/\\/g,"/")).sort(),limit});
    let start=0;
    if(params.cursor){try{const decoded=JSON.parse(Buffer.from(params.cursor,"base64url").toString("utf8"));if(decoded.v!==1||decoded.sessionId!==ctx.sessionManager.getSessionId()||decoded.leafId!==leafId||decoded.queryHash!==queryHash||decoded.projectionHash!==projectionHash||!Number.isSafeInteger(decoded.start)||decoded.start<0)throw new Error();start=decoded.start;}catch{throw new Error("STALE_RECALL_CURSOR: branch, projection or query changed; start a new recall request");}}
    const callPaths=new Map<string,string>();
    for(const entry of authorized)for(const message of entry.messages)if(message.role==="assistant")for(const part of message.content)if(part.type==="toolCall"&&typeof part.arguments.path==="string")callPaths.set(part.id,part.arguments.path.replace(/\\/g,"/"));
    const candidates=branch.filter(e=>visibleIds.has(e.id)&&(e.type==="message"||e.type==="custom_message"&&e.customType==="design-intent.projection.v1"||e.type==="compaction")&&(!params.entryId||e.id===params.entryId));
    // Branch ownership is checked explicitly before residency-independent authorization.
    // A foreign/missing source never reaches rendering or raw restoration.
    if(params.entryId&&!branch.some(entry=>entry.id===params.entryId))return{content:[{type:"text",text:"Source is not owned by the active session branch; content withheld."}],details:{denied:true,reason:"SOURCE_NOT_OWNED_BY_BRANCH",returned:0}};
    if(params.entryId&&branch.some(entry=>entry.id===params.entryId)&&!visibleIds.has(params.entryId))return{content:[{type:"text",text:`[${params.entryId}] Source is absent from the current authorized branch; content withheld.`}],details:{denied:true,reason:"SOURCE_NOT_AUTHORIZED_IN_BRANCH",returned:0}};
    const contentLengths=new Map<string,number>();
    const render=(entry:SessionEntry,bounded=true):string=>{
      const clip=(value:string)=>{contentLengths.set(entry.id,Math.max(contentLengths.get(entry.id)??0,value.length));return bounded?value.slice(params.entryId?params.offset??0:0,(params.entryId?params.offset??0:0)+perEntryChars):value;};
      const linked=state.snapshot.items.filter(item=>item.sourceEntryIds.includes(entry.id));
      const status=[...new Set(linked.map(item=>item.status).filter(value=>value==="stale"||value==="superseded"))].join(",");
      const prefix=`[${entry.id}; historical evidence${status?`; ${status}`:""}; not current filesystem truth]`;
      if(entry.type==="message"){
        const messages=projectedById.get(entry.id)??[];return messages.map(message=>{
          let effective=message;
          if(message.role==="toolResult"&&(typeof message.content==="string"||Array.isArray(message.content))){
            const effectiveText=typeof message.content==="string"?message.content:message.content.every((part:any)=>part.type==="text")?message.content.map((part:any)=>part.text).join("\n"):undefined;
            const owned=effectiveText!==undefined&&ownedSources.get(entry.id)?.replacementHash===hash(effectiveText);
            if(owned&&entry.message.role==="toolResult")effective=entry.message;
          }
          if(message.role==="user"){const text=typeof message.content==="string"?message.content:message.content.filter((part:any)=>part.type==="text").map((part:any)=>part.text).join("\n");return `${prefix} user: ${clip(text)}${Array.isArray(message.content)&&message.content.some((part:any)=>part.type==="image")?" [image omitted]":""}`;}
          if(effective.role==="assistant")return `${prefix} assistant: ${clip(effective.content.filter((part:any)=>part.type==="text").map((part:any)=>part.text).join("\n"))}${effective.content.some((part:any)=>part.type==="thinking")?" [thinking omitted]":""}`;
          if(effective.role==="toolResult"){const content=typeof effective.content==="string"?effective.content:Array.isArray(effective.content)?effective.content.filter((part:any)=>part.type==="text").map((part:any)=>part.text).join("\n"):"";const callPath=callPaths.get(effective.toolCallId);return `${prefix} toolResult ${effective.toolName}${callPath?` path=${callPath}`:""}: ${clip(content)}${Array.isArray(effective.content)&&effective.content.some((part:any)=>part.type==="image")?" [image omitted]":""}`;}
          return `${prefix} ${effective.role}`;
        }).join("\n");
      }
      if(entry.type==="custom_message")return `${prefix} Design Intent projection: ${clip(typeof entry.content==="string"?entry.content:entry.content.filter((part:any)=>part.type==="text").map((part:any)=>part.text).join("\n"))}`;
      if(entry.type==="compaction")return `${prefix} checkpoint: ${clip(entry.summary)}`;
      return prefix;
    };
    let matches=candidates.map(entry=>({entry,text:render(entry),full:render(entry,false)}));
    if(params.entryId)matches=matches.filter(x=>x.entry.id===params.entryId);
    else if(params.itemId){const item=state.snapshot.items.find(i=>i.id===params.itemId);matches=matches.filter(x=>item?.sourceEntryIds.includes(x.entry.id));}
    else if(params.query){const q=params.query.toLowerCase();matches=matches.filter(x=>x.full.toLowerCase().includes(q)).map(x=>{
      const start=Math.max(0,x.full.toLowerCase().indexOf(q)-200),end=Math.min(x.full.length,start+perEntryChars);
      return {...x,text:`${x.full.match(/^\[[^\]]+\]/)?.[0]??`[${x.entry.id}]`}\n[matching excerpt ${start}:${end}]\n${x.full.slice(start,end)}`};
    });}
    if(params.paths?.length){matches=matches.filter(({entry,text})=>{
      const linked=state.snapshot.items.filter(item=>item.sourceEntryIds.includes(entry.id)).flatMap(item=>item.dependencies.map(dep=>dep.path.replace(/\\/g,"/")));
      if(entry.type==="message"&&entry.message.role==="toolResult"){const path=callPaths.get(entry.message.toolCallId);if(path)linked.push(path);const changes=(entry.message.details as any)?.changes;if(Array.isArray(changes))for(const change of changes)if(typeof change?.path==="string")linked.push(change.path.replace(/\\/g,"/"));}
      return params.paths!.some(requested=>{const path=requested.replace(/\\/g,"/");return linked.some(actual=>actual===path||actual.startsWith(`${path.replace(/\/$/,"")}/`)||path.startsWith(`${actual.replace(/\/$/,"")}/`))||text.includes(path);});
    });}
    const page=matches.slice(start,start+limit);
    let text=page.map(x=>x.text).join("\n\n");
    const truncated=text.length>config.recallMaxTokens*4;if(truncated)text=`${text.slice(0,config.recallMaxTokens*4)}\n[Recall response truncated; narrow the query or request fewer entries.]`;
    if(page.length)pi.appendEntry("rolling-context.recall-use.v2",{sourceIds:page.map(x=>x.entry.id)});
    const cursorLeaf=ctx.sessionManager.getLeafId();
    const next=start+page.length<matches.length?Buffer.from(JSON.stringify({v:1,sessionId:ctx.sessionManager.getSessionId(),leafId,queryHash,projectionHash,leafId:cursorLeaf,start:start+page.length})).toString("base64url"):undefined;
    const offset=params.offset??0,length=params.entryId?contentLengths.get(params.entryId)??0:0;
    const nextOffset=params.entryId&&offset+perEntryChars<length?offset+perEntryChars:undefined;
    return {content:[{type:"text",text:text||"No matching authorized evidence in the active branch."}],details:{nextCursor:next,nextOffset,totalMatches:matches.length,returned:page.length,truncated:truncated||nextOffset!==undefined,sourceStatuses:page.map(x=>({entryId:x.entry.id,stale:state.snapshot.items.some(item=>item.sourceEntryIds.includes(x.entry.id)&&item.status==="stale")}))}};
  }});
}
