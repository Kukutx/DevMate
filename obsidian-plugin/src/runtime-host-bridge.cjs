'use strict';
const http=require('node:http');
const crypto=require('node:crypto');
const {VaultIndex}=require('./bridge/vault-index.js');
const note=require('./bridge/note-actions.js');
const batch=require('./bridge/property-batch.js');
const {BRIDGE_CAPABILITIES,BRIDGE_PROTOCOL_VERSION}=require('./bridge/constants.js');
const {createRuntimeRecordStore}=require('./runtime-record-store.cjs');
const equal=(a,b)=>typeof a==='string'&&a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
const local=address=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
// These only read the index: they answer at once and never wait behind a mutation.
const READS=new Set(['status','query_notes','search_content','graph_notes','schema_audit','audit_vault','properties_batch_list','operation_list']);
const MAX_OUTCOMES=200;
const coded=(code,message)=>Object.assign(new Error(message),{code});
function send(res,status,value){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function createObsidianRuntimeBridge(plugin,{client,projectId,Index=VaultIndex,actions=note,batches=batch,now=Date.now}={}){
  const hostId='obsidian-'+crypto.randomUUID(),token=crypto.randomBytes(32).toString('base64url');
  const root=plugin.app.vault.adapter.getBasePath(),index=new Index(plugin);
  const operationStore=createRuntimeRecordStore({client,projectId,hostId,hostToken:token,kind:'operation'});
  const planStore=createRuntimeRecordStore({client,projectId,hostId,hostToken:token,kind:'plan'});
  let server,url='',accepting=false,drained=false,released=false,queue=Promise.resolve(),stopPromise,queued=0,running=0;
  // What became of each recent request, by the operation id the runtime gave it.
  const outcomes=new Map(),reads=new Set(),metrics=new Map();
  function remember(operationId,operation){
    if(typeof operationId!=='string'||!operationId)return null;
    const entry={operationId,operation,status:'queued',receivedAt:new Date(now()).toISOString(),finishedAt:null,error:null};
    outcomes.set(operationId,entry);
    while(outcomes.size>MAX_OUTCOMES)outcomes.delete(outcomes.keys().next().value);
    return entry;
  }
  const settle=(entry,status,error)=>{if(entry){entry.status=status;entry.finishedAt=new Date(now()).toISOString();entry.error=error||null;}};
  const outcome=operationId=>{const entry=outcomes.get(String(operationId||''));return entry?{...entry}:{status:'unknown'};};
  function measure(operation,startedAt,failed){
    const entry=metrics.get(operation)||{count:0,errors:0,lastMs:0,maxMs:0},elapsed=now()-startedAt;
    entry.count++;if(failed)entry.errors++;entry.lastMs=elapsed;entry.maxMs=Math.max(entry.maxMs,elapsed);metrics.set(operation,entry);
  }
  async function action(operation,input,metadata){
    switch(operation){
      case 'status':return{available:true,hostId,projectId,vault:plugin.app.vault.getName(),root,protocolVersion:BRIDGE_PROTOCOL_VERSION,
        capabilities:BRIDGE_CAPABILITIES,index:index.diagnostics(),pending:{queued,running,reads:reads.size},requests:Object.fromEntries(metrics)};
      case 'query_notes':return index.query(input);
      case 'search_content':return index.searchContent(input);
      case 'graph_notes':return index.graph(input);
      case 'schema_audit':return index.schema(input);
      case 'audit_vault':return index.audit(input);
      // A single note change is journaled under the runtime's operation id, so its outcome can be read back by that id.
      case 'create_note':return actions.createNote(plugin,operationStore,input,metadata);
      case 'update_properties':return actions.updateProperties(plugin,operationStore,input,metadata);
      case 'move_note':return actions.moveNote(plugin,operationStore,input,metadata);
      case 'trash_note':return actions.trashNote(plugin,operationStore,input,metadata);
      case 'operation_rollback':return actions.rollbackOperation(plugin,operationStore,input);
      case 'properties_batch_preview':return batches.previewPropertiesBatch(plugin,index,planStore,input);
      case 'properties_batch_apply':return batches.applyPropertiesBatch(plugin,operationStore,planStore,input);
      case 'properties_batch_rollback':return batches.rollbackPropertiesBatch(plugin,operationStore,planStore,input);
      case 'properties_batch_list':return{plans:await planStore.listPublic(input.limit)};
      case 'operation_list':return{operations:await operationStore.listPublic(input.limit)};
      default:throw new Error('Unknown Obsidian operation.');
    }
  }
  async function perform(body,entry){
    const startedAt=now();
    if(entry)entry.status='running';
    try{
      const result=await action(body.operation,body.input||{},body.operationId?{operationId:body.operationId}:{});
      settle(entry,'completed');measure(body.operation,startedAt,false);return result;
    }catch(error){settle(entry,'failed',error.message);measure(body.operation,startedAt,true);throw error;}
  }
  async function handle(req,res){
    try{
      if(!local(req.socket.remoteAddress)||req.headers.host!==new URL(url).host||(req.headers.origin&&req.headers.origin!==url))return send(res,403,{ok:false,error:{code:'forbidden',message:'Use the authenticated local host connection.'}});
      if(req.method!=='POST'||req.url!=='/api/call')return send(res,404,{ok:false,error:{code:'not_found'}});
      if(!equal(String(req.headers.authorization||''),'Bearer '+token))return send(res,401,{ok:false,error:{code:'unauthorized'}});
      if(!String(req.headers['content-type']||'').startsWith('application/json'))return send(res,415,{ok:false,error:{code:'content_type'}});
      const chunks=[];let bytes=0;
      for await(const chunk of req){bytes+=chunk.length;if(bytes>16*1024*1024)throw new Error('Host request exceeds 16 MiB.');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['operation','input','operationId','deadline'].includes(key)))throw new Error('Invalid host request.');
      // Liveness and outcome questions are answered in every state and never queue.
      if(body.operation==='host.ping')return send(res,200,{ok:true,result:{hostId,projectId,protocolVersion:BRIDGE_PROTOCOL_VERSION,accepting,drained}});
      if(body.operation==='host.outcome')return send(res,200,{ok:true,result:outcome(body.input?.operationId)});
      if(body.operation==='host.cancel'){
        const entry=outcomes.get(String(body.input?.operationId||''));
        if(entry?.status==='queued')settle(entry,'cancelled');
        return send(res,200,{ok:true,result:outcome(body.input?.operationId)});
      }
      if(body.operation==='host.drain'){
        // Only mutations are waited for; a read still running changes nothing.
        accepting=false;await queue;index.stop();drained=true;send(res,200,{ok:true,result:{drained:true}});return;
      }
      if(body.operation==='host.release'){
        if(!drained)throw new Error('Drain vault operations before releasing the host.');
        send(res,200,{ok:true,result:{released:true}});released=true;
        const closing=server;setImmediate(()=>{if(closing?.listening)closing.close();});return;
      }
      if(!accepting)throw coded('host_detached','This vault host is detached.');
      if(!BRIDGE_CAPABILITIES.includes(body.operation))throw new Error('Unknown Obsidian operation.');
      if(body.input!==undefined&&(!body.input||typeof body.input!=='object'||Array.isArray(body.input)))throw new Error('Input must be an object.');
      if(body.operationId!==undefined&&(typeof body.operationId!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(body.operationId)))throw new Error('Invalid operation id.');
      if(body.deadline!==undefined&&!Number.isFinite(body.deadline))throw new Error('Invalid deadline.');
      const entry=remember(body.operationId,body.operation);
      let work;
      if(READS.has(body.operation)){
        work=perform(body,entry);reads.add(work);
        void work.catch(()=>{}).then(()=>reads.delete(work));
      }else{
        queued++;
        work=queue.then(()=>{
          queued--;
          // The runtime gave up on a request that never started: applying it now would be a change nobody is waiting for.
          if(entry?.status==='cancelled')throw coded('cancelled','This vault operation was withdrawn before it started; nothing was changed.');
          if(body.deadline!==undefined&&now()>=body.deadline){
            settle(entry,'expired');
            throw coded('deadline_exceeded','The vault was busy until after this operation was due to start; nothing was changed.');
          }
          running++;
          return perform(body,entry).finally(()=>{running--;});
        });
        queue=work.catch(()=>{});
      }
      send(res,200,{ok:true,result:await work});
    }catch(error){send(res,400,{ok:false,error:{code:error.code&&typeof error.code==='string'?error.code:'host_operation_failed',message:error.message}});}
  }
  const registration=()=>client.call('host.attach',{hostId,projectId,root,url,token});
  async function start(){
    if(accepting)return{hostId,projectId,attached:true};
    if(server||released)throw new Error('Create a new host bridge after detaching.');
    server=http.createServer((req,res)=>{void handle(req,res);});
    server.maxConnections=16;server.headersTimeout=7000;server.requestTimeout=15000;server.keepAliveTimeout=1000;
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    url='http://127.0.0.1:'+server.address().port;
    try{
      await registration();
      index.start();accepting=true;return{hostId,projectId,attached:true};
    }catch(error){await new Promise(resolve=>server.close(resolve));server=null;throw error;}
  }
  // Register this same live listener again, after the runtime restarted or dropped the registration.
  async function attach(){
    if(!accepting||!server?.listening)throw new Error('This host bridge is no longer serving the vault.');
    await registration();return{hostId,projectId,attached:true};
  }
  function stop({timeoutMs=130000}={}){
    if(stopPromise)return stopPromise;
    // A bridge that already gave its listener up has nothing left to drain or to detach.
    if(released&&!server)return Promise.resolve();
    stopPromise=(async()=>{
      accepting=false;await queue;index.stop();drained=true;
      await client.call('host.detach',{hostId},{timeoutMs});
      if(server?.listening)await new Promise(resolve=>server.close(resolve));server=null;released=true;
    })();const work=stopPromise;
    void work.catch(()=>{if(stopPromise===work)stopPromise=null;});return work;
  }
  // Give the listener up without the runtime's confirmation: for an unload, or a runtime that is gone.
  // The runtime finds the address unanswered and drops or replaces the registration by itself.
  function dispose(){
    accepting=false;drained=true;released=true;
    try{index.stop();}catch{}
    const closing=server;server=null;
    if(closing){closing.close();closing.closeAllConnections?.();}
  }
  return{start,attach,stop,dispose,hostId,projectId,
    get state(){return released||(!server&&drained)?'released':accepting?'attached':drained?'drained':'new';}};
}
module.exports={createObsidianRuntimeBridge};
