import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { localControlUrl } from './client.mjs';
import { DomainError } from './store.mjs';
import { obsidianCapabilities } from './obsidian-capabilities.mjs';

const id=z.string().min(1).max(160);
const token=z.string().regex(/^[A-Za-z0-9_-]{32,200}$/);
const fault=(code,message,details)=>new DomainError(code,message,details);
// Refused before anything reached the vault: a job reports this as not started rather than as an unknown outcome.
const unstarted=(code,message,details)=>Object.assign(fault(code,message,details),{notStarted:true});
const sameSecret=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const pathKey=value=>{const full=fs.realpathSync.native(value);return process.platform==='win32'?full.toLowerCase():full;};
const maxRecordBytes=12*1024*1024;
// A rollback record can hold a whole note, so both kinds are bounded by count and by age.
const RECORD_LIMITS=Object.freeze({operation:500,plan:200});
const PROBE_TIMEOUT_MS=1500;
const SWEEP_INTERVAL_MS=30000;
// A mutation must begin this long before the runtime stops waiting for it.
const START_MARGIN_MS=2000;
const networkCode=error=>error?.cause?.code||error?.code;
const refused=error=>networkCode(error)==='ECONNREFUSED';
const dropped=error=>['ECONNRESET','EPIPE','UND_ERR_SOCKET'].includes(networkCode(error));
const rejected=response=>response.status===401||response.status===403;
const operationSummary="'id',record_id,'action',json_extract(payload,'$.action'),'status',json_extract(payload,'$.status'),'path',json_extract(payload,'$.path'),'destination',json_extract(payload,'$.destination'),'batchPlanId',json_extract(payload,'$.batchPlanId'),'createdAt',json_extract(payload,'$.createdAt'),'rolledBackAt',json_extract(payload,'$.rolledBackAt')";
const tools=Object.freeze(obsidianCapabilities.map(item=>Object.freeze({name:item.name,engine:'obsidian',description:item.description,schema:item.schema,
  annotations:item.annotations,readOnly:item.annotations.readOnlyHint===true,readOnlyWhen:null,ownerOnly:false,longRunning:(item.timeoutMs||0)>=60000})));

export function createHostRegistry({service,instanceRoot,fetchImpl=globalThis.fetch,sweepIntervalMs=SWEEP_INTERVAL_MS,
  requestTimeoutMs=definition=>definition.timeoutMs||30000}={}) {
  if(!service?.store?.db||!instanceRoot)throw new TypeError('Host registry requires an explicit service and instance.');
  const db=service.store.db,hosts=new Map(),operations=[];
  let closed=false;
  db.exec('CREATE TABLE IF NOT EXISTS host_records (project_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE, kind TEXT NOT NULL, record_id TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(project_id,kind,record_id));');
  const add=(name,shape,readOnly,description,run)=>operations.push({name,schema:z.object(shape).strict(),localOnly:true,readOnly,description,run});
  const ensure=()=>{if(closed)throw fault('runtime_stopping','Host registry is closing.');};
  const publicHost=host=>({id:host.id,projectId:host.projectId,kind:'obsidian',connectedAt:host.connectedAt,reachable:host.reachable,lastSeenAt:host.lastSeenAt});
  const hostFor=projectId=>[...hosts.values()].find(host=>host.projectId===projectId);
  const owned=args=>{
    const host=hosts.get(args.hostId);
    if(!host||host.projectId!==args.projectId||!sameSecret(args.hostToken,host.token))throw fault('forbidden','Host registration does not match this project.');
    service.project(args.projectId);return host;
  };
  function forget(host,reason){
    if(hosts.get(host.id)!==host)return;
    host.abort.abort(new Error('Host detached.'));hosts.delete(host.id);
    try{service.store.event('host.detached',{id:host.projectId,projectId:host.projectId},{hostId:host.id,reason});}catch{}
  }
  // One request to the host listener. Network failures are thrown as they are, for the caller to classify.
  async function send(host,body,{timeoutMs,signal}={}){
    const response=await fetchImpl(new URL('/api/call',host.url),{method:'POST',redirect:'error',
      signal:AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]),
      headers:{Authorization:'Bearer '+host.token,Origin:host.url,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const chunks=[];let bytes=0;
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>8*1024*1024)throw fault('response_too_large','Host response exceeds 8 MiB.');chunks.push(Buffer.from(chunk));}
    let payload;
    try{payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{payload=null;}
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw fault('host_invalid_response','The vault host answered with something that is not a JSON object (HTTP '+response.status+').');
    host.reachable=true;host.lastSeenAt=new Date().toISOString();
    return{response,payload};
  }
  // alive: it answers. gone: nothing listens at its address, or what listens does not know our token. silent: no answer in time.
  async function probe(host){
    let state;
    try{
      const {response,payload}=await send(host,{operation:'host.ping',input:{}},{timeoutMs:PROBE_TIMEOUT_MS});
      state=rejected(response)?'gone':response.ok&&payload.ok===true?'alive':'silent';
    }catch(error){state=refused(error)||dropped(error)?'gone':'silent';}
    host.reachable=state==='alive';
    return state;
  }
  const gone=async(host,error)=>error?.hostGone===true||refused(error)||(dropped(error)&&await probe(host)==='gone');
  const sweep=setInterval(()=>{
    for(const host of hosts.values())if(!host.closing&&!host.pending.size)void probe(host).then(state=>{if(state==='gone')forget(host,'unreachable');},()=>{});
  },sweepIntervalMs);
  sweep.unref?.();

  const binding={projectId:id,hostId:id,hostToken:token,kind:z.enum(['operation','plan'])};
  add('host.attach',{projectId:id,hostId:id,root:z.string().min(1),url:z.string().min(1),token},false,'Attach an explicit local Obsidian vault to its registered project. A host that no longer answers is replaced.',async args=>{
    ensure();const project=service.project(args.projectId),url=localControlUrl(args.url);
    if(!path.isAbsolute(args.root)||pathKey(args.root)!==pathKey(project.root))throw fault('scope_mismatch','Vault root must match the selected project.');
    const same=host=>host.id===args.hostId&&sameSecret(host.token,args.token)&&host.url===url;
    let existing=hostFor(args.projectId);
    if(existing&&!same(existing)){
      if(await probe(existing)!=='gone')throw fault('host_attached','This project already has an attached host that still answers. Detach it first with host.detach, or with host.detach {force:true} when it is stuck.');
      forget(existing,'replaced');existing=hostFor(args.projectId);
    }
    if(existing){
      if(same(existing))return publicHost(existing);
      throw fault('host_attached','Another host attached to this project meanwhile.');
    }
    if(hosts.has(args.hostId))throw fault('scope_mismatch','Host ID already belongs to another project.');
    const host={id:args.hostId,projectId:args.projectId,url,token:args.token,root:pathKey(project.root),connectedAt:new Date().toISOString(),
      abort:new AbortController(),pending:new Set(),reachable:true,lastSeenAt:new Date().toISOString()};
    hosts.set(host.id,host);return publicHost(host);
  });
  add('host.detach',{hostId:id,force:z.boolean().optional()},false,'Detach a host without stopping the shared runtime. force:true drops the registration without waiting for a host that is stuck.',async args=>{
    const host=hosts.get(args.hostId);if(!host)return{detached:false};
    if(args.force){forget(host,'forced');return{detached:true,forced:true};}
    await drainHost(host);return{detached:true};
  });
  add('host.list',{projectId:id.optional()},true,'List connected local hosts and whether each still answers, without connection credentials.',async args=>{
    const selected=[...hosts.values()].filter(host=>!args.projectId||host.projectId===args.projectId);
    const states=await Promise.all(selected.map(host=>host.closing?'closing':probe(host)));
    selected.forEach((host,index)=>{if(states[index]==='gone')forget(host,'unreachable');});
    return{items:selected.filter((_host,index)=>states[index]!=='gone').map(publicHost)};
  });
  add('host.record.get',{...binding,recordId:id},true,'Read a private vault rollback or batch record for the attached host.',args=>{
    owned(args);const row=db.prepare('SELECT payload FROM host_records WHERE project_id=? AND kind=? AND record_id=?').get(args.projectId,args.kind,args.recordId);
    if(!row)throw fault('not_found','Vault '+args.kind+' record was not found: '+args.recordId+'. Records are kept for the newest '+RECORD_LIMITS[args.kind]+' entries.');return JSON.parse(row.payload);
  });
  add('host.record.put',{...binding,record:z.record(z.string(),z.unknown())},false,'Persist a private vault rollback or batch record in the instance database.',args=>{
    owned(args);
    if(service.store.get('project',args.projectId).access!=='write')throw fault('read_only','Project is read-only.');
    const recordId=id.parse(args.record.id),payload=JSON.stringify(args.record);
    if(Buffer.byteLength(payload)>maxRecordBytes)throw fault('record_too_large','Vault record exceeds 12 MiB.');
    const known=db.prepare('SELECT 1 FROM host_records WHERE project_id=? AND kind=? AND record_id=?').get(args.projectId,args.kind,recordId);
    db.prepare('INSERT INTO host_records(project_id,kind,record_id,updated_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(project_id,kind,record_id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload')
      .run(args.projectId,args.kind,recordId,new Date().toISOString(),payload);
    if(!known)prune(args.projectId,args.kind);
    return{id:recordId,saved:true};
  });
  add('host.record.list',{...binding,limit:z.number().int().min(1).max(500).default(50)},true,'Read bounded recent private vault records.',args=>{
    owned(args);
    const fields=args.kind==='operation'?operationSummary
      : "'id',record_id,'kind',json_extract(payload,'$.kind'),'status',json_extract(payload,'$.status'),'files',json_array_length(payload,'$.items'),'createdAt',json_extract(payload,'$.createdAt'),'expiresAt',json_extract(payload,'$.expiresAt'),'appliedAt',json_extract(payload,'$.appliedAt'),'rolledBackAt',json_extract(payload,'$.rolledBackAt'),'operationIds',json_extract(payload,'$.operationIds'),'error',json_extract(payload,'$.error')";
    return{items:db.prepare('SELECT json_object('+fields+') AS summary FROM host_records WHERE project_id=? AND kind=? ORDER BY updated_at DESC,record_id DESC LIMIT ?')
      .all(args.projectId,args.kind,args.limit).map(row=>JSON.parse(row.summary))};
  });
  // Keep the newest records of a project and nothing older than the instance retention.
  function prune(projectId,kind){
    const cutoff=new Date(Date.now()-(service.config?.retentionDays||30)*86400000).toISOString();
    db.prepare('DELETE FROM host_records WHERE project_id=? AND kind=? AND (updated_at<? OR record_id IN (SELECT record_id FROM host_records WHERE project_id=? AND kind=? ORDER BY updated_at DESC,record_id DESC LIMIT -1 OFFSET ?))')
      .run(projectId,kind,cutoff,projectId,kind,RECORD_LIMITS[kind]);
  }

  function list({projectId}={}) {
    ensure();service.project(projectId);
    const host=hostFor(projectId);
    return{items:host?tools:[],hosts:host?[publicHost(host)]:[]};
  }
  // What became of one operation: the durable journal entry of a note mutation, and what the host still remembers of the request.
  async function operationOutcome(projectId,operationId,host){
    const row=db.prepare('SELECT json_object('+operationSummary+") AS summary FROM host_records WHERE project_id=? AND kind='operation' AND record_id=?").get(projectId,operationId);
    const journal=row?JSON.parse(row.summary):null;
    let request=null;
    if(host&&!host.closing)try{
      const {response,payload}=await send(host,{operation:'host.outcome',input:{operationId}},{timeoutMs:5000});
      if(response.ok&&payload.ok===true&&payload.result?.status!=='unknown')request=payload.result;
    }catch{}
    const [outcome,guidance]=journal?.status==='rolled_back'?['rolled_back','The change was applied and then rolled back.']
      : journal?.status==='applied'||request?.status==='completed'?['applied','The operation completed. Do not repeat it.']
      : ['queued','running'].includes(request?.status)?['in_progress','Obsidian is still working on it. Ask again before retrying.']
      : ['cancelled','expired'].includes(request?.status)?['not_applied','It was withdrawn before it started; nothing changed. It can be repeated.']
      : request?.status==='failed'?['failed','It failed on the host: '+(request.error||'unknown error')+'.']
      : journal?.status==='prepared'?['interrupted','The change was journaled but never confirmed. Inspect the note; obsidian.operation_rollback restores the saved state.']
      : ['not_recorded','No note change is journaled under this id, so no single-note change was applied. For a batch, read obsidian.properties_batch_list.'];
    return{operationId,outcome,guidance,operation:journal,request};
  }
  async function call({projectId,capability,input={}},{callerRole,signal}={}) {
    ensure();
    const definition=obsidianCapabilities.find(item=>item.name===capability);
    if(!definition)throw unstarted('unknown_capability','Unknown Obsidian capability: '+capability+'. capability.list {engine:"obsidian"} shows them.');
    const write=!definition.annotations.readOnlyHint;
    if(!['owner','write','read'].includes(callerRole))throw unstarted('forbidden','A verified caller role is required.');
    if(callerRole==='read'&&write)throw unstarted('forbidden','This Obsidian operation requires write access.');
    const project=service.project(projectId,{write});
    let args;
    try{args=definition.schema.parse(input);}
    catch(error){throw error?.name==='ZodError'?unstarted('invalid_input','Invalid input for '+capability+': '+error.issues.slice(0,8).map(issue=>(issue.path.length?issue.path.join('.')+': ':'')+issue.message).join('; ')):error;}
    const host=hostFor(projectId);
    if(definition.action==='operation_list'&&args.operationId)return operationOutcome(projectId,args.operationId,host);
    if(host?.closing)throw unstarted('host_closing','This project host is closing.');
    if(!host)throw unstarted('host_unavailable','No Obsidian vault is attached to this project. Open the vault in Obsidian with the DevMate plugin enabled; it attaches by itself while the runtime runs.');
    if(pathKey(project.root)!==host.root)throw unstarted('scope_mismatch','Attached vault root no longer matches the project.');
    const timeoutMs=requestTimeoutMs(definition),operationId='operation-'+randomUUID(),seconds=Math.round(timeoutMs/100)/10;
    const unreachable=()=>{
      forget(host,'unreachable');
      return fault('host_unavailable','Obsidian is no longer reachable (it was closed or the DevMate plugin was unloaded), so the vault was detached. It attaches again by itself when the vault is open.'+
        (write?' Whether '+capability+' was applied is not confirmed: read obsidian.operation_list {operationId:"'+operationId+'"} once the vault is attached again.':''),write?{operationId}:undefined);
    };
    const work=(async()=>{
      let reply;
      try{
        reply=await send(host,{operation:definition.action,input:args,operationId,deadline:Date.now()+timeoutMs-Math.min(START_MARGIN_MS,timeoutMs/4)},
          {timeoutMs,signal:AbortSignal.any([host.abort.signal,...(signal?[signal]:[])])});
      }catch(error){
        if(error instanceof DomainError)throw error;
        if(await gone(host,error))throw unreachable();
        const timedOut=error?.name==='TimeoutError';
        if(!timedOut&&error?.name!=='AbortError'&&!signal?.aborted&&!host.abort.signal.aborted)throw error;
        if(timedOut)host.reachable=false;
        const what=timedOut?'within '+seconds+' s':'before the request was cancelled';
        if(!write)throw fault(timedOut?'host_timeout':'cancelled','Obsidian did not answer '+capability+' '+what+'. The vault may be busy; narrow the request or try again.');
        // A mutation: ask the host what became of it, and withdraw it if it has not started.
        let status='unknown';
        if(hosts.get(host.id)===host)try{
          const {payload}=await send(host,{operation:'host.cancel',input:{operationId}},{timeoutMs:3000});
          if(payload.ok===true)status=payload.result?.status||'unknown';
        }catch{}
        if(['cancelled','expired'].includes(status))throw unstarted(timedOut?'host_timeout':'cancelled','Obsidian did not start '+capability+' '+what+' and it was withdrawn: nothing in the vault changed. Try again when the vault is idle.',{operationId,applied:false});
        throw fault('outcome_unknown','Obsidian did not confirm '+capability+' '+what+' (the host reports it as '+status+'). It may still be applied. Before retrying, read its outcome with obsidian.operation_list {operationId:"'+operationId+'"}.',{operationId,status});
      }
      const {response,payload}=reply;
      if(rejected(response))throw unreachable();
      if(!response.ok||payload.ok!==true)throw fault(payload.error?.code||'host_failed',payload.error?.message||'Obsidian host operation failed.');
      return definition.action==='status'?{...payload.result,host:publicHost(host)}:payload.result;
    })();host.pending.add(work);
    try{return await work;}finally{host.pending.delete(work);}
  }
  function drainHost(host){
    if(host.drainPromise)return host.drainPromise;
    const work=drain(host);host.drainPromise=work;
    void work.catch(()=>{if(host.drainPromise===work)host.drainPromise=null;});return work;
  }
  async function drain(host){
    host.closing=true;
    const request=async(operation,timeoutMs)=>{
      const {response,payload}=await send(host,{operation,input:{}},{timeoutMs});
      if(rejected(response))throw Object.assign(fault('host_unavailable','The listener at the host address no longer accepts this registration.'),{hostGone:true});
      if(!response.ok||payload.ok!==true)throw fault('host_drain_failed','Host did not confirm its cleanup.');
      return payload.result;
    };
    try{
      if(!host.drained){
        if((await request('host.drain',120000))?.drained!==true)throw fault('host_drain_failed','Host did not confirm that its vault operations stopped.');
        host.drained=true;
      }
      await Promise.allSettled([...host.pending]);
      if((await request('host.release',5000))?.released!==true)throw fault('host_release_failed','Host listener release was not confirmed.');
    }catch(error){
      // Nothing listens at this address any more: the host process or its listener is
      // gone (or a release acknowledgement was lost), so nothing is left to drain.
      if(!await gone(host,error)){
        if(!host.drained)host.closing=false;
        throw error;
      }
    }
    forget(host,'detached');
  }
  async function closeProject(projectId) {
    for(const host of [...hosts.values()].filter(value=>value.projectId===projectId))await drainHost(host);
  }
  let closePromise;
  function close(){
    if(closePromise)return closePromise;
    closed=true;clearInterval(sweep);
    // The registry dies with the runtime: a host that cannot confirm its drain is dropped rather than
    // keeping the runtime from stopping. Its mutations journal here first, so none can start afterwards.
    closePromise=Promise.all([...hosts.values()].map(host=>drainHost(host).catch(()=>forget(host,'runtime stopping')))).then(()=>{});
    return closePromise;
  }
  return{operations,list,call,closeProject,close};
}
