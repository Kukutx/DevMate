import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../runtime/store.mjs';
import { AgentCoordinator } from '../runtime/coordination.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-agent-scale-'));
  const store=new Store(path.join(root,'state'));
  const project=store.create('project',{name:'Scale',root:path.join(root,'checkout'),access:'write',status:'ready'});
  const workflow=store.create('workflow',{projectId:project.id,title:'Scale',status:'active',turnBudget:10000,usedTurns:0});
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  return {root,store,scope:{projectId:project.id,workflowId:workflow.id}};
}
const agent=(store,scope,label,status='ready')=>store.create('agent',{...scope,provider:'codex',label,status});

test('restart normalizes every interrupted agent beyond a 1000-row window',t=>{
  const {store,scope}=fixture(t);
  store.transaction(()=>{for(let i=0;i<1130;i++)agent(store,scope,'agent-'+i,'running');});
  const recovered=new AgentCoordinator({store});
  assert.equal(recovered.sessions.size,0);
  const remaining=store.list('agent',{status:'running',limit:2000});
  assert.equal(remaining.length,0,'No historical agent may claim a running native process after restart');
  assert.equal(store.list('agent',{status:'disconnected',limit:2000}).length,1130);
  const first = store.list('agent',{limit:1})[0];
  recovered.sessions.set(first.id,{stopped:false});
  recovered.tokens.set('peer-page-token',{...scope,agentId:first.id});
  const ids=[];let cursor;
  do {
    const page=recovered.channelCall('peer-page-token','agent_peers',{limit:170,...(cursor?{cursor}:{})});
    ids.push(...page.items.map(item=>item.id));
    cursor=page.nextCursor;
  } while(cursor);
  assert.equal(ids.length,1130);
  assert.equal(new Set(ids).size,1130,'Agent peer pagination must be complete and nonduplicating');
});

test('queued delivery beyond 1000 unrelated records is still dispatched to its exact agent',async t=>{
  const {store,scope}=fixture(t);
  const coordinator=new AgentCoordinator({store});
  const receiver=agent(store,scope,'target');
  const other=agent(store,scope,'other');
  const created=[];
  store.transaction(()=>{
    for(let i=0;i<1140;i++){
      const m=store.create('message',{...scope,sender:{kind:'user',id:'owner'},recipientIds:[other.id],status:'queued',body:'other-'+i});
      created.push(store.create('delivery',{...scope,messageId:m.id,agentId:other.id,status:'queued'}));
    }
  });
  const absent=store.list('delivery',{...scope,status:'queued',limit:2000}).at(-1);
  store.update('delivery',absent.id,{agentId:receiver.id});
  assert.equal(store.nextQueuedDelivery(scope.projectId,scope.workflowId,receiver.id)?.id,absent.id);
  assert.equal(store.hasQueuedDelivery(scope.projectId,scope.workflowId,receiver.id),true);
  const session={stopped:false,current:null,output:'',adapter:{async send(){return {status:'completed',text:'handled'};}}};
  await coordinator.drain(receiver.id,session);
  assert.equal(store.get('delivery',absent.id).status,'delivered');
  assert.equal(store.hasQueuedDelivery(scope.projectId,scope.workflowId,receiver.id),false);
});

test('a restart cancels queued messages with a refund, settles interrupted turns and leaves the job runner\'s jobs alone',t=>{
  const {store,scope}=fixture(t);
  const target=agent(store,scope,'target','running');
  const sender={kind:'user',id:'owner',label:'You'};
  const message=(body,status,extra={})=>store.create('message',{...scope,sender,recipientIds:[target.id],body,status,...extra});
  const cancelling=store.create('task',{...scope,title:'Being cancelled',status:'cancelling'});
  const waiting=store.create('task',{...scope,title:'Waiting',status:'queued'});
  const running=message('was running','running',{taskId:cancelling.id});
  const runningDelivery=store.create('delivery',{...scope,messageId:running.id,agentId:target.id,taskId:cancelling.id,status:'running'});
  const turn=store.create('job',{...scope,agentId:target.id,deliveryId:runningDelivery.id,kind:'agent-turn',status:'running'});
  const stale=[message('stale one','queued'),message('stale two','queued',{taskId:waiting.id})];
  const staleDeliveries=stale.map(item=>store.create('delivery',{...scope,messageId:item.id,agentId:target.id,taskId:item.taskId||null,status:'queued'}));
  const orphan=store.create('delivery',{...scope,messageId:'message-pruned',agentId:target.id,status:'queued'});
  store.update('workflow',scope.workflowId,{usedTurns:4});
  // Owned and reconciled by runtime/jobs.mjs.
  const command=store.create('job',{...scope,kind:'command',status:'running',executionId:'exec-1',input:{args:{command:'npm test'}}});
  const capability=store.create('job',{...scope,kind:'capability',status:'running',input:{args:{}}});
  const recovered=new AgentCoordinator({store});
  assert.equal(recovered.sessions.size,0);
  assert.equal(store.get('job',turn.id).status,'unknown');assert.equal(store.get('job',turn.id).error.code,'runtime_interrupted');
  assert.equal(store.get('delivery',runningDelivery.id).status,'unknown');
  assert.equal(store.get('message',running.id).status,'unknown');
  assert.equal(store.get('task',cancelling.id).status,'unknown','a task caught mid-cancellation is settled too');
  for(const delivery of [...staleDeliveries,orphan]) {
    assert.equal(store.get('delivery',delivery.id).status,'cancelled');
    assert.equal(store.get('delivery',delivery.id).error.code,'runtime_interrupted');
  }
  for(const item of stale)assert.equal(store.get('message',item.id).status,'cancelled');
  assert.equal(store.get('task',waiting.id).status,'cancelled');
  assert.equal(store.get('workflow',scope.workflowId).usedTurns,1,'three turns that never ran are given back');
  assert.equal(store.get('job',command.id).status,'running','a command job is not this coordinator\'s to rewrite');
  assert.equal(store.get('job',command.id).error,undefined);
  assert.equal(store.get('job',capability.id).status,'running');
  assert.equal(store.get('agent',target.id).status,'disconnected');
  assert.equal(store.hasQueuedDelivery(scope.projectId,scope.workflowId,target.id),false,'nothing stale is left to run before the next task');
});

test('agent inbox returns most recent 100 of >1000 messages without scanning stale prefixes',t=>{
  const {store,scope}=fixture(t);
  const recipient=agent(store,scope,'receiver');
  let token='scale-test-token';
  const coordinator=new AgentCoordinator({store});
  coordinator.sessions.set(recipient.id,{stopped:false});
  coordinator.tokens.set(token,{agentId:recipient.id,...scope});
  const base=Date.parse('2025-01-01T00:00:00.000Z');
  const stamp=store.db.prepare("UPDATE entities SET data=json_set(data,'$.createdAt',?) WHERE id=?");
  store.transaction(()=>{
    for(let i=0;i<1200;i++){
      const m=store.create('message',{...scope,sender:{kind:'user',id:'owner'},recipientIds:[recipient.id],body:'msg-'+i,status:'delivered'});
      stamp.run(new Date(base+i*1000).toISOString(),m.id);
    }
  });
  const started=performance.now();
  const inbox=coordinator.channelCall(token,'agent_inbox',{}).items;
  const elapsed=performance.now()-started;
  assert.equal(inbox.length,100);
  assert.deepEqual(inbox.map(x=>x.body),Array.from({length:100},(_,i)=>'msg-'+(1100+i)));
  assert.ok(elapsed<1000,'A local indexed inbox query should be bounded in one second');
  const chunks=[];let cursor,requests=0;
  do {
    const page=coordinator.channelCall(token,'agent_inbox',{limit:137,...(cursor?{cursor}:{})});
    chunks.push(page.items.map(item=>item.body));
    cursor=page.nextCursor;requests++;
    assert.ok(requests<=12,'History pagination must terminate');
  } while(cursor);
  const chronology=chunks.reverse().flat();
  assert.deepEqual(chronology,Array.from({length:1200},(_,i)=>'msg-'+i));
  assert.throws(()=>coordinator.channelCall(token,'agent_inbox',{cursor:'not-a-valid-token'}),{code:'invalid_cursor'});
});


test('cold coordinator startup reads only interrupted native records, not thousands of completed ones',t=>{
  const {store,scope}=fixture(t);
  const insert=store.db.prepare('INSERT INTO entities(id,kind,project_id,workflow_id,revision,data) VALUES(?,?,?,?,?,?)');
  store.transaction(()=>{
    for(let i=0;i<1800;i++){
      const suffix=String(i).padStart(6,'0');
      for(const [kind,status] of [['agent','closed'],['job','completed'],['delivery','delivered']]){
        const id=kind+'-history-'+suffix;
        insert.run(id,kind,scope.projectId,scope.workflowId,1,JSON.stringify({
          id,projectId:scope.projectId,workflowId:scope.workflowId,status,
          ...(kind==='job'?{kind:'agent-turn'}:{})
        }));
      }
    }
  });
  const read=store.list.bind(store);
  let loaded=0;
  store.list=(kind,options)=>{const rows=read(kind,options);if(['agent','job','delivery'].includes(kind))loaded+=rows.length;return rows;};
  const coordinator=new AgentCoordinator({store});
  assert.equal(coordinator.sessions.size,0);
  assert.ok(loaded<30,'Cold start must not parse '+loaded+' finished native records');
});
