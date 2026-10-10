import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter } from '../runtime/agents/codex.mjs';

function fixture() {
  const events=[], approvals=[], responses=[], rejections=[];
  const adapter=new CodexAdapter({
    provider:'codex',cwd:process.cwd(),
    onEvent:event=>events.push(event),
    onApproval:async (request)=>{
      approvals.push(request);
      return {optionId:'accept'};
    }
  });
  adapter.sessionId='main-thread';
  adapter.turnId='main-turn';
  adapter.state='running';
  adapter.active={resolve(){throw Error('Subagent completed parent turn')},reject(){throw Error('Subagent failed parent turn')}};
  adapter.transport={
    respond:(id,result)=>responses.push({id,result}),
    respondError:(id,code,message)=>rejections.push({id,code,message})
  };
  return {adapter,events,approvals,responses,rejections};
}
// CommandExecutionRequestApprovalParams of the stable protocol: no availableDecisions.
const approved=(id,threadId,turnId)=>({
  id,method:'item/commandExecution/requestApproval',
  params:{threadId,turnId,itemId:'item-'+id,startedAtMs:1,command:'npm test'}
});

test('documented child thread parent relation permits scoped approval and leaves parent turn active',async()=>{
  const f=fixture();
  await f.adapter.handle({method:'thread/started',params:{
    thread:{id:'child-thread',parentThreadId:'main-thread'}
  }});
  await f.adapter.handle({method:'turn/started',params:{
    threadId:'child-thread',turn:{id:'child-turn'}
  }});
  await f.adapter.handle(approved(77,'child-thread','child-turn'));
  assert.equal(f.approvals.length,1);
  assert.equal(f.approvals[0].threadId,'child-thread');
  assert.equal(f.approvals[0].turnId,'child-turn');
  assert.deepEqual(f.responses,[{id:77,result:{decision:'accept'}}]);
  await f.adapter.handle({method:'turn/completed',params:{
    threadId:'child-thread',turn:{id:'child-turn',status:'completed'}
  }});
  assert.equal(f.adapter.turnId,'main-turn');
  assert.notEqual(f.adapter.active,null);
  assert.ok(f.events.some(e=>e.nativeThreadId==='child-thread'));
});

test('unrelated thread cannot use the main session approval authority',async()=>{
  const f=fixture();
  await f.adapter.handle(approved(8,'foreign-thread','unknown-turn'));
  assert.equal(f.approvals.length,0);
  assert.equal(f.responses.length,0);
  assert.equal(f.rejections[0].code,-32602);
  await f.adapter.handle({method:'thread/started',params:{
    thread:{id:'foreign-thread',parentThreadId:'another-session'}
  }});
  await f.adapter.handle(approved(9,'foreign-thread','unknown-turn'));
  assert.equal(f.approvals.length,0);
  assert.equal(f.rejections.length,2);
});

test('official collabAgentToolCall item identifies bounded receiver threads',async()=>{
  const f=fixture();
  await f.adapter.handle({method:'item/completed',params:{
    threadId:'main-thread',turnId:'main-turn',
    item:{type:'collabAgentToolCall',senderThreadId:'main-thread',
      receiverThreadIds:['collab-child'],status:'completed',tool:'spawnAgent'}
  }});
  await f.adapter.handle({method:'turn/started',params:{
    threadId:'collab-child',turn:{id:'subturn'}
  }});
  await f.adapter.handle(approved(27,'collab-child','subturn'));
  assert.equal(f.approvals.length,1);
  await f.adapter.handle({method:'thread/closed',params:{threadId:'collab-child'}});
  await f.adapter.handle(approved(28,'collab-child','subturn'));
  assert.equal(f.rejections.at(-1).code,-32602);
});

test('approval options are the stable protocol decisions, whatever an experimental server field lists',async()=>{
  const f=fixture();
  const request=approved(31,'main-thread','main-turn');
  request.params.availableDecisions=['accept',{acceptWithExecpolicyAmendment:{execpolicy_amendment:['rm','-rf']}}];
  await f.adapter.handle(request);
  assert.deepEqual(f.approvals[0].options.map(option=>option.optionId),['accept','acceptForSession','decline','cancel']);
  assert.ok(f.approvals[0].options.every(option=>typeof option.name==='string'&&option.name));
  assert.equal(f.approvals[0].summary,'Run: npm test');
  assert.deepEqual(f.responses,[{id:31,result:{decision:'accept'}}]);
});

test('child approval with stale/unknown turn fails closed',async()=>{
  const f=fixture();
  await f.adapter.handle({method:'thread/started',params:{thread:{
    id:'child-thread',parentThreadId:'main-thread'
  }}});
  await f.adapter.handle(approved(19,'child-thread','unadvertised-turn'));
  assert.equal(f.approvals.length,0);
  assert.equal(f.rejections[0].code,-32602);
});
