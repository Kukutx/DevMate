import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRuntimeClient } from '../runtime/client.mjs';
import { fixture } from './runtime-integration-fixtures.mjs';

// The person at the window has agreed to share these folders.
const shared = (root, name) => ({ root, name, register: 'write' });

test('two VS Code windows have independent selections and share one runtime and project store',async t=>{
  const f=await fixture(t);
  const roots=['Window A','Window B'].map(name=>{
    const root=path.join(f.temp,name);fs.mkdirSync(root);return shared(root,name);
  });
  const identities=[randomUUID(),randomUUID()];
  const clients=identities.map(windowId=>createRuntimeClient({instanceRoot:f.instanceRoot,windowId}));
  const bound=await Promise.all(clients.map((client,index)=>client.call('window.attach',{
    windowId:identities[index],title:roots[index].name,roots:[roots[index]]
  })));
  assert.notEqual(bound[0].windowId,bound[1].windowId);
  assert.notEqual(bound[0].selectedProjectId,bound[1].selectedProjectId);
  assert.equal((await f.call('window.list')).items.length,2);
  for(let index=0;index<2;index++){
    assert.deepEqual((await clients[index].call('project.list')).items.map(project=>project.id),[bound[index].selectedProjectId]);
    const snapshot = await clients[index].snapshot();
    assert.equal(snapshot.selection.projectId,bound[index].selectedProjectId);
    assert.deepEqual(snapshot.projects.map(project=>project.id),[bound[index].selectedProjectId]);
    assert.deepEqual(snapshot.windows.map(window=>window.windowId),[identities[index]]);
    assert.deepEqual((await clients[index].call('window.list')).items.map(window=>window.windowId),[identities[index]]);
    const other=bound[1-index].selectedProjectId;
    await assert.rejects(clients[index].call('workspace.files',{projectId:other}),error=>error.code==='scope_mismatch');
    await assert.rejects(clients[index].call('window.select',{windowId:identities[index],projectId:other}),error=>error.code==='scope_mismatch');
    // The generic call is no way around the window's own project either.
    await assert.rejects(clients[index].call('operations.call',{operation:'workspace.files',input:{projectId:other}}),error=>error.code==='scope_mismatch');
  }
  assert.equal((await f.call('project.list')).items.length,2);
  const secondWindow=identities[1];
  await clients[0].call('window.detach',{windowId:identities[0]});
  assert.deepEqual((await f.call('window.list')).items.map(item=>item.windowId),[secondWindow]);
  assert.equal((await clients[1].call('project.list')).items[0].id,bound[1].selectedProjectId);
});

test('opening a folder shares nothing: it becomes a project only on an explicit answer',async t=>{
  const f=await fixture(t),windowId=randomUUID();
  const root=path.join(f.temp,'private work');fs.mkdirSync(root);
  const client=createRuntimeClient({instanceRoot:f.instanceRoot,windowId});
  const opened=await client.call('window.attach',{windowId,title:'Just opened',roots:[{root,name:'Private work'}]});
  assert.deepEqual(opened.roots.map(folder=>[folder.name,folder.projectId]),[['Private work',null]]);
  assert.equal(opened.selectedProjectId,null);
  assert.deepEqual((await f.call('project.list')).items,[],'no project was created by opening the folder');
  // The window works, and says what is missing, for everything that needs a project.
  assert.equal((await client.call('connection.status')).kind,'local');
  assert.ok((await client.call('runtime.doctor')).checks.length);
  for(const [operation,input] of [['workspace.files',{}],['shell.run',{command:'echo no'}],['project.overview',{}]])
    await assert.rejects(client.call(operation,input),error=>error.code==='window_unselected',operation);
  await assert.rejects(client.snapshot(),error=>error.code==='window_unselected');
  const readOnly=await client.call('window.attach',{windowId,title:'Just opened',roots:[{root,name:'Private work',register:'read'}]});
  assert.equal(readOnly.selectedProjectId,readOnly.roots[0].projectId);
  const project=(await f.call('project.list')).items[0];
  assert.deepEqual([project.access,project.name,project.protectSecrets],['read','Private work',true]);
  await assert.rejects(client.call('workspace.write',{path:'x.txt',text:'x',expectedSha256:null}),error=>error.code==='read_only');
  // Later attaches bind the existing project without asking again, and never change its access.
  const again=await client.call('window.attach',{windowId,roots:[{root,name:'Private work',register:'write'}]});
  assert.equal(again.selectedProjectId,project.id);
  assert.equal((await f.call('project.list')).items[0].access,'read');
});

test('multi-folder windows require explicit selection and cannot claim roots outside the window',async t=>{
  const f=await fixture(t),windowId=randomUUID();
  const roots=['A','B'].map(name=>{const root=path.join(f.temp,'multi-'+name);fs.mkdirSync(root);return shared(root,name);});
  const client=createRuntimeClient({instanceRoot:f.instanceRoot,windowId});
  const attached=await client.call('window.attach',{windowId,roots,title:'Multi-root'});
  assert.equal(attached.roots.length,2);
  assert.equal(attached.selectedProjectId,null);
  await assert.rejects(client.call('workspace.files',{projectId:attached.roots[0].projectId}),error=>error.code==='window_unselected');
  await assert.rejects(client.snapshot(),error=>error.code==='window_unselected');
  const chosen=await client.call('window.select',{windowId,projectId:attached.roots[1].projectId});
  assert.equal(chosen.selectedProjectId,attached.roots[1].projectId);
  assert.deepEqual((await client.call('project.list')).items.map(item=>item.id),[chosen.selectedProjectId]);
  const returned=await client.call('window.attach',{windowId,roots,title:'Multi-root'});
  assert.equal(returned.selectedProjectId,chosen.selectedProjectId);
  const outsider=path.join(f.temp,'outsider');fs.mkdirSync(outsider);
  await assert.rejects(client.call('window.attach',{windowId,roots,selectedRoot:outsider}),error=>error.code==='invalid_selection');
  assert.equal((await client.call('window.list')).items[0].selectedProjectId,chosen.selectedProjectId);
  await assert.rejects(client.call('window.detach',{windowId:randomUUID()}),error=>error.code==='scope_mismatch');
  // With one shared folder among several open ones there is nothing to choose.
  const mixedId=randomUUID(),mixed=createRuntimeClient({instanceRoot:f.instanceRoot,windowId:mixedId});
  const third=path.join(f.temp,'multi-C');fs.mkdirSync(third);
  const partly=await mixed.call('window.attach',{windowId:mixedId,roots:[{root:third,name:'C'},roots[0]]});
  assert.equal(partly.selectedProjectId,attached.roots[0].projectId);
  // A removed project leaves the folder open and unshared in every window that has it.
  await f.call('project.remove',{id:attached.roots[0].projectId});
  const after=(await f.call('window.list')).items.find(item=>item.windowId===mixedId);
  assert.deepEqual([after.selectedProjectId,after.roots.map(folder=>folder.projectId)],[null,[null,null]]);
});

test('identical physical folder in separate editor windows still has distinct window identities',async t=>{
  const f=await fixture(t),root=path.join(f.temp,'shared');fs.mkdirSync(root);
  const ids=[randomUUID(),randomUUID()];
  const clients=ids.map(windowId=>createRuntimeClient({instanceRoot:f.instanceRoot,windowId}));
  const result=await Promise.all(clients.map((client,i)=>client.call('window.attach',{windowId:ids[i],roots:[shared(root,'Shared folder')]})));
  assert.notEqual(result[0].windowId,result[1].windowId);
  assert.equal(result[0].selectedProjectId,result[1].selectedProjectId);
  assert.equal((await f.call('window.list')).items.length,2);
  assert.equal((await f.call('project.list')).items.length,1,'two windows racing to share one folder create one project');
});

test('a folder opened through another spelling of its path is one project and its editor files are still recognised',async t=>{
  const f=await fixture(t),real=path.join(f.temp,'real folder'),alias=path.join(f.temp,'alias');
  fs.mkdirSync(path.join(real,'src','inner'),{recursive:true});fs.symlinkSync(real,alias,'junction');
  const ids=[randomUUID(),randomUUID()],clients=ids.map(windowId=>createRuntimeClient({instanceRoot:f.instanceRoot,windowId}));
  const direct=await clients[0].call('window.attach',{windowId:ids[0],roots:[shared(real,'Real')]});
  const linked=await clients[1].call('window.attach',{windowId:ids[1],roots:[shared(alias,'Alias'),shared(path.join(alias,'src','inner'),'Inner')]});
  assert.equal(linked.roots[0].projectId,direct.selectedProjectId,'the alias is the same project');
  assert.equal(linked.roots[0].opened,alias);assert.equal(linked.roots[0].root,fs.realpathSync.native(alias));
  await clients[1].call('window.select',{windowId:ids[1],projectId:linked.roots[0].projectId});
  // The editor reports files under the spelling it opened the folder with.
  const accepted=await clients[1].call('window.context',{windowId:ids[1],context:{
    active:{file:path.join(alias,'src','app.ts'),languageId:'typescript',lineCount:3,selection:{}},
    open:[{file:path.join(alias,'src','app.ts')},{file:path.join(alias,'src','inner','deep.ts')}],
    diagnostics:[{file:path.join(alias,'src','app.ts'),severity:'error',line:0,character:0,message:'through the alias'},
      {file:path.join(alias,'src','inner','deep.ts'),severity:'error',line:0,character:0,message:'in the nested folder'}]}});
  assert.equal(accepted.diagnostics,2);
  const state=await f.call('editor.diagnostics',{projectId:direct.selectedProjectId});
  assert.deepEqual(state.items.map(item=>[item.path,item.message]),[['src/app.ts','through the alias']]);
  // A file in a folder that is open on its own belongs to that inner project, not to the one around it.
  const inner=await f.call('editor.diagnostics',{projectId:linked.roots[1].projectId});
  assert.deepEqual(inner.items.map(item=>[item.path,item.message]),[['deep.ts','in the nested folder']]);
});

test('untrusted and invalid windows do not partially register projects',async t=>{
  const f=await fixture(t),windowId=randomUUID(),first=path.join(f.temp,'first');fs.mkdirSync(first);
  const client=createRuntimeClient({instanceRoot:f.instanceRoot,windowId});
  await assert.rejects(client.call('window.attach',{windowId,roots:[shared(first,'OK'),{root:'relative',name:'Bad',register:'write'}]}),error=>error.code==='invalid_path');
  assert.deepEqual((await f.call('project.list')).items,[]);
  const state=await client.call('window.attach',{windowId,roots:[],trusted:false});
  assert.equal(state.selectedProjectId,null);
  await assert.rejects(client.call('window.attach',{windowId,trusted:false,roots:[shared(first,'Not trusted')]}),error=>error.code==='untrusted_workspace');
  assert.deepEqual((await f.call('project.list')).items,[]);
});


test('parallel window file operations stay within six independently bound projects',async t=>{
  const f=await fixture(t),windows=[];
  for(let i=0;i<6;i++){
    const root=path.join(f.temp,'parallel-'+i);fs.mkdirSync(root);
    const windowId=randomUUID(),client=createRuntimeClient({instanceRoot:f.instanceRoot,windowId});
    windows.push({windowId,client,root});
  }
  const bindings=await Promise.all(windows.map((item,i)=>item.client.call('window.attach',{
    windowId:item.windowId,title:'Window '+i,roots:[shared(item.root,'Window '+i)]
  })));
  assert.equal(new Set(bindings.map(item=>item.selectedProjectId)).size,6);
  for(let round=0;round<15;round++){
    // A window names no project: its own is meant.
    const written=await Promise.all(windows.map((item,i)=>item.client.call('workspace.write',{
      ...(round%2?{projectId:bindings[i].selectedProjectId}:{}),path:'round-'+round+'.txt',text:'from '+i+' / '+round,expectedSha256:null
    })));
    assert.ok(written.every(item=>item.written));
    const read=await Promise.all(windows.map((item,i)=>item.client.call('workspace.read',{
      projectId:bindings[i].selectedProjectId,path:'round-'+round+'.txt'
    })));
    read.forEach((file,i)=>assert.equal(file.text,'from '+i+' / '+round));
  }
  const rejected=await Promise.allSettled(windows.map((item,i)=>item.client.call('workspace.read',{
    projectId:bindings[(i+1)%6].selectedProjectId,path:'round-14.txt'
  })));
  assert.ok(rejected.every(item=>item.status==='rejected'&&item.reason.code==='scope_mismatch'));
  assert.equal((await f.call('window.list')).items.length,6);
});
