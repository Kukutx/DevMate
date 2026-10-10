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
