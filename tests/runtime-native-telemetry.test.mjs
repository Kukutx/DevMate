import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../runtime/store.mjs';
import { AgentCoordinator } from '../runtime/coordination.mjs';

test('native text delta storm does not turn 1500 tiny chunks into 1500 durable SQLite transactions',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-native-telemetry-'));
  const store=new Store(path.join(root,'instance'));
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const project=store.create('project',{root:path.join(root,'checkout'),access:'write'});
  const workflow=store.create('workflow',{projectId:project.id,title:'Telemetry',status:'active',turnBudget:10000});
  const agent=store.create('agent',{projectId:project.id,workflowId:workflow.id,label:'codex',status:'running',provider:'codex'});
  const coordinator=new AgentCoordinator({store});
  const session={current:{id:'fixture-job'},output:'',stopped:false};
  const payload='1234567890123456789012345678901234567890';
  const readAgent=store.get.bind(store);
  let agentReads=0;
  store.get=(kind,id)=>{if(kind==='agent')agentReads++;return readAgent(kind,id);};
  const start=performance.now();
  for(let i=0;i<1500;i++)coordinator.nativeEvent(agent.id,session,{
    type:'message',delta:true,text:payload,native:{type:'fixture-delta',chunk:i}
  });
  await new Promise(resolve=>setTimeout(resolve,60));
  const elapsed=performance.now()-start;
  const events=store.events({projectId:project.id,after:0,limit:2000})
    .filter(event=>event.type==='agent.native');
  assert.ok(events.length>0,'Native text must remain visible to history consumers');
  assert.ok(events.length<=32,'Bursty text must be coalesced instead of writing one SQLite row per token');
  assert.equal(events.map(event=>event.nativeEvent.text).join(''),payload.repeat(1500));
  assert.equal(session.output,payload.repeat(1500));
  assert.ok(agentReads<40,'Streaming deltas must not read the agent row once per token');
  assert.ok(elapsed<4000,'Native throughput should stay bounded even with 1500 fragments');
});

test('native delta is flushed before a terminal state event',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-telemetry-order-'));
  const store=new Store(path.join(root,'instance'));
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const project=store.create('project',{root:path.join(root,'checkout'),access:'write'});
  const workflow=store.create('workflow',{projectId:project.id,title:'Native',status:'active'});
  const agent=store.create('agent',{projectId:project.id,workflowId:workflow.id,label:'codex',status:'running',provider:'codex'});
  const coordinator=new AgentCoordinator({store});
  const session={current:{id:'job'},output:'',stopped:false};
  coordinator.nativeEvent(agent.id,session,{type:'message',text:'first ',delta:true});
  coordinator.nativeEvent(agent.id,session,{type:'message',text:'second',delta:true});
  coordinator.nativeEvent(agent.id,session,{type:'state',state:'disconnected'});
  const native=store.events({projectId:project.id,limit:100}).filter(event=>event.type==='agent.native');
  assert.equal(native.length,2);
  assert.equal(native[0].nativeEvent.text,'first second');
  assert.equal(native[1].nativeEvent.state,'disconnected');
});


test('multi-megabyte native output has a bounded in-memory tail while its full event history remains readable',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-native-long-output-'));
  const store=new Store(path.join(root,'instance'));
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const project=store.create('project',{root:path.join(root,'checkout'),access:'write'});
  const workflow=store.create('workflow',{projectId:project.id,title:'Long'});
  const agent=store.create('agent',{projectId:project.id,workflowId:workflow.id,provider:'codex',label:'codex',status:'running'});
  const coord=new AgentCoordinator({store});
  const session={current:{id:'long-job'},output:'',stopped:false};
  const chunk='1234567890'.repeat(820);
  for(let i=0;i<260;i++)coord.nativeEvent(agent.id,session,{type:'message',delta:true,text:chunk});
  coord.flushNativeDeltas(agent.id,session);
  assert.ok(session.output.length<=262144,'Streaming multi-MiB responses must not remain entirely in runtime memory');
  assert.equal(session.outputTruncated,true);
  const events=store.events({projectId:project.id,after:0,limit:2000})
    .filter(e=>e.type==='agent.native'&&e.nativeEvent?.delta);
  assert.equal(events.map(e=>e.nativeEvent.text).join(''),chunk.repeat(260));
});


test('a failed SQLite native-delta commit keeps pending text for an explicit successful retry',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-delta-commit-'));
  const store=new Store(path.join(root,'instance'));
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  const project=store.create('project',{root:path.join(root,'checkout'),access:'write'});
  const workflow=store.create('workflow',{projectId:project.id,title:'Durable'});
  const agent=store.create('agent',{projectId:project.id,workflowId:workflow.id,label:'Agent',status:'running'});
  const coord=new AgentCoordinator({store});
  const session={current:{id:'job'},output:'',stopped:false};
  coord.nativeEvent(agent.id,session,{type:'message',text:'important text',delta:true});
  const event=store.event.bind(store);
  store.event=(type,entity,data)=>{
    if(type==='agent.native')throw new Error('simulated sqlite write failure');
    return event(type,entity,data);
  };
  const pending=()=>[...session.pendingNative.values()].flatMap(stream=>stream.fragments);
  assert.throws(()=>coord.flushNativeDeltas(agent.id,session),/simulated sqlite write failure/);
  assert.deepEqual(pending(),['important text']);
  store.event=event;
  coord.flushNativeDeltas(agent.id,session);
  assert.deepEqual(pending(),[]);
  const native=store.events({projectId:project.id,limit:100}).filter(x=>x.type==='agent.native');
  assert.equal(native.length,1);
  assert.equal(native[0].nativeEvent.text,'important text');
});


test('parallel Codex native subagent streams remain individually attributable without contaminating root output',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-native-child-streams-'));
  const store=new Store(path.join(root,'instance'));
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const project=store.create('project',{root:path.join(root,'checkout'),access:'write'});
  const workflow=store.create('workflow',{projectId:project.id,title:'Native children'});
  const agent=store.create('agent',{projectId:project.id,workflowId:workflow.id,label:'codex',provider:'codex',status:'running'});
  const coordinator=new AgentCoordinator({store});
  const session={current:{id:'root-job'},output:'',stopped:false};
  coordinator.nativeEvent(agent.id,session,{type:'message',delta:true,text:'child-A',
    nativeSubagent:true,nativeThreadId:'child-a',nativeParentThreadId:'main'});
  coordinator.nativeEvent(agent.id,session,{type:'message',delta:true,text:'main-answer'});
  coordinator.nativeEvent(agent.id,session,{type:'message',delta:true,text:'child-B',
    nativeSubagent:true,nativeThreadId:'child-b',nativeParentThreadId:'main'});
  coordinator.nativeEvent(agent.id,session,{type:'state',state:'running'});
  const entries=store.events({projectId:project.id,limit:100})
    .filter(entry=>entry.type==='agent.native'&&entry.nativeEvent?.delta);
  assert.deepEqual(entries.map(e=>e.nativeEvent.text),['child-A','main-answer','child-B']);
  assert.deepEqual(entries.map(e=>e.nativeEvent.nativeThreadId??null),['child-a',null,'child-b']);
  assert.deepEqual(entries.map(e=>e.nativeEvent.nativeParentThreadId??null),['main',null,'main']);
  assert.equal(session.output,'main-answer','Child chat content must not be treated as the root Agent final response');
});


function telemetryFixture(t,name) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-native-'+name+'-'));
  const store=new Store(path.join(root,'instance'));
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const project=store.create('project',{root:path.join(root,'checkout'),access:'write'});
  const workflow=store.create('workflow',{projectId:project.id,title:'Native'});
  const agent=store.create('agent',{projectId:project.id,workflowId:workflow.id,label:'codex',provider:'codex',status:'running'});
  const coordinator=new AgentCoordinator({store});
  const native=()=>store.events({projectId:project.id,limit:2000}).filter(entry=>entry.type==='agent.native').map(entry=>entry.nativeEvent);
  return {store,agent,coordinator,native};
}

test('every streaming delta is coalesced per method and item, and only assistant text is kept',t=>{
  const {agent,coordinator,native}=telemetryFixture(t,'streams');
  const session={current:{id:'job'},output:'',stopped:false};
  const emit=(type,nativeMethod,itemId,text)=>coordinator.nativeEvent(agent.id,session,{type,nativeMethod,itemId,text,delta:true,native:{params:{delta:text}}});
  for(let i=0;i<60;i++)emit('tool','item/commandExecution/outputDelta','cmd-1','SECRET_TOKEN=abc line '+i+'\n');
  for(let i=0;i<40;i++)emit('reasoning','item/reasoning/textDelta','reason-1','private chain of thought '+i+' ');
  for(let i=0;i<10;i++)emit('message','item/agentMessage/delta','msg-1','word'+i+' ');
  coordinator.nativeEvent(agent.id,session,{type:'state',nativeMethod:'turn/completed',status:'completed'});
  const rows=native();
  assert.ok(rows.length<=6,'110 fragments must not become '+rows.length+' journal rows');
  const streams=rows.filter(row=>row.delta);
  assert.deepEqual(streams.map(row=>[row.type,row.nativeMethod,row.itemId,row.fragments]),
    [['tool','item/commandExecution/outputDelta','cmd-1',60],['reasoning','item/reasoning/textDelta','reason-1',40],['message','item/agentMessage/delta','msg-1',10]]);
  assert.equal(streams[0].text,undefined,'command output is not written to the journal');
  assert.equal(streams[1].text,undefined,'reasoning is not written to the journal');
  assert.ok(streams[0].chars>1000&&streams[1].chars>1000,'their size is');
  assert.equal(streams[2].text,Array.from({length:10},(_,i)=>'word'+i+' ').join(''));
  assert.equal(JSON.stringify(rows).includes('SECRET_TOKEN'),false);
  assert.equal(session.output,streams[2].text,'only assistant text is the partial answer');
});

test('non-delta native events are journaled as a compact summary; the raw payload is an explicit setting',t=>{
  const {agent,coordinator,native}=telemetryFixture(t,'compact');
  const session={current:{id:'job'},output:'',stopped:false};
  const raw={method:'item/completed',params:{threadId:'t',turnId:'turn-1',item:{type:'commandExecution',id:'cmd-1',command:'cat .env',aggregatedOutput:'API_KEY=sk-live-123',status:'completed'}}};
  const event={type:'tool',provider:'codex',sessionId:'thread-1',turnId:'turn-1',nativeMethod:'item/completed',itemId:'cmd-1',itemType:'commandExecution',status:'completed',native:raw};
  coordinator.nativeEvent(agent.id,session,event);
  coordinator.nativeEvent(agent.id,session,{type:'approval',provider:'codex',request:{id:'7',kind:'item/commandExecution/requestApproval',summary:'Run: cat .env',details:{command:'cat .env'}},native:{id:7,params:{command:'cat .env'}}});
  coordinator.nativeEvent(agent.id,session,{type:'message',provider:'claude',nativeMethod:'assistant',text:'A whole assistant message.',native:{type:'assistant'}});
  const [tool,approval,message]=native();
  assert.deepEqual(tool,{type:'tool',provider:'codex',sessionId:'thread-1',turnId:'turn-1',nativeMethod:'item/completed',itemId:'cmd-1',itemType:'commandExecution',status:'completed',bytes:JSON.stringify(raw).length});
  assert.deepEqual(approval.request,{id:'7',kind:'item/commandExecution/requestApproval',summary:'Run: cat .env'});
  assert.equal(approval.native,undefined);
  assert.equal(message.text,'A whole assistant message.');
  assert.equal(JSON.stringify(native()).includes('sk-live-123'),false,'tool output never reaches event.list by default');
  session.record=true;
  coordinator.nativeEvent(agent.id,session,event);
  coordinator.nativeEvent(agent.id,session,{...event,native:{blob:'x'.repeat(70000)}});
  const recorded=native().slice(-2);
  assert.deepEqual(recorded[0].native,raw);
  assert.deepEqual(recorded[1].native,{omitted:true,bytes:recorded[1].bytes},'even then one event stays bounded');
});

test('a native child ending or failing never disconnects or renames its active parent Agent',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-child-status-protection-'));
  const store=new Store(path.join(root,'instance'));
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const project=store.create('project',{root:path.join(root,'checkout'),access:'write'});
  const workflow=store.create('workflow',{projectId:project.id,title:'Child scoped'});
  const agent=store.create('agent',{projectId:project.id,workflowId:workflow.id,
    label:'main',provider:'codex',nativeSessionId:'root-thread',status:'running'});
  const coord=new AgentCoordinator({store});
  // Recovery correctly disconnects old running rows; simulate a newly
  // established, actually live parent turn after recovery.
  store.update('agent',agent.id,{status:'running'});
  const initialError=store.get('agent',agent.id).error;
  const session={current:{id:'active-parent-job'},output:'root-answer',stopped:false};
  coord.nativeEvent(agent.id,session,{type:'state',state:'disconnected',sessionId:'child-thread',
    nativeSubagent:true,nativeThreadId:'child-thread',nativeParentThreadId:'root-thread'});
  coord.nativeEvent(agent.id,session,{type:'error',nativeSubagent:true,nativeThreadId:'child-thread',
    nativeParentThreadId:'root-thread',native:{params:{error:{message:'child failed'}}}});
  const rootAgent=store.get('agent',agent.id);
  assert.equal(rootAgent.status,'running');
  assert.equal(rootAgent.nativeSessionId,'root-thread');
  assert.equal(rootAgent.error,initialError);
  assert.equal(session.output,'root-answer');
  const childEvents=store.events({projectId:project.id,limit:100}).filter(x=>x.type==='agent.native');
  assert.equal(childEvents.length,2);
  assert.ok(childEvents.every(e=>e.nativeEvent.nativeSubagent));
});
