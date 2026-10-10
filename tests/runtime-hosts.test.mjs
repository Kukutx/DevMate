import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {Store} from '../runtime/store.mjs';
import {createHostRegistry} from '../runtime/hosts.mjs';
import {createCapabilities} from '../runtime/capabilities.mjs';
const require=createRequire(import.meta.url);
class TFile{
  constructor(file,content){this.path=file;this.content=content;this.properties={};this.extension='md';this.stat={ctime:Date.now(),mtime:Date.now(),size:Buffer.byteLength(content)};}
  get basename(){return path.posix.basename(this.path,'.md');}
  get parent(){return{path:path.posix.dirname(this.path)==='.'?'':path.posix.dirname(this.path)};}
}
const original=Module._load;
Module._load=function(request,...rest){return request==='obsidian'?{TFile,getAllTags:cache=>cache.tags||[]}:original.call(this,request,...rest);};
const {createObsidianRuntimeBridge}=require('../obsidian-plugin/src/runtime-host-bridge.cjs');
const actions=require('../obsidian-plugin/src/bridge/note-actions.js');
Module._load=original;
function emitter(){const e=new EventEmitter();return{on(name,fn){e.on(name,fn);return{name,fn};},offref(ref){e.off(ref.name,ref.fn);},emit:(...args)=>e.emit(...args)};}
function vaultPlugin(root){
  const files=new Map(),vault={...emitter(),configDir:'.obsidian',adapter:{getBasePath:()=>root},getName:()=>path.basename(root),
    getAbstractFileByPath:file=>files.get(file)||null,getMarkdownFiles:()=>[...files.values()].filter(file=>file instanceof TFile),
    read:async file=>file.content,cachedRead:async file=>file.content,
    async createFolder(file){files.set(file,{path:file});},
    async create(file,content){const value=new TFile(file,content);files.set(file,value);vault.emit('create',value);return value;},
    async process(file,mutator){file.content=mutator(file.content);file.stat.mtime++;file.stat.size=Buffer.byteLength(file.content);metadata.emit('changed',file);}
  };
  const metadata={...emitter(),resolvedLinks:{},unresolvedLinks:{},getFileCache:file=>({frontmatter:file.properties})};
  const plugin={app:{vault,metadataCache:metadata,fileManager:{
    async processFrontMatter(file,mutate){mutate(file.properties);file.content=JSON.stringify(file.properties)+'\nbody';file.stat.mtime++;file.stat.size=Buffer.byteLength(file.content);metadata.emit('changed',file);},
    async renameFile(file,destination){const from=file.path;files.delete(from);file.path=destination;files.set(destination,file);vault.emit('rename',file,from);},
    async trashFile(file){files.delete(file.path);vault.emit('delete',file);}
  }}};
  return{plugin,files};
}
async function fixture(t,{fetchImpl,requestTimeoutMs}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-vault-host-'));
  const instance=path.join(root,'instance'),vaultRoot=path.join(root,'vault');fs.mkdirSync(vaultRoot);
  const store=new Store(instance),project=store.create('project',{name:'Vault',root:vaultRoot,access:'write'});
  const service={store,project(id,{write=false}={}){const item=store.get('project',id);if(write&&item.access!=='write')throw new Error('read only');return item;}};
  const registry=createHostRegistry({service,instanceRoot:instance,...(fetchImpl?{fetchImpl}:{}),...(requestTimeoutMs?{requestTimeoutMs}:{})}),bindings=[];
  const client={async call(name,input){const definition=registry.operations.find(item=>item.name===name);assert.ok(definition,name);if(name==='host.attach')bindings.push(input);return definition.run(definition.schema.parse(input));}};
  const fake=vaultPlugin(vaultRoot),bridge=createObsidianRuntimeBridge(fake.plugin,{client,projectId:project.id});
  await bridge.start();
  const cap=await createCapabilities({service,instanceRoot:instance,engines:[],hostRegistry:registry});
  t.after(async()=>{await bridge.stop().catch(()=>{});bridge.dispose();await cap.close();await registry.close();store.close();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const ownerRole={callerRole:'owner'};
  const call=(name,input={},options=ownerRole)=>cap.call({projectId:project.id,capability:'obsidian.'+name,input},options);
  return{root,instance,vaultRoot,store,project,service,registry,client,bindings,...fake,bridge,cap,call};
}
test('actual Vault domains use HTTP and SQLite across query, mutations, batch and rollback',async t=>{
  const f=await fixture(t);
  const vault=(await f.cap.list({projectId:f.project.id},{callerRole:'owner'})).engines.find(engine=>engine.id==='obsidian');
  assert.equal(vault.status,'attached');assert.equal(vault.capabilities.length,16);
  assert.deepEqual(vault.capabilities.filter(item=>item.longRunning).map(item=>item.name),['obsidian.content_search','obsidian.properties_batch_apply','obsidian.properties_batch_rollback']);
  assert.equal(JSON.stringify(vault).includes(f.bindings[0].token),false);
  const created=await f.call('note_create',{path:'Folder/A.md',content:'body'});
  assert.equal(created.created,true);
  assert.equal((await f.call('note_query')).total,1);
  assert.equal((await f.call('content_search',{query:'body'})).total,1);
  assert.ok(await f.call('note_graph',{paths:['Folder/A.md']}));
  assert.ok(await f.call('schema_audit'));
  assert.ok(await f.call('vault_audit'));
  const updated=await f.call('properties_update',{path:'Folder/A.md',set:{status:'active'}});
  await f.call('operation_rollback',{operationId:updated.operation.id});
  assert.equal(f.files.get('Folder/A.md').content,'body');
  const moved=await f.call('note_move',{path:'Folder/A.md',destination:'Folder/B.md'});
  await f.call('operation_rollback',{operationId:moved.operation.id});
  const trashed=await f.call('note_trash',{path:'Folder/A.md'});
  await f.call('operation_rollback',{operationId:trashed.operation.id});
  assert.equal(f.files.get('Folder/A.md').content,'body');
  const preview=await f.call('properties_batch_preview',{selector:{paths:['Folder/A.md']},set:{done:true}});
  assert.equal(preview.planned,true);
  assert.equal((await f.call('properties_batch_apply',{planId:preview.plan.id})).applied,true);
  assert.equal((await f.call('properties_batch_rollback',{planId:preview.plan.id})).rolledBack,true);
  assert.equal(f.files.get('Folder/A.md').content,'body');
  const plans=await f.call('properties_batch_list');
  assert.equal(plans.plans[0].files,1);
  assert.equal(plans.plans[0].status,'rolled_back');
  assert.equal((await f.call('operation_list')).operations.length,5);
  assert.ok(f.store.db.prepare('SELECT COUNT(*) AS n FROM host_records').get().n>=6);
  const events=JSON.stringify(f.store.events({})),binding=f.bindings[0];
  assert.equal(events.includes(binding.token),false);
  assert.equal(JSON.stringify(await f.client.call('host.list',{})).includes(binding.token),false);
  assert.equal(events.includes('body'),false);
  await f.bridge.stop();
  const again=createObsidianRuntimeBridge(f.plugin,{client:f.client,projectId:f.project.id});await again.start();
  assert.equal((await f.call('operation_list')).operations.length,5);
  await again.stop();
});
test('host/project/caller boundaries and direct Host, Origin, Bearer validation fail closed',async t=>{
  const f=await fixture(t),binding=f.bindings[0];
  await assert.rejects(f.call('note_create',{path:'Denied.md'},{callerRole:'read'}),/write access/);
  await assert.rejects(f.call('note_create',{path:'../outside.md'}),/path|outside|traversal/i);
  assert.equal(f.files.size,0);
  const otherRoot=path.join(f.root,'other');fs.mkdirSync(otherRoot);
  const other=f.store.create('project',{root:otherRoot,name:'Other',access:'write'});
  await assert.rejects(f.client.call('host.attach',{...binding,hostId:'another',projectId:other.id}),/root/);
  await assert.rejects(f.client.call('host.record.get',{projectId:other.id,hostId:binding.hostId,hostToken:binding.token,kind:'operation',recordId:'missing'}),/match/);
  for(const headers of [
    {'Content-Type':'application/json'},
    {Authorization:'Bearer '+binding.token,Origin:'https://evil.test','Content-Type':'application/json'}
  ]){
    const response=await fetch(binding.url+'/api/call',{method:'POST',headers,body:JSON.stringify({operation:'status',input:{}})});
    assert.ok([401,403].includes(response.status));
  }
  const status=await new Promise((resolve,reject)=>{
    const req=http.request(binding.url+'/api/call',{method:'POST',headers:{Host:'evil.test',Authorization:'Bearer '+binding.token,'Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    req.on('error',reject);req.end(JSON.stringify({operation:'status',input:{}}));
  });
  assert.equal(status,403);
});
test('runtime close drains a started mutation and allows its private journal to finish',async t=>{
  const f=await fixture(t);
  await f.call('note_create',{path:'A.md',content:'before'});
  let release,started;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
  const mutate=f.plugin.app.fileManager.processFrontMatter;
  f.plugin.app.fileManager.processFrontMatter=async(...args)=>{started();await gate;return mutate(...args);};
  const work=f.call('properties_update',{path:'A.md',set:{completed:true}});await entered;
  const closing=f.registry.close();
  await assert.rejects(f.call('status'),/closing/);
  release();const result=await work;await closing;
  const row=f.store.db.prepare('SELECT payload FROM host_records WHERE record_id=?').get(result.operation.id);
  assert.equal(JSON.parse(row.payload).status,'applied');
  assert.equal((await f.client.call('host.list',{})).items.length,0);
});
test('journal is durable before mutation and unfinished updates require an explicit recovery choice',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-vault-journal-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const {plugin,files}=vaultPlugin(root);await plugin.app.vault.create('A.md','original');
  const records=new Map();let writes=0;
  const store={createId:()=> 'record-one',read:async id=>structuredClone(records.get(id)),async write(record){if(++writes===2)throw new Error('record connection lost');records.set(record.id,structuredClone(record));}};
  await assert.rejects(actions.updateProperties(plugin,store,{path:'A.md',set:{done:true}}),/connection lost/);
  assert.equal(records.get('record-one').before.content,'original');
  assert.equal(records.get('record-one').status,'prepared');
  await assert.rejects(actions.rollbackOperation(plugin,store,{operationId:'record-one'}),/inspect.*force/);
  await actions.rollbackOperation(plugin,store,{operationId:'record-one',force:true});
  assert.equal(files.get('A.md').content,'original');
  const rejected={createId:()=> 'no-write',write:async()=>{throw new Error('offline');}};
  await assert.rejects(actions.createNote(plugin,rejected,{path:'Never.md',content:'unchanged'}),/offline/);
  assert.equal(files.has('Never.md'),false);
});

test('bridge retains its drained listener and retries a failed runtime detach',async t=>{
  const f=await fixture(t),call=f.client.call;let failed=false;
  f.client.call=async(name,input)=>{if(name==='host.detach'&&!failed){failed=true;throw new Error('temporary runtime connection loss');}return call(name,input);};
  await assert.rejects(f.bridge.stop(),/temporary/);
  assert.equal((await f.client.call('host.list',{})).items.length,1);
  await f.bridge.stop();
  assert.equal((await f.client.call('host.list',{})).items.length,0);
});
test('a lost drain acknowledgement is retried against the same owned live bridge',async t=>{
  let drains=0;
  const fetchImpl=async(url,options)=>{
    const response=await fetch(url,options);
    if(JSON.parse(options.body).operation==='host.drain'&&++drains===1){await response.json();throw new Error('drain acknowledgement lost');}
    return response;
  };
  const f=await fixture(t,{fetchImpl});
  await assert.rejects(f.bridge.stop(),/acknowledgement lost/);
  await f.bridge.stop();assert.equal(drains,2);
  assert.equal((await f.client.call('host.list',{})).items.length,0);
});
test('a lost listener release acknowledgement does not erase confirmed drain evidence',async t=>{
  let releases=0,drains=0;
  const fetchImpl=async(url,options)=>{
    const operation=JSON.parse(options.body).operation;
    if(operation==='host.drain')drains++;
    const response=await fetch(url,options);
    if(operation==='host.release'&&++releases===1){await response.json();throw new Error('release acknowledgement lost');}
    return response;
  };
  const f=await fixture(t,{fetchImpl});
  await assert.rejects(f.bridge.stop(),/release acknowledgement lost/);
  await new Promise(resolve=>setImmediate(resolve));
  await f.bridge.stop();
  assert.equal(drains,1);
  assert.equal((await f.client.call('host.list',{})).items.length,0);
});

// ---- a host that is gone, stuck or slow ----
const hostIds=async f=>(await f.client.call('host.list',{})).items.map(item=>item.id);
const second=f=>createObsidianRuntimeBridge(f.plugin,{client:f.client,projectId:f.project.id});

test('a host that died without detaching is replaced by the next attach',async t=>{
  const f=await fixture(t);
  await f.call('note_create',{path:'A.md',content:'kept'});
  // Obsidian closed or crashed: the listener is gone and nobody detached it.
  f.bridge.dispose();
  const next=second(f);t.after(()=>next.dispose());
  assert.deepEqual(await next.start(),{hostId:next.hostId,projectId:f.project.id,attached:true});
  assert.deepEqual(await hostIds(f),[next.hostId]);
  assert.equal((await f.call('status')).host.id,next.hostId);
  assert.equal((await f.call('operation_list')).operations.length,1,'the journal belongs to the project, not to one host');
  // A live host is not displaced.
  const third=second(f);
  await assert.rejects(third.start(),error=>error.code==='host_attached'&&/force:true/.test(error.message));
  assert.deepEqual(await hostIds(f),[next.hostId]);
  await next.stop();
});

test('a dead host never blocks calls, detach, project close or runtime close',async t=>{
  const f=await fixture(t),dead=f.bindings[0].hostId;
  f.bridge.dispose();
  await assert.rejects(f.call('status'),error=>error.code==='host_unavailable'&&/attaches again by itself/.test(error.message));
  assert.deepEqual(await hostIds(f),[],'a refused connection detached the host');
  await assert.rejects(f.call('note_query'),error=>error.code==='host_unavailable');
  assert.deepEqual(await f.client.call('host.detach',{hostId:dead}),{detached:false});

  // The same with the registration still in place.
  for(const finish of [
    g=>g.client.call('host.detach',{hostId:g.bindings[0].hostId}).then(result=>assert.deepEqual(result,{detached:true})),
    g=>g.registry.closeProject(g.project.id),
    g=>g.registry.close(),
    async g=>assert.deepEqual((await g.client.call('host.list',{projectId:g.project.id})).items,[])
  ]){
    const g=await fixture(t);g.bridge.dispose();
    await finish(g);
    assert.deepEqual(await hostIds(g),[]);
  }
  // A write that was in flight when the host died reports where to look.
  const h=await fixture(t);let entered;const started=new Promise(resolve=>{entered=resolve;});
  h.plugin.app.vault.create=async()=>{entered();await new Promise(()=>{});};
  const pending=h.call('note_create',{path:'Lost.md'});await started;h.bridge.dispose();
  await assert.rejects(pending,error=>error.code==='host_unavailable'&&/^operation-/.test(error.details.operationId)&&/obsidian\.operation_list/.test(error.message));
});

test('a host that is alive but stuck can be detached by force',async t=>{
  let stuck=true;
  const fetchImpl=async(url,options)=>{
    if(stuck&&JSON.parse(options.body).operation==='host.drain')throw Object.assign(new Error('The operation was aborted due to timeout'),{name:'TimeoutError'});
    return fetch(url,options);
  };
  const f=await fixture(t,{fetchImpl}),hostId=f.bindings[0].hostId;
  await assert.rejects(f.client.call('host.detach',{hostId}),/timeout/);
  assert.equal((await f.call('status')).available,true,'a failed drain leaves the host usable instead of stuck in host_closing');
  await assert.rejects(f.registry.closeProject(f.project.id),/timeout/);
  assert.deepEqual(await f.client.call('host.detach',{hostId,force:true}),{detached:true,forced:true});
  assert.deepEqual(await hostIds(f),[]);
  await assert.rejects(f.call('status'),error=>error.code==='host_unavailable');
  // A forced detach of a host that is still alive: its next journal write is refused, so it cannot change the vault.
  await assert.rejects(f.client.call('host.record.put',{projectId:f.project.id,hostId,hostToken:f.bindings[0].token,kind:'operation',record:{id:'operation-late'}}),error=>error.code==='forbidden');
  // The runtime itself always stops, also with a host that never confirms.
  const g=await fixture(t,{fetchImpl});
  await g.registry.close();
  assert.equal(g.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='host.detached'").get().n,1);
  stuck=false;
});

test('host.list reports reachability and status describes the bridge truthfully',async t=>{
  const f=await fixture(t);
  await f.call('note_create',{path:'A.md',content:'body'});
  await f.call('note_query');await f.call('note_query');
  await assert.rejects(f.call('note_create',{path:'A.md'}),/already exists/);
  const [listed]=(await f.client.call('host.list',{projectId:f.project.id})).items;
  assert.deepEqual([listed.id,listed.kind,listed.reachable],[f.bindings[0].hostId,'obsidian',true]);
  assert.ok(Date.parse(listed.lastSeenAt)>0);
  const status=await f.call('status',{}, {callerRole:'read'});
  assert.equal(status.protocolVersion,3);
  assert.equal(status.capabilities.length,16);
  assert.equal(fs.realpathSync.native(status.root),fs.realpathSync.native(f.vaultRoot));
  assert.equal(status.vault,path.basename(f.vaultRoot));
  assert.deepEqual(status.pending,{queued:0,running:0,reads:0});
  assert.deepEqual([status.requests.query_notes.count,status.requests.query_notes.errors],[2,0]);
  assert.deepEqual([status.requests.create_note.count,status.requests.create_note.errors],[2,1]);
  assert.ok(status.requests.create_note.maxMs>=status.requests.create_note.lastMs);
  assert.deepEqual([status.host.id,status.host.reachable],[listed.id,true]);
  assert.equal(JSON.stringify(status).includes(f.bindings[0].token),false);
});

test('a reply that is not JSON is a named error',async t=>{
  let broken=false;
  const fetchImpl=async(url,options)=>broken&&JSON.parse(options.body).operation==='query_notes'?new Response('<html>502 Bad Gateway</html>',{status:502}):fetch(url,options);
  const f=await fixture(t,{fetchImpl});broken=true;
  await assert.rejects(f.call('note_query'),error=>error.code==='host_invalid_response'&&/HTTP 502/.test(error.message)&&error.name==='DomainError');
  assert.equal((await f.call('status')).available,true);
});

test('reads answer while a mutation is in progress',async t=>{
  const f=await fixture(t);
  await f.call('note_create',{path:'A.md',content:'needle'});
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const mutate=f.plugin.app.fileManager.processFrontMatter;
  f.plugin.app.fileManager.processFrontMatter=async(...args)=>{entered();await gate;return mutate(...args);};
  const write=f.call('properties_update',{path:'A.md',set:{done:true}});await started;
  try{
    // None of these waits behind the blocked write.
    assert.equal((await f.call('note_query')).total,1);
    assert.equal((await f.call('content_search',{query:'needle'})).total,1);
    assert.deepEqual((await f.call('status')).pending,{queued:0,running:1,reads:0});
    assert.equal((await f.call('operation_list')).operations.length,2);
  }finally{release();}
  assert.equal((await write).updated,true);
});

test('a mutation the runtime stopped waiting for is withdrawn, never applied later',async t=>{
  const f=await fixture(t,{requestTimeoutMs:()=>400});
  await f.call('note_create',{path:'A.md',content:'x'});
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const mutate=f.plugin.app.fileManager.processFrontMatter;
  f.plugin.app.fileManager.processFrontMatter=async(...args)=>{entered();await gate;return mutate(...args);};
  const slow=f.call('properties_update',{path:'A.md',set:{slow:true}});
  const slowOutcome=assert.rejects(slow,error=>{
    // It had started: the outcome is unknown, named, and can be asked for.
    assert.equal(error.code,'outcome_unknown');assert.equal(error.details.status,'running');assert.equal(error.notStarted,undefined);
    assert.match(error.message,new RegExp('obsidian\\.operation_list \\{operationId:"'+error.details.operationId+'"\\}'));
    slow.operationId=error.details.operationId;return true;
  });
  await started;t.after(()=>release());
  // Queued behind it: its start deadline passes while it waits.
  let queuedId;
  await assert.rejects(f.call('note_create',{path:'Late.md',content:'must never appear'}),error=>{
    assert.equal(error.code,'host_timeout');assert.equal(typeof error.code,'string');
    assert.deepEqual(error.details.applied,false);assert.match(error.message,/nothing in the vault changed/);assert.equal(error.notStarted,true);
    queuedId=error.details.operationId;return true;
  });
  await slowOutcome;
  assert.equal((await f.call('operation_list',{operationId:slow.operationId})).outcome,'in_progress');
  assert.deepEqual([(await f.call('operation_list',{operationId:queuedId})).outcome,f.files.has('Late.md')],['not_applied',false]);

  release();
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(f.files.has('Late.md'),false,'the host did not create the note after the runtime gave up');
  const finished=await f.call('operation_list',{operationId:slow.operationId});
  assert.deepEqual([finished.outcome,finished.operation.id,finished.operation.action,finished.operation.status,finished.request.status],
    ['applied',slow.operationId,'update_properties','applied','completed']);
  assert.equal((await f.call('operation_list',{operationId:'operation-never-seen'})).outcome,'not_recorded');
  // The outcome is durable: it is still answered when no host is attached.
  await f.bridge.stop();
  assert.equal((await f.call('operation_list',{operationId:slow.operationId})).outcome,'applied');
  assert.equal((await f.call('operation_list',{operationId:queuedId})).outcome,'not_recorded');
});

test('the host drops queued work whose deadline passed and a slow read times out by name',async t=>{
  const f=await fixture(t,{requestTimeoutMs:()=>300}),binding=f.bindings[0];
  const post=body=>fetch(binding.url+'/api/call',{method:'POST',headers:{Authorization:'Bearer '+binding.token,'Content-Type':'application/json'},body:JSON.stringify(body)}).then(async response=>({status:response.status,...await response.json()}));
  const expired=await post({operation:'create_note',input:{path:'Expired.md'},operationId:'operation-expired',deadline:Date.now()-1});
  assert.deepEqual([expired.status,expired.ok,expired.error.code],[400,false,'deadline_exceeded']);
  assert.equal(f.files.has('Expired.md'),false);
  assert.equal((await post({operation:'host.outcome',input:{operationId:'operation-expired'}})).result.status,'expired');
  assert.equal((await post({operation:'host.outcome',input:{operationId:'operation-none'}})).result.status,'unknown');
  assert.deepEqual((await post({operation:'host.ping',input:{}})).result.accepting,true);
  assert.equal((await post({operation:'create_note',input:{path:'Bad id.md'},operationId:'bad id'})).error.message,'Invalid operation id.');

  await f.call('note_create',{path:'A.md',content:'needle'});
  f.plugin.app.vault.cachedRead=()=>new Promise(()=>{});
  await assert.rejects(f.call('content_search',{query:'needle'}),error=>error.code==='host_timeout'&&/within 0\.3 s/.test(error.message)&&error.details===undefined);
  assert.equal((await f.call('note_query')).total,1,'the host is still attached and answering');
});

test('vault records are bounded by count and age',async t=>{
  const f=await fixture(t),binding=f.bindings[0];
  const put=(kind,id)=>f.client.call('host.record.put',{projectId:f.project.id,hostId:binding.hostId,hostToken:binding.token,kind,record:{id,status:'applied',action:'create_note',items:[]}});
  const count=kind=>f.store.db.prepare('SELECT COUNT(*) AS n FROM host_records WHERE kind=?').get(kind).n;
  for(let index=0;index<505;index++)await put('operation','operation-'+String(index).padStart(4,'0'));
  assert.equal(count('operation'),500);
  const remaining=f.store.db.prepare("SELECT record_id FROM host_records WHERE kind='operation' ORDER BY record_id").all().map(row=>row.record_id);
  assert.deepEqual([remaining[0],remaining.at(-1)],['operation-0005','operation-0504'],'the newest are kept');
  for(let index=0;index<203;index++)await put('plan','plan-'+String(index).padStart(4,'0'));
  assert.equal(count('plan'),200);
  // Rewriting an existing record is not an insert and prunes nothing.
  await put('operation','operation-0100');assert.equal(count('operation'),500);
  f.store.db.prepare("UPDATE host_records SET updated_at='2020-01-01T00:00:00.000Z' WHERE record_id IN ('operation-0200','operation-0201')").run();
  await put('operation','operation-new');
  assert.equal(count('operation'),499,'two aged records left, one arrived');
  await assert.rejects(f.client.call('host.record.get',{projectId:f.project.id,hostId:binding.hostId,hostToken:binding.token,kind:'operation',recordId:'operation-0200'}),
    error=>error.code==='not_found'&&/operation-0200/.test(error.message));
});
