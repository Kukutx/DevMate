import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DevMateService } from '../runtime/service.mjs';
import { Store } from '../runtime/store.mjs';

test('runtime exposes bounded owner-local storage and resource diagnostics without scanning data blobs',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-runtime-metrics-'));
  const state=path.join(root,'runtime'),projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);
  const service=new DevMateService({instanceRoot:state});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const owner={id:'owner',role:'owner',surface:'local'};
  const project=await service.call('project.create',{root:projectRoot},owner);
  for(let i=0;i<16;i++)service.store.create('task',{projectId:project.id,title:'task-'+i,status:'queued'});
  const stats=await service.call('runtime.metrics',{},owner);
  assert.equal(stats.database.schemaVersion,4);
  assert.equal(stats.database.journalMode,'wal');
  assert.ok(stats.database.sizeBytes>0);
  assert.ok(stats.database.events>=17);
  assert.equal(stats.database.entities.task,16);
  assert.ok(stats.runtime.residentBytes>0);
  assert.equal(typeof stats.runtime.nativeSessions,'number');
  await assert.rejects(service.call('runtime.metrics',{}, {id:'owner',role:'owner',surface:'mcp'}),{code:'forbidden'});
  assert.ok(service.store.db.prepare('PRAGMA quick_check').get().quick_check==='ok');
});

test('every call is counted by operation: how often, by whom, how long, and what it failed with',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-runtime-usage-'));
  const state=path.join(root,'runtime'),projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot,'a.txt'),'one line\n');
  const service=new DevMateService({instanceRoot:state});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const owner={id:'owner',role:'owner',surface:'local'},connected={id:'owner',role:'owner'};
  const project=await service.call('project.create',{root:projectRoot},owner);
  for(let i=0;i<3;i++)await service.call('workspace.read',{projectId:project.id,path:'a.txt'},connected);
  // What a model gets wrong is mostly refused before anything runs; that is counted too, and so is a name that does not exist.
  await assert.rejects(service.call('workspace.read',{projectId:project.id},connected),{code:'invalid_input'});
  await assert.rejects(service.call('workspace.edit',{projectId:project.id,path:'a.txt',edits:[{oldText:'absent',newText:'x'}]},connected));
  await assert.rejects(service.call('job_start',{},connected),{code:'unknown_operation'});
  await assert.rejects(service.call('some-other-invented-name',{},connected),{code:'unknown_operation'});
  const {usage}=await service.call('runtime.metrics',{},owner);
  const named=name=>usage.operations.find(item=>item.name===name);
  assert.deepEqual([named('workspace.read').calls,named('workspace.read').connected,named('workspace.read').failed,named('workspace.read').errors],[4,4,1,{invalid_input:1}]);
  assert.equal(named('project.create').connected,0,'the owner at this computer is not a connected client');
  assert.equal(named('workspace.edit').failed,1);assert.equal(Object.values(named('workspace.edit').errors)[0],1);
  // Names nobody registered share one line: a caller cannot grow this list.
  assert.deepEqual([named('(unknown)').calls,named('(unknown)').errors],[2,{unknown_operation:2}]);assert.equal(named('job_start'),undefined);
  for(const item of usage.operations)assert.ok(Number.isInteger(item.averageMs)&&item.maxMs>=item.averageMs,item.name);
  // The newest failure first, with its request number, and nothing of what was sent.
  assert.equal(usage.recentFailures.length,4);assert.deepEqual([usage.recentFailures[0].operation,usage.recentFailures[0].code,usage.recentFailures[0].caller],['(unknown)','unknown_operation','connected']);
  assert.ok(usage.recentFailures[0].request>usage.recentFailures[3].request);assert.ok(!JSON.stringify(usage).includes('absent'));
  assert.equal(usage.requests>=9,true);
});

test('Store metrics can be observed after write amplification without deleting historical events',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-store-stats-'));
  const store=new Store(root);
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  for(let i=0;i<12;i++)store.create('project',{name:'p-'+i,root:path.join(root,'project-'+i)});
  const before=store.metrics();
  assert.equal(before.entities.project,12);
  assert.ok(before.events>=12);
  assert.ok(before.databaseBytes+before.walBytes>0);
  assert.equal(before.notificationFailures,0);
});
