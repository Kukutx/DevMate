import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../runtime/store.mjs';

test('a failing event subscriber cannot turn an already committed SQLite write into a reported failure',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-notify-failure-'));
  const store=new Store(root);
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  const delivered=[];
  store.on('event',()=>{throw new Error('broken SSE subscriber');});
  store.on('event',event=>delivered.push(event.type));
  const created=store.create('project',{root:path.join(root,'project'),name:'durable',access:'write'});
  assert.equal(store.get('project',created.id).id,created.id);
  assert.deepEqual(delivered,['project.created'],'Healthy listeners must still receive committed events.');
  assert.equal(store.notificationFailures,1);
  assert.match(store.lastNotificationError?.message||'',/broken SSE subscriber/);
  const changed=store.update('project',created.id,{name:'still working'});
  assert.equal(store.get('project',changed.id).name,'still working');
  assert.equal(store.notificationFailures,2);
});

test('once subscribers keep their one-shot lifecycle even if a sibling fails',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-once-notify-'));
  const store=new Store(root);
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  let once=0;
  store.on('event',()=>{throw new Error('observer failed');});
  store.once('event',()=>{once++;});
  store.create('project',{root:path.join(root,'a'),name:'A'});
  store.create('project',{root:path.join(root,'b'),name:'B'});
  assert.equal(once,1);
  assert.equal(store.notificationFailures,2);
});
