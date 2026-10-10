import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { JsonProcess, agentEnvironment, agentVersion } from '../runtime/agents/common.mjs';
import { createAgentAdapter, inspectAgentProvider, resolveAgentCommand } from '../runtime/agents/index.mjs';
import { normalizeConfig } from '../runtime/config.mjs';

// One stand-in executable for every provider CLI. It answers --version and
// "codex mcp list --json" like the real tools and never talks to a model.
const fixture = String.raw`
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
const argv=process.argv.slice(1);
const pinned=argv.find(x=>x.startsWith('--fixture-version='));
if(argv.includes('--version')){console.log(pinned?pinned.split('=')[1]:'9.9.9 (fixture)');process.exit(0);}
const provider=process.env.FIXTURE_PROVIDER, mode=process.env.FIXTURE_MODE;
const out=x=>process.stdout.write(JSON.stringify(x)+'\n');
const result=(id,value)=>out(provider==='codex'?{id,result:value}:{jsonrpc:'2.0',id,result:value});
// After a scenario the adapter answers by closing the process, leave by ourselves: the
// behaviour under test is the refusal, not how long a forced stop takes.
const leave=()=>setTimeout(()=>process.exit(0),30);
if(provider==='codex'&&argv.includes('mcp')){
  if(argv.slice(-3).join(' ')!=='mcp list --json')process.exit(30);
  if(mode==='mcp-list-fails'){process.stderr.write('config.toml is invalid',()=>process.exit(3));}
  else {console.log(process.env.FIXTURE_MCP||'[]');process.exit(0);}
  await new Promise(()=>{});
}
let initialized=false,promptId,turn='turn-1',mcpChild;
const finish=()=> {
 if(provider==='codex')out({method:'turn/completed',params:{threadId:'native-session',turn:{id:turn,status:'completed'}}});
 else result(promptId,{stopReason:'end_turn'});
};
if(provider==='claude') {
 let text=''; for await (const chunk of process.stdin) text+=chunk;
 const args=argv, value=name=>args[args.indexOf(name)+1];
 if(value('--permission-mode')!=='manual'||args.includes('--strict-mcp-config')===(mode==='inherit-mcp'))process.exit(20);
 if(args.some(x=>x.includes('skip-permissions')||x==='--always-approve'))process.exit(21);
 // The bridge credential belongs to the permission server, not to Claude and its commands.
 if(process.env.DEVMATE_AGENT_APPROVAL_TOKEN)process.exit(29);
 if(mode==='native-features'){
  const settingsIndex=args.indexOf('--settings');
  if(settingsIndex<0||JSON.parse(args[settingsIndex+1]).crossSessionInbound!=='accept'
    ||process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS!=='1')process.exit(28);
 }
 const configFile=value('--mcp-config');
 const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
 out({type:'system',subtype:'init',session_id:'native-session'});
 if(mode==='report')out({type:'fixture_launch',argv:args,env:process.env,configFile,config});
 if(mode==='exit')process.exit(7);
 if(mode==='quota'){out({type:'result',subtype:'success',is_error:true,session_id:'native-session',result:'Weekly usage limit reached'});process.exit(1);}
 if(mode==='stderr-exit'){process.stderr.write('Invalid API key\nPlease run /login\n',()=>process.exit(1));await new Promise(()=>{});}
 if(mode==='cancel-partial'){
  out({type:'stream_event',session_id:'native-session',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'half an answer'}}});
  process.stdout.write('{"type":"assistant","message":{"content":[{"type":"te');
  setInterval(()=>{},1000);
 }
 else if(mode==='streams'){
  for(let i=0;i<6;i++)out({type:'stream_event',session_id:'native-session',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'think '}}});
  for(let i=0;i<6;i++)out({type:'stream_event',session_id:'native-session',event:{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"a":'}}});
  out({type:'stream_event',session_id:'native-session',event:{type:'content_block_delta',index:2,delta:{type:'text_delta',text:'answer'}}});
  out({type:'result',subtype:'success',is_error:false,session_id:'native-session',result:'answer'});
 }
 else if(mode==='pending'){setInterval(()=>{},1000);}
 else {
  if(mode==='mcp'&&(!config.mcpServers.channel||!args.includes('--model=fixture-model')))process.exit(22);
  const spec=config.mcpServers.devmate_approval;
  mcpChild=spawn(spec.command,spec.args,{stdio:['pipe','pipe','inherit'],env:{...process.env,...spec.env}});
  const lines=readline.createInterface({input:mcpChild.stdout});
  const send=x=>mcpChild.stdin.write(JSON.stringify(x)+'\n');
  let decision;
  lines.on('line',line=>{
    const m=JSON.parse(line);
    if(m.id===1){
      send({jsonrpc:'2.0',method:'notifications/initialized'});
      send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'decide',arguments:{tool_name:'Write',input:{file_path:'safe.txt',content:text}}}});
      // Claude gives up on the permission tool: its server and the bridge connection go away.
      if(mode==='bridge-drop')setTimeout(()=>mcpChild.kill(),400);
    }
    if(m.id===2){
      decision=JSON.parse(m.result.content[0].text);
      out({type:'stream_event',session_id:'native-session',event:{delta:{type:'text_delta',text:decision.behavior}}});
      out({type:'result',subtype:'success',is_error:false,session_id:'native-session',result:decision.behavior});
      mcpChild.stdin.end();
    }
  });
  mcpChild.on('close',code=>{
    if(mode!=='bridge-drop')return process.exit(decision?0:code||23);
    setTimeout(()=>{out({type:'result',subtype:'success',is_error:false,session_id:'native-session',result:'continued without permission'});process.exit(0);},700);
  });
  send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}}});
 }
} else {
 if(provider==='codex')out({method:'fixture/launch',params:{argv,env:process.env}});
 const rl=readline.createInterface({input:process.stdin});
 rl.on('line',line=>{
  const m=JSON.parse(line),p=m.params||{};
  // The app-server envelope has no "jsonrpc" member in either direction.
  if(provider==='codex'&&'jsonrpc' in m)process.exit(26);
  if(m.method==='initialize'){
    if(provider==='codex'){if(p.capabilities?.experimentalApi)process.exit(27);result(m.id,{userAgent:'fixture'});}
    else {initialized=true;result(m.id,{protocolVersion:1,agentCapabilities:{loadSession:mode!=='no-resume'},authMethods:[{id:'cached_token',name:'Cached login'}]});}
  } else if(m.method==='initialized')initialized=true;
  else if(m.method==='authenticate')result(m.id,{});
  else if(['thread/start','thread/resume','session/new','session/load'].includes(m.method)){
    if(!initialized)process.exit(24);
    if(mode==='rpc-error'){out({id:m.id,error:{code:-32000,message:'Authentication required'}});leave();return;}
    if(provider==='codex')out({method:'fixture/thread',params:{method:m.method,request:p}});
    if(mode==='mcp'){
      if(provider==='codex'&&(p.approvalPolicy!=='on-request'||p.approvalsReviewer!=='user'||p.sandbox!=='workspace-write'||argv.includes('mcp_servers={}')))throw Error('Invalid native Codex config');
      if(provider!=='codex'&&(!argv.includes('--model=fixture-model')||argv.includes('--model')))process.exit(31);
      const servers=provider==='codex'?p.config?.mcp_servers:p.mcpServers;
      if(provider==='codex'?!servers?.channel?.enabled:!servers?.some(x=>x.name==='channel'))process.exit(25);
    }
    const modes=mode==='no-modes'?undefined:mode==='unknown-modes'?{currentModeId:'turbo',availableModes:[{id:'turbo',name:'Turbo'},{id:'yolo',name:'YOLO'}]}
      :mode==='set-mode'?{currentModeId:'yolo',availableModes:[{id:'yolo',name:'YOLO'},{id:'default',name:'Default'}]}
      :{currentModeId:'ask',availableModes:[{id:'ask',name:'Ask'}]};
    result(m.id,provider==='codex'?{thread:{id:'native-session',cwd:p.cwd},model:'fixture-model'}:{sessionId:'native-session',...(modes?{modes}:{})});
    if(['no-modes','unknown-modes'].includes(mode))leave();
  } else if(m.method==='session/set_mode'){
    out({jsonrpc:'2.0',method:'fixture/setMode',params:{modeId:p.modeId}});result(m.id,{});
  } else if(m.method==='mcpServerStatus/list'){
    if(mode==='no-mcp-status'){out({id:m.id,error:{code:-32601,message:'Method not found'}});return;}
    if(p.threadId!=='native-session')process.exit(32);
    result(m.id,{data:JSON.parse(process.env.FIXTURE_MCP_STATUS||'[]'),nextCursor:null});
    if(process.env.FIXTURE_LEAVE_AFTER_STATUS)leave();
  } else if(m.method==='turn/start'||m.method==='session/prompt'){
    promptId=m.id;
    if(provider==='codex')result(m.id,{turn:{id:turn,status:'inProgress'}});
    if(provider==='codex' && (mode==='subagent'||mode==='subagent-nested')) {
      out({method:'thread/started',params:{thread:{id:'child-thread',parentThreadId:'native-session'}}});
      out({method:'turn/started',params:{threadId:'child-thread',turn:{id:'child-turn',status:'inProgress'}}});
      out({method:'item/agentMessage/delta',params:{threadId:'child-thread',turnId:'child-turn',delta:'child-progress'}});
      out({id:703,method:'item/commandExecution/requestApproval',params:{threadId:'foreign-thread',turnId:'foreign-turn',itemId:'foreign',command:'not-ours'}});
      if(mode==='subagent-nested'){
        out({method:'thread/started',params:{thread:{id:'grandchild-thread',parentThreadId:'child-thread'}}});
        out({method:'turn/started',params:{threadId:'grandchild-thread',turn:{id:'grandchild-turn',status:'inProgress'}}});
        out({method:'item/agentMessage/delta',params:{threadId:'grandchild-thread',turnId:'grandchild-turn',delta:'nested-progress'}});
        out({id:704,method:'item/commandExecution/requestApproval',params:{threadId:'grandchild-thread',turnId:'grandchild-turn',itemId:'grandchild',command:'nested-safe'}});
      } else {
        out({id:702,method:'item/commandExecution/requestApproval',params:{threadId:'child-thread',turnId:'child-turn',itemId:'child',command:'safe'}});
      }
      return;
    }
    if(provider==='codex' && mode==='subagent-late') {
      out({method:'thread/started',params:{thread:{id:'child-thread',parentThreadId:'native-session'}}});
      out({method:'turn/started',params:{threadId:'child-thread',turn:{id:'child-turn',status:'inProgress'}}});
      out({method:'turn/completed',params:{threadId:'child-thread',turn:{id:'child-turn',status:'completed'}}});
      out({id:707,method:'item/commandExecution/requestApproval',params:{
        threadId:'child-thread',turnId:'child-turn',itemId:'late-child',command:'must-not-run'
      }});
      return;
    }
    if(provider==='codex' && mode==='collab-spawn') {
      out({method:'item/started',params:{threadId:'native-session',turnId:turn,
        item:{type:'collabAgentToolCall',id:'spawn-tool',tool:'spawnAgent',
          status:'inProgress',senderThreadId:'native-session',
          receiverThreadIds:['spawned-child'],agentsStates:{}}}});
      out({method:'turn/started',params:{threadId:'spawned-child',turn:{id:'spawned-turn',status:'inProgress'}}});
      out({id:706,method:'item/commandExecution/requestApproval',params:{
        threadId:'spawned-child',turnId:'spawned-turn',itemId:'spawned-safe',
        command:'native-spawned-command'
      }});
      return;
    }
    if(provider==='codex' && mode==='post-turn-approval') {
      out({method:'turn/completed',params:{threadId:'native-session',turn:{id:turn,status:'completed'}}});
      out({id:705,method:'item/commandExecution/requestApproval',params:{
        threadId:'native-session',turnId:turn,itemId:'after-finish',command:'must-be-denied'
      }});
      return;
    }
    if(provider==='codex' && (mode==='final-answer'||mode==='last-message')) {
      const phase=name=>mode==='final-answer'?{phase:name}:{};
      const say=(id,text,name)=>{
        out({method:'item/agentMessage/delta',params:{threadId:'native-session',turnId:turn,itemId:id,delta:text}});
        out({method:'item/completed',params:{threadId:'native-session',turnId:turn,completedAtMs:1,item:{type:'agentMessage',id,text,...phase(name)}}});
      };
      say('m1','I will look at the tests first. ','commentary');
      for(let i=0;i<30;i++)out({method:'item/commandExecution/outputDelta',params:{threadId:'native-session',turnId:turn,itemId:'c1',delta:'ok '+i+'\n'}});
      for(let i=0;i<20;i++)out({method:'item/reasoning/textDelta',params:{threadId:'native-session',turnId:turn,itemId:'r1',contentIndex:0,delta:'hm '}});
      say('m2','All 12 tests pass.','final_answer');
      if(mode==='final-answer')say('m3','(notes for myself)','commentary');
      setTimeout(finish,20);
      return;
    }
    if(provider==='codex' && mode==='retry-error') {
      out({method:'error',params:{threadId:'native-session',turnId:turn,willRetry:true,error:{message:'stream disconnected, retrying 1/5'}}});
      out({method:'item/completed',params:{threadId:'native-session',turnId:turn,completedAtMs:1,item:{type:'agentMessage',id:'m1',text:'recovered'}}});
      setTimeout(finish,20);
      return;
    }
    if(provider==='codex' && mode==='file-approval') {
      out({method:'item/started',params:{threadId:'native-session',turnId:turn,startedAtMs:1,item:{type:'fileChange',id:'patch-1',status:'inProgress',
        changes:[{path:'src/app.js',kind:{type:'update'},diff:'@@'},{path:'README.md',kind:{type:'add'},diff:'+x'}]}}});
      out({id:700,method:'item/fileChange/requestApproval',params:{threadId:'native-session',turnId:turn,itemId:'patch-1',startedAtMs:1,reason:'outside the sandbox'}});
      return;
    }
    if(provider==='codex' && mode==='user-input') {
      out({id:700,method:'item/tool/requestUserInput',params:{threadId:'native-session',turnId:turn,itemId:'q1',isBlocking:true,
        questions:[{id:'db',header:'Database',question:'Which database should the migration target?'}]}});
      return;
    }
    if(provider!=='codex' && ['refusal','max_tokens','max_turn_requests','strange'].includes(mode)) {
      out({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'partial words'}}}});
      result(promptId,{stopReason:mode});
      return;
    }
    if(provider!=='codex' && mode==='answer') {
      const update=u=>out({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native-session',update:u}});
      update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'thinking'}});
      update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Let me check the files. '}});
      update({sessionUpdate:'tool_call',toolCallId:'t1',title:'Read package.json',status:'pending'});
      update({sessionUpdate:'tool_call_update',toolCallId:'t1',status:'completed'});
      update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'There are '}});
      update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'3 scripts.'}});
      setTimeout(finish,20);
      return;
    }
    if(mode==='exit')process.exit(9);
    if(mode==='invalid'){process.stdout.write('not-json\n');leave();return;}
    if(mode==='pending'||mode==='cancel-late-approval')return;
    if(mode==='approval'||mode==='cancel-approval') {
      out(provider==='codex'?{id:700,method:'item/commandExecution/requestApproval',params:{threadId:'native-session',turnId:turn,itemId:'cmd',command:'npm test',cwd:'/work',reason:'needs network'}}:{jsonrpc:'2.0',id:700,method:'session/request_permission',params:{sessionId:'native-session',toolCall:{toolCallId:'cmd',title:'Run npm test',locations:[{path:'package.json'}]},options:[{optionId:'yes',kind:'allow_once',name:'Allow'},{optionId:'no',kind:'reject_once',name:'Deny'}]}});
      return;
    }
    out(provider==='codex'?{method:'item/agentMessage/delta',params:{threadId:'native-session',turnId:turn,delta:'hello'}}:{jsonrpc:'2.0',method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'hello'}}}});
    setTimeout(finish,20);
  } else if(m.id===700 && !m.method) {
    out(provider==='codex'?{method:'fixture/approval',params:{decision:m.result}}:{jsonrpc:'2.0',method:'fixture/approval',params:{decision:m.result}});
    if(mode!=='cancel-approval')finish();
  } else if(m.id===702 && !m.method) {
    out({method:'fixture/childDecision',params:{decision:m.result}});
    out({method:'turn/completed',params:{threadId:'child-thread',turn:{id:'child-turn',status:'completed'}}});
    setTimeout(finish,30);
  } else if(m.id===703 && !m.method) {
    out({method:'fixture/foreignDecision',params:{error:m.error,decision:m.result}});
  } else if(m.id===704 && !m.method) {
    out({method:'fixture/grandchildDecision',params:{decision:m.result}});
    out({method:'turn/completed',params:{threadId:'grandchild-thread',turn:{id:'grandchild-turn',status:'completed'}}});
    out({method:'turn/completed',params:{threadId:'child-thread',turn:{id:'child-turn',status:'completed'}}});
    setTimeout(finish,30);
  } else if(m.id===720 && !m.method) {
    out({method:'fixture/lateDecision',params:{decision:m.result}});
    out({method:'turn/completed',params:{threadId:'native-session',turn:{id:turn,status:'interrupted'}}});
  } else if(m.id===705 && !m.method) {
    out({method:'fixture/postTurnDecision',params:{decision:m.result,error:m.error}});
  } else if(m.id===706 && !m.method) {
    out({method:'fixture/spawnDecision',params:{decision:m.result,error:m.error}});
    setTimeout(finish,20);
  } else if(m.id===707 && !m.method) {
    out({method:'fixture/staleChildDecision',params:{decision:m.result,error:m.error}});
    setTimeout(finish,20);
  } else if(m.method==='turn/steer'){result(m.id,{turnId:p.expectedTurnId});}
  else if(m.method==='turn/interrupt'){
    result(m.id,{});
    if(mode==='cancel-late-approval'){
      out({id:720,method:'item/commandExecution/requestApproval',params:{
        threadId:'native-session',turnId:turn,itemId:'late-command',command:'must-not-run'
      }});
      return;
    }
    out({method:'turn/completed',params:{threadId:'native-session',turn:{id:turn,status:'interrupted'}}});
  } else if(m.method==='session/cancel')result(promptId,{stopReason:'cancelled'});
 });
}
`;

const stub=(...extra)=>({file:process.execPath,args:['--input-type=module','-e',fixture,'--',...extra]});
async function setup(t, provider, mode='success', extra={}) {
  const cwd=await mkdtemp(path.join(tmpdir(),'devmate-native-agent-'));
  const events=[];
  const {env,...options}=extra;
  const adapter=createAgentAdapter({
    provider,cwd,command:stub(),
    env:{FIXTURE_PROVIDER:provider,FIXTURE_MODE:mode,...env},onEvent:event=>events.push(event),requestTimeoutMs:3000,...options
  });
  // The stand-in has no child tree to clean up; ending it directly spares the graceful-stop wait.
  t.after(async()=>{adapter.transport?.proc?.kill();await adapter.close();await rm(cwd,{recursive:true,force:true});});
  return {adapter,events,cwd};
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const channel={name:'channel',command:process.execPath,args:['host-channel.mjs'],env:{BOUND_AGENT:'one'}};
for(const provider of ['codex','claude','gemini','grok']) {
  test(provider+' preserves native events, session and host MCP injection',async t=>{
    const {adapter,events}=await setup(t,provider,'mcp',{mcpServers:[channel]});
    const start=await adapter.start({model:'fixture-model'});
    assert.equal(start.sessionId,provider==='claude'?null:'native-session');
    const done=await adapter.send({text:'hello $(must-stay-data) & no-shell'});
    assert.equal(done.status,'completed');
    assert.equal(done.sessionId,'native-session');
    assert.ok(events.some(e=>e.type==='message'&&e.native));
    assert.equal(adapter.state,'ready');
  });
  test(provider+' refuses a model name that could be read as a command-line option',async t=>{
    for(const model of ['--dangerously-skip-permissions','-m','a b','x;y','']) {
      const {adapter}=await setup(t,provider);
      await assert.rejects(adapter.start({model}),{code:'invalid_input'},JSON.stringify(model));
    }
  });
}
for(const provider of ['codex','gemini','grok']) {
  test(provider+' explicit approval only, with exact native choice',async t=>{
    const requests=[];
    const {adapter,events}=await setup(t,provider,'approval',{onApproval:async request=>{
      assert.equal(request.cwd,adapter.cwd);requests.push(request);
      return {optionId:provider==='codex'?'accept':'yes'};
    }});
    await adapter.start();await adapter.send({text:'test'});
    assert.ok(events.some(e=>e.type==='approval'));
    const approval=events.find(e=>e.native?.method==='fixture/approval').native.params.decision;
    if(provider==='codex'){
      assert.equal(approval.decision,'accept');
      // The stable protocol does not send availableDecisions: the options are its documented decisions.
      assert.deepEqual(requests[0].options.map(option=>option.optionId),['accept','acceptForSession','decline','cancel']);
      assert.equal(requests[0].summary,'Run: npm test (in /work) — needs network');
    } else {
      assert.equal(approval.outcome.optionId,'yes');
      assert.equal(requests[0].summary,'Run npm test (package.json)');
    }
  });
  test(provider+' rejects concurrent send and confirms cancellation',async t=>{
    const {adapter}=await setup(t,provider,'pending');
    await adapter.start();
    const turn=adapter.send({text:'wait'});
    await assert.rejects(adapter.send({text:'second'}),{code:'agent_busy'});
    if(provider==='codex')assert.equal((await adapter.steer({text:'more'})).turnId,'turn-1');
    else await assert.rejects(adapter.steer({text:'more'}),{code:'unsupported_capability'});
    await adapter.cancel();
    assert.equal((await turn).status,'interrupted');
  });
  test(provider+' cancels pending approval and ignores a late allow',async t=>{
    let resolveChoice,notify;
    const requested=new Promise(resolve=>notify=resolve);
    const {adapter,events}=await setup(t,provider,'cancel-approval',{onApproval:(_request,{signal})=>{
      notify(signal);return new Promise(resolve=>resolveChoice=resolve);
    }});
    await adapter.start();const turn=adapter.send({text:'approve later'});
    const signal=await requested;await adapter.cancel();await turn;
    assert.equal(signal.aborted,true);
    resolveChoice({optionId:provider==='codex'?'accept':'yes'});
    await new Promise(resolve=>setTimeout(resolve,30));
    const sent=events.find(e=>e.native?.method==='fixture/approval')?.native.params.decision;
    if(provider==='codex')assert.equal(sent?.decision,'decline');
    else assert.equal(sent?.outcome.outcome,'cancelled');
  });
  test(provider+' reports unexpected child exit without retry',async t=>{
    const {adapter,events}=await setup(t,provider,'exit');await adapter.start();
    await assert.rejects(adapter.send({text:'start'}),{code:'process_exited'});
    assert.equal(adapter.state,'disconnected');
    // One event carries the state together with the reason the process went away.
    const gone=events.filter(e=>e.type==='state'&&e.state==='disconnected'&&e.exit);
    assert.equal(gone.length,1);assert.equal(gone[0].exit.code,9);
    await assert.rejects(adapter.send({text:'replay'}),{code:'agent_not_ready'});
  });
  test(provider+' fails closed on malformed protocol',async t=>{
    const {adapter}=await setup(t,provider,'invalid');await adapter.start();
    await assert.rejects(adapter.send({text:'start'}),{code:'protocol_error'});
  });
  test(provider+' surfaces native RPC error',async t=>{
    const {adapter}=await setup(t,provider,'rpc-error');
    await assert.rejects(adapter.start(),{code:'rpc_error'});
  });
}
test('ACP does not call unadvertised resume',async t=>{
  const {adapter}=await setup(t,'gemini','no-resume');
  await assert.rejects(adapter.start({sessionId:'native-session'}),{code:'unsupported_capability'});
});
test('ACP runs only in an advertised manual approval mode and refuses anything else',async t=>{
  for(const mode of ['no-modes','unknown-modes']) {
    const {adapter}=await setup(t,'gemini',mode);
    await assert.rejects(adapter.start(),{code:'unsafe_permission_mode'},mode);
    assert.equal(adapter.state,'closed');
  }
  const {adapter,events}=await setup(t,'grok','set-mode');
  await adapter.start();
  assert.equal(events.find(e=>e.native?.method==='fixture/setMode').native.params.modeId,'default');
});
test('ACP reports refusal and limit stop reasons as a failed turn, not a completed one',async t=>{
  for(const [mode,pattern] of [['refusal',/refused/],['max_tokens',/token limit/],['max_turn_requests',/limit of model requests/],['strange',/unknown stop reason: strange/]]) {
    const {adapter}=await setup(t,'gemini',mode);
    await adapter.start();
    await assert.rejects(adapter.send({text:'go'}),error=>{
      assert.equal(error.code,'turn_failed',mode);assert.match(error.message,pattern);
      assert.equal(error.details.stopReason,mode);assert.equal(error.details.text,'partial words');return true;
    });
    assert.equal(adapter.state,'ready','the session itself is still usable');
  }
});
test('ACP answer is what the agent wrote after its last tool call; thoughts are not message text',async t=>{
  const {adapter,events}=await setup(t,'gemini','answer');
  await adapter.start();
  const done=await adapter.send({text:'how many scripts'});
  assert.equal(done.status,'completed');assert.equal(done.text,'There are 3 scripts.');
  assert.deepEqual(events.filter(e=>e.delta).map(e=>e.type),['reasoning','message','message','message']);
  assert.ok(events.some(e=>e.type==='tool'&&e.itemId==='t1'&&e.status==='completed'));
});
test('Claude uses real MCP SDK permission tool, approved exact input and resume',async t=>{
  const requests=[];
  const {adapter}=await setup(t,'claude','success',{onApproval:async request=>{
    assert.equal(request.kind,'Write');assert.equal(request.details.content,'first');requests.push(request);return {optionId:'allow'};
  }});
  await adapter.start({sessionId:'native-session'});
  assert.equal((await adapter.send({text:'first'})).text,'allow');
  assert.equal(requests[0].summary,'Write: safe.txt');
});
test('Claude absent approval handler denies, without permission bypass flags',async t=>{
  const {adapter}=await setup(t,'claude');await adapter.start();
  assert.equal((await adapter.send({text:'deny this'})).text,'deny');
});
test('Claude abrupt exit is an error, not success',async t=>{
  const {adapter}=await setup(t,'claude','exit');await adapter.start();
  await assert.rejects(adapter.send({text:'start'}),{code:'process_exited'});
});
test('Claude failure carries the last lines the CLI wrote to stderr',async t=>{
  const {adapter}=await setup(t,'claude','stderr-exit');await adapter.start();
  await assert.rejects(adapter.send({text:'start'}),error=>{
    assert.equal(error.code,'process_exited');
    assert.equal(error.message,'Claude exited with code 1: Invalid API key | Please run /login');
    assert.match(error.details.stderr,/Invalid API key/);return true;
  });
});
test('a cancelled Claude turn is reported as interrupted even when the killed process left half a line',async t=>{
  const {adapter,events}=await setup(t,'claude','cancel-partial');await adapter.start();
  const turn=adapter.send({text:'long task'});
  for(let i=0;i<200&&!events.some(e=>e.text==='half an answer');i++)await delay(20);
  assert.deepEqual(await adapter.cancel(),{requested:true});
  const result=await turn;
  assert.equal(result.status,'interrupted');
  assert.equal(result.outcome,undefined,'the process tree was terminated: the cancellation is confirmed');
  assert.equal(adapter.state,'ready');
});
test('Claude gets its MCP credentials through a private file, loads only user settings and inherits no secrets',async t=>{
  const privateDir=await mkdtemp(path.join(tmpdir(),'devmate-claude-private-'));
  t.after(()=>rm(privateDir,{recursive:true,force:true}));
  const secret='channel-token-must-not-be-on-argv';
  const saved={...process.env};
  Object.assign(process.env,{ANTHROPIC_API_KEY:'sk-ant-owner',OPENAI_API_KEY:'sk-openai-owner',CLOUDFLARE_TUNNEL_TOKEN:'tunnel',DEVMATE_AGENT_TOKEN:'runtime',
    VSCODE_IPC_HOOK:'editor',MY_DATABASE_PASSWORD:'hunter2',HTTPS_PROXY:'http://proxy.test:8080',CLAUDE_CONFIG_DIR:'C:/claude-home'});
  t.after(()=>{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);});
  const {adapter,events}=await setup(t,'claude','report',{privateDir,env:{PROJECT_FLAG:'mapped'},
    mcpServers:[{name:'devmate',command:process.execPath,args:['channel.mjs'],env:{DEVMATE_AGENT_TOKEN:secret}}]});
  await adapter.start({model:'opus[1m]'});
  assert.equal((await adapter.send({text:'report'})).status,'completed');
  const launch=events.find(e=>e.native?.type==='fixture_launch').native;
  assert.equal(launch.argv.some(arg=>arg.includes(secret)),false,'the channel token is not visible in a process listing');
  assert.equal(launch.argv.some(arg=>arg.includes('DEVMATE_AGENT_APPROVAL_TOKEN')),false);
  assert.equal(launch.config.mcpServers.devmate.env.DEVMATE_AGENT_TOKEN,secret);
  assert.match(launch.config.mcpServers.devmate_approval.env.DEVMATE_AGENT_APPROVAL_TOKEN,/^[a-f0-9]{64}$/);
  assert.ok(path.resolve(launch.configFile).startsWith(path.resolve(privateDir)+path.sep),'the file lives in the private directory it was given');
  assert.equal(fs.existsSync(launch.configFile),false,'the file is removed when the process has exited');
  assert.deepEqual(fs.readdirSync(privateDir),[]);
  assert.equal(launch.argv[launch.argv.indexOf('--setting-sources')+1],'user');
  assert.ok(launch.argv.includes('--model=opus[1m]'));
  for(const name of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','CLOUDFLARE_TUNNEL_TOKEN','DEVMATE_AGENT_TOKEN','VSCODE_IPC_HOOK','MY_DATABASE_PASSWORD'])
    assert.equal(launch.env[name],undefined,name+' must not reach the agent');
  assert.equal(launch.env.HTTPS_PROXY,'http://proxy.test:8080');
  assert.equal(launch.env.CLAUDE_CONFIG_DIR,'C:/claude-home');
  assert.equal(launch.env.PROJECT_FLAG,'mapped');
  assert.ok(launch.env.PATH||launch.env.Path);
});
test('Claude setting sources, API-key pass-through and inherited MCP servers are explicit provider settings',async t=>{
  const config=normalizeConfig({providers:{claude:{settingSources:['user','project'],inheritApiKeys:true,inheritMcpServers:true}}}).providers.claude;
  assert.deepEqual(normalizeConfig({providers:{claude:{}}}).providers.claude.settingSources,['user']);
  assert.equal(normalizeConfig({providers:{codex:{}}}).providers.codex.inheritApiKeys,false);
  assert.equal(normalizeConfig({providers:{codex:{}}}).providers.codex.inheritMcpServers,false);
  assert.throws(()=>normalizeConfig({providers:{claude:{settingSources:['enterprise']}}}));
  assert.throws(()=>normalizeConfig({providers:{claude:{settingSources:[]}}}));
  const saved=process.env.ANTHROPIC_API_KEY;process.env.ANTHROPIC_API_KEY='sk-ant-owner';
  t.after(()=>{if(saved===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=saved;});
  // The stand-in exits 20 unless --strict-mcp-config is present exactly when servers are not inherited.
  const inherit=await setup(t,'claude','inherit-mcp',{inheritMcpServers:config.inheritMcpServers});
  await inherit.adapter.start();
  assert.equal((await inherit.adapter.send({text:'inherit'})).text,'deny');
  const reported=await setup(t,'claude','report',{settingSources:config.settingSources,inheritApiKeys:config.inheritApiKeys});
  await reported.adapter.start();await reported.adapter.send({text:'report'});
  const launch=reported.events.find(e=>e.native?.type==='fixture_launch').native;
  assert.equal(launch.argv[launch.argv.indexOf('--setting-sources')+1],'user,project');
  assert.equal(launch.env.ANTHROPIC_API_KEY,'sk-ant-owner');
  await assert.rejects(createAgentAdapter({provider:'claude',cwd:reported.cwd,command:stub(),settingSources:['managed']}).start(),{code:'invalid_input'});
});
test('Claude Code older than the release with --permission-mode manual is refused with a clear message',async t=>{
  const cwd=await mkdtemp(path.join(tmpdir(),'devmate-native-agent-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const adapter=createAgentAdapter({provider:'claude',cwd,command:stub('--fixture-version=2.1.150 (Claude Code)'),env:{FIXTURE_PROVIDER:'claude'}});
  await assert.rejects(adapter.start(),error=>{
    assert.equal(error.code,'unsupported_version');assert.match(error.message,/2\.1\.150/);assert.match(error.message,/2\.1\.200 or newer/);return true;
  });
  const current=createAgentAdapter({provider:'claude',cwd,command:stub('--fixture-version=2.1.293 (Claude Code)'),env:{FIXTURE_PROVIDER:'claude'}});
  t.after(()=>current.close());
  assert.equal((await current.start()).capabilities.process,'per-turn');
});
test('a provider probe reports the installed version once and marks an outdated Claude unsupported',async()=>{
  const current=await inspectAgentProvider('claude',{command:stub('--fixture-version=2.1.293 (Claude Code)')});
  assert.deepEqual({status:current.status,version:current.version,minimumVersion:current.minimumVersion},{status:'installed',version:'2.1.293',minimumVersion:'2.1.200'});
  const old=await inspectAgentProvider('claude',{command:stub('--fixture-version=2.0.9')});
  assert.equal(old.status,'unsupported');assert.equal(old.error.code,'unsupported_version');
  const codex=await inspectAgentProvider('codex',{command:stub('--fixture-version=codex-cli 0.161.0')});
  assert.deepEqual({status:codex.status,version:codex.version,minimumVersion:codex.minimumVersion},{status:'installed',version:'0.161.0',minimumVersion:undefined});
  assert.equal((await inspectAgentProvider('gemini',{command:{file:path.join(tmpdir(),'no-such-agent.exe'),args:[]}})).status,'unavailable');
  const command=stub('--fixture-version=7.7.7');
  assert.equal(agentVersion(command),agentVersion(command),'the probe is cached per command');
  assert.equal((await inspectAgentProvider('grok',{command:'grok.cmd'})).status,'unavailable');
});
test('the Claude approval is withdrawn as soon as Claude stops waiting for the permission tool',async t=>{
  let notify;
  const requested=new Promise(resolve=>notify=resolve);
  const {adapter}=await setup(t,'claude','bridge-drop',{onApproval:(_request,{signal})=>{notify(signal);return new Promise(()=>{});}});
  await adapter.start();
  const turn=adapter.send({text:'needs a decision'});
  const signal=await requested;
  assert.equal(signal.aborted,false);
  await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
  assert.equal(adapter.state,'running','the request expired while the turn was still running, not only at process exit');
  assert.equal((await turn).text,'continued without permission');
});
test('the Claude permission tool waits on node:http, which has no five-minute header deadline',async t=>{
  const home=await mkdtemp(path.join(tmpdir(),'devmate-permission-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  // A fetch-based tool would inherit undici's 300 s headers timeout and answer "deny" by itself.
  const preload=path.join(home,'no-fetch.mjs');
  fs.writeFileSync(preload,"globalThis.fetch=()=>Promise.reject(new Error('fetch must not carry a pending approval'));");
  const {default:http}=await import('node:http');
  let received;
  const bridge=http.createServer((req,res)=>{
    const chunks=[];req.on('data',chunk=>chunks.push(chunk));
    req.on('end',()=>{received={auth:req.headers.authorization,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))};
      setTimeout(()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({behavior:'allow',updatedInput:{ok:true}}));},300);});
  });
  await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{bridge.closeAllConnections();bridge.close(resolve);}));
  const client=new Client({name:'permission-proof',version:'1.0.0'});
  t.after(()=>client.close().catch(()=>{}));
  await client.connect(new StdioClientTransport({command:process.execPath,
    args:['--import',pathToFileURL(preload).href,fileURLToPath(new URL('../runtime/agents/claude-permission-server.mjs',import.meta.url))],
    env:{...agentEnvironment(),DEVMATE_AGENT_APPROVAL_ENDPOINT:'http://127.0.0.1:'+bridge.address().port+'/permission',DEVMATE_AGENT_APPROVAL_TOKEN:'bridge-secret'}}));
  const answer=await client.callTool({name:'decide',arguments:{tool_name:'Bash',input:{command:'npm test'}}});
  assert.deepEqual(JSON.parse(answer.content[0].text),{behavior:'allow',updatedInput:{ok:true}});
  assert.equal(received.auth,'Bearer bridge-secret');assert.equal(received.body.tool_name,'Bash');
  bridge.removeAllListeners('request');
  bridge.on('request',(req,res)=>{req.resume();res.destroy();});
  const refused=await client.callTool({name:'decide',arguments:{tool_name:'Bash',input:{command:'rm -rf /'}}});
  assert.equal(JSON.parse(refused.content[0].text).behavior,'deny','a broken bridge never reads as permission');
});
test('Claude streams are typed: only answer text is message text, thinking and tool input are not',async t=>{
  const {adapter,events}=await setup(t,'claude','streams');await adapter.start();
  assert.equal((await adapter.send({text:'go'})).text,'answer');
  const deltas=events.filter(e=>e.delta&&e.type!=='diagnostic');
  assert.deepEqual([...new Set(deltas.map(e=>e.type+':'+e.itemId))],['reasoning:0','tool:1','message:2']);
});
test('input and launcher validation reject provider, relative root and shell wrappers',async()=>{
  assert.throws(()=>createAgentAdapter({provider:'other',cwd:process.cwd()}),{code:'unsupported_provider'});
  assert.throws(()=>createAgentAdapter({provider:'codex',cwd:'relative'}),{code:'invalid_input'});
  const adapter=createAgentAdapter({provider:'claude',cwd:process.cwd(),command:{file:'claude.cmd'}});
  await assert.rejects(adapter.start(),{code:'unsupported_launch'});
});

for (const action of ['cancel', 'close']) {
  test('Claude '+action+' before process startup never sends a prompt', async t => {
    const {adapter}=await setup(t,'claude');
    await adapter.start();
    const sending=adapter.send({text:'must not execute'});
    await adapter[action]();
    const result=await sending;
    assert.equal(result.status,'interrupted');
    assert.equal(result.outcome,'not_started');
    assert.equal(adapter.transport,undefined);
    assert.equal(adapter.state,action==='close'?'closed':'ready');
    assert.equal(adapter.bridge,null);
  });
}
test('closing a protocol process terminates its owned child tree',async t=>{
  let childPid,notify;
  const ready=new Promise(resolve=>notify=resolve);
  const transport=new JsonProcess({
    command:{file:process.execPath,args:['--input-type=module','-e',`import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.once('spawn',()=>process.stdout.write(JSON.stringify({pid:child.pid})+'\\n'));setInterval(()=>{},1000);`]},
    cwd:process.cwd(),onMessage:m=>{childPid=m.pid;notify();}
  });
  t.after(async()=>{await transport.close();if(childPid){try{process.kill(childPid,'SIGKILL');}catch{}}});
  await transport.start();await ready;await transport.close();
  let live=true;
  for(let i=0;i<30&&live;i++){try{process.kill(childPid,0);await new Promise(resolve=>setTimeout(resolve,20));}catch{live=false;}}
  assert.equal(live,false,'owned tool child must not survive close');
});
test('an agent process inherits an allow-list, never the runtime\'s whole environment',()=>{
  const source={Path:'C:/bin',USERPROFILE:'C:/Users/dev',APPDATA:'C:/Users/dev/AppData/Roaming',TEMP:'C:/tmp',https_proxy:'http://proxy:8080',NODE_EXTRA_CA_CERTS:'C:/ca.pem',
    LC_ALL:'en_US.UTF-8',JAVA_HOME:'C:/jdk',CODEX_HOME:'C:/codex',CLAUDE_CONFIG_DIR:'C:/claude',OPENAI_API_KEY:'sk-openai',ANTHROPIC_API_KEY:'sk-ant',
    GEMINI_API_KEY:'gm',XAI_API_KEY:'xai',TUNNEL_TOKEN:'t',CONTROL_PLANE_API_KEY:'c',DEVMATE_AGENT_TOKEN:'d',VSCODE_PID:'1',ELECTRON_RUN_AS_NODE:'1',GITHUB_TOKEN:'gh',
    NPM_TOKEN:'npm',AWS_SECRET_ACCESS_KEY:'aws',DATABASE_URL:'postgres://secret'};
  const codex=agentEnvironment('codex',{env:{EXTRA:'mapped'}},source);
  // The marker tells the devmate command line, run in the agent's own shell, that it speaks for a connected client.
  assert.deepEqual(Object.keys(codex).sort(),['APPDATA','CODEX_HOME','DEVMATE_CLIENT_COMMAND','EXTRA','JAVA_HOME','LC_ALL','NODE_EXTRA_CA_CERTS','Path','TEMP','USERPROFILE','https_proxy'].sort());
  assert.equal(codex.DEVMATE_CLIENT_COMMAND,'1');
  assert.equal(agentEnvironment('codex',{inheritApiKeys:true},source).OPENAI_API_KEY,'sk-openai');
  assert.equal(agentEnvironment('codex',{inheritApiKeys:true},source).ANTHROPIC_API_KEY,undefined,'only the provider\'s own account variables pass through');
  const claude=agentEnvironment('claude',{inheritApiKeys:true},source);
  assert.equal(claude.ANTHROPIC_API_KEY,'sk-ant');assert.equal(claude.AWS_SECRET_ACCESS_KEY,'aws');assert.equal(claude.CODEX_HOME,undefined);
  assert.equal(agentEnvironment('gemini',{inheritApiKeys:true},source).GEMINI_API_KEY,'gm');
  assert.equal(agentEnvironment('grok',{inheritApiKeys:true},source).XAI_API_KEY,'xai');
  for(const provider of ['codex','claude','gemini','grok'])for(const name of ['TUNNEL_TOKEN','CONTROL_PLANE_API_KEY','DEVMATE_AGENT_TOKEN','VSCODE_PID','ELECTRON_RUN_AS_NODE','GITHUB_TOKEN','NPM_TOKEN','DATABASE_URL'])
    assert.equal(agentEnvironment(provider,{inheritApiKeys:true},source)[name],undefined,provider+' '+name);
});

for(const provider of ['codex','claude','gemini','grok']) {
  test(provider+' closed during startup cannot resurrect or spawn',async t=>{
    const {adapter}=await setup(t,provider);
    const start=adapter.start();
    await adapter.close();
    await assert.rejects(start,{code:'agent_closed'});
    assert.equal(adapter.state,'closed');
    assert.equal(adapter.transport,undefined);
  });
}

test('discovery does not report an uninstalled CLI as installed',async()=>{
  const previous=process.env.PATH;
  process.env.PATH='';
  try { await assert.rejects(resolveAgentCommand('codex'),{code:'agent_not_installed'}); }
  finally { if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous; }
});

test('Claude structured final account error survives a nonzero process exit', async t => {
  const { adapter } = await setup(t, 'claude', 'quota');
  await adapter.start();
  await assert.rejects(adapter.send({ text: 'communication-only fixture' }), error => {
    assert.equal(error.code, 'turn_failed'); assert.equal(error.message, 'Weekly usage limit reached');
    assert.equal(error.details.is_error, true); return true;
  });
});

const ownerServers=JSON.stringify([
  {name:'rea',enabled:true,transport:{type:'stdio',command:'rea'}},
  {name:'jadx-headless-local',enabled:true,transport:{type:'stdio',command:'jadx'}},
  {name:'cua_repl',enabled:false,disabled_reason:'user',transport:{type:'stdio',command:'cua'}}
]);
test('a delegated Codex gets DevMate\'s MCP servers only: every configured server is switched off by name and the result is asserted',async t=>{
  const saved={OPENAI_API_KEY:process.env.OPENAI_API_KEY,CODEX_HOME:process.env.CODEX_HOME};
  Object.assign(process.env,{OPENAI_API_KEY:'sk-openai-owner',CODEX_HOME:'C:/codex-home'});
  t.after(()=>{for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;});
  const {adapter,events}=await setup(t,'codex','mcp',{mcpServers:[channel],env:{FIXTURE_MCP:ownerServers,
    FIXTURE_MCP_STATUS:JSON.stringify([{name:'channel',runtimeStatus:'connected',tools:{agent_peers:{}}},{name:'rea',runtimeStatus:'disabled',tools:{}},{name:'broken',runtimeStatus:'failed',tools:{}}])}});
  await adapter.start();
  const launch=events.find(e=>e.native?.method==='fixture/launch').native.params;
  assert.deepEqual(launch.argv,['app-server','-c','mcp_servers.rea.enabled=false','-c','mcp_servers.jadx-headless-local.enabled=false','-c','features.apps=false'],
    'enabled servers are disabled by name; an already disabled one is left alone');
  // A server of the owner's under the very name DevMate passes would be merged with it key by key: that is refused, with the way out.
  const clashing=await setup(t,'codex','mcp',{mcpServers:[channel],env:{FIXTURE_MCP:JSON.stringify([{name:'channel',enabled:true,transport:{type:'streamable_http',url:'http://127.0.0.1:8788/mcp'}}])}});
  await assert.rejects(clashing.adapter.start(),error=>error.code==='mcp_isolation_failed'&&/its own MCP server named "channel"/.test(error.message)&&/codex mcp remove channel/.test(error.message));
  assert.equal(clashing.adapter.transport,undefined,'no app-server is started');
  assert.equal(launch.env.OPENAI_API_KEY,undefined,'an exported API key does not reach the agent unless the provider asks for it');
  assert.equal(launch.env.CODEX_HOME,'C:/codex-home','the CLI still finds its own configuration and login');
  const thread=events.find(e=>e.native?.method==='fixture/thread').native.params;
  assert.equal(thread.method,'thread/start');assert.equal(thread.request.approvalsReviewer,'user');
  assert.deepEqual(thread.request.config.mcp_servers.channel,{command:process.execPath,args:['host-channel.mjs'],enabled:true,env:{BOUND_AGENT:'one'}});
});
test('Codex start fails closed when a server DevMate did not provide is still reachable, or when the servers cannot be listed',async t=>{
  const leaking=await setup(t,'codex','mcp',{mcpServers:[channel],env:{FIXTURE_MCP:'[]',FIXTURE_LEAVE_AFTER_STATUS:'1',
    FIXTURE_MCP_STATUS:JSON.stringify([{name:'channel',runtimeStatus:'connected',tools:{}},{name:'plugin_gmail',runtimeStatus:'connected',tools:{send:{}}},{name:'late',tools:{run:{}}}])}});
  await assert.rejects(leaking.adapter.start(),error=>{
    assert.equal(error.code,'mcp_isolation_failed');assert.deepEqual(error.details.servers,['plugin_gmail','late']);
    assert.match(error.message,/inheritMcpServers/);return true;
  });
  assert.equal(leaking.adapter.state,'closed');
  const unlisted=await setup(t,'codex','mcp-list-fails');
  await assert.rejects(unlisted.adapter.start(),error=>{
    assert.equal(error.code,'mcp_isolation_failed');assert.match(error.details.stderr,/config\.toml is invalid/);return true;
  });
  assert.equal(unlisted.adapter.transport,undefined,'no app-server is started without isolation');
  const odd=await setup(t,'codex','success',{env:{FIXTURE_MCP:JSON.stringify([{name:'has space',enabled:true}])}});
  await assert.rejects(odd.adapter.start(),{code:'mcp_isolation_failed'});
  const old=await setup(t,'codex','no-mcp-status',{env:{FIXTURE_MCP:ownerServers}});
  await old.adapter.start();
  assert.ok(old.events.some(e=>e.type==='diagnostic'&&/could not be verified/.test(e.text)),'an app-server without the status method is used with the overrides alone');
});
test('inheriting the owner\'s Codex MCP servers and API key is an explicit provider setting',async t=>{
  const saved=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='sk-openai-owner';
  t.after(()=>{if(saved===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=saved;});
  const {adapter,events}=await setup(t,'codex','mcp-list-fails',{inheritMcpServers:true,inheritApiKeys:true,mcpServers:[channel],
    env:{FIXTURE_MCP_STATUS:JSON.stringify([{name:'rea',runtimeStatus:'connected',tools:{open:{}}}])}});
  await adapter.start();
  const launch=events.find(e=>e.native?.method==='fixture/launch').native.params;
  assert.deepEqual(launch.argv,['app-server'],'nothing is listed or disabled when the owner opted in');
  assert.equal(launch.env.OPENAI_API_KEY,'sk-openai-owner');
});
test('Codex resumes a thread without its history and returns only the final answer of a turn',async t=>{
  const {adapter,events}=await setup(t,'codex','final-answer');
  await adapter.start({sessionId:'native-session'});
  const thread=events.find(e=>e.native?.method==='fixture/thread').native.params;
  assert.equal(thread.method,'thread/resume');assert.equal(thread.request.threadId,'native-session');
  assert.equal(thread.request.excludeTurns,true,'a long thread must not come back as one oversized line');
  const done=await adapter.send({text:'run the tests'});
  assert.equal(done.status,'completed');
  assert.equal(done.text,'All 12 tests pass.','commentary before and after the final answer is not part of it');
  assert.deepEqual([...new Set(events.filter(e=>e.delta&&e.type!=='diagnostic').map(e=>e.type+':'+e.nativeMethod+':'+e.itemId))],
    ['message:item/agentMessage/delta:m1','tool:item/commandExecution/outputDelta:c1','reasoning:item/reasoning/textDelta:r1','message:item/agentMessage/delta:m2','message:item/agentMessage/delta:m3']);
  const plain=await setup(t,'codex','last-message');
  await plain.adapter.start();
  assert.equal((await plain.adapter.send({text:'run the tests'})).text,'All 12 tests pass.','without a phase the last assistant message is the answer');
});
test('Codex file-change approvals and questions say what they are about',async t=>{
  const approvals=[],inputs=[];
  const file=await setup(t,'codex','file-approval',{onApproval:async request=>{approvals.push(request);return {optionId:'acceptForSession'};}});
  await file.adapter.start();await file.adapter.send({text:'edit'});
  assert.equal(approvals[0].summary,'Change src/app.js, README.md — outside the sandbox');
  assert.equal(file.events.find(e=>e.native?.method==='fixture/approval').native.params.decision.decision,'acceptForSession');
  const question=await setup(t,'codex','user-input',{onInput:async request=>{inputs.push(request);return {answers:{db:{answers:['postgres']}}};}});
  await question.adapter.start();await question.adapter.send({text:'migrate'});
  assert.equal(inputs[0].summary,'Which database should the migration target?');
  assert.ok(question.events.some(e=>e.type==='input'&&e.request.summary===inputs[0].summary));
  assert.deepEqual(question.events.find(e=>e.native?.method==='fixture/approval').native.params.decision,{answers:{db:{answers:['postgres']}}});
});
test('a Codex error the server retries by itself is marked as such',async t=>{
  const {adapter,events}=await setup(t,'codex','retry-error');
  await adapter.start();
  assert.equal((await adapter.send({text:'go'})).text,'recovered');
  const error=events.find(e=>e.type==='error');
  assert.equal(error.willRetry,true);assert.equal(error.message,'stream disconnected, retrying 1/5');
});

test('Codex native subagent follows official thread/started parent lineage and routes its approval without finishing the parent turn',async t=>{
  const approvals=[];
  const setupResult=await setup(t,'codex','subagent',{
    onApproval:async request=>{
      approvals.push(request);
      assert.equal(request.threadId,'child-thread');
      assert.equal(request.turnId,'child-turn');
      assert.equal(request.details.itemId,'child');
      return {optionId:'accept'};
    }
  });
  const adapter=setupResult.adapter;
  await adapter.start();
  const result=await adapter.send({text:'Use native Codex subagent'});
  assert.equal(result.status,'completed');
  assert.equal(result.turnId,'turn-1');
  assert.equal(approvals.length,1);
  assert.ok(setupResult.events.some(e=>e.native?.method==='thread/started'&&e.native.params.thread.parentThreadId==='native-session'));
  assert.ok(setupResult.events.some(e=>e.type==='message'&&e.native?.params?.threadId==='child-thread'&&e.text==='child-progress'));
  assert.ok(setupResult.events.some(e=>e.native?.method==='fixture/childDecision'&&e.native.params.decision.decision==='accept'));
  assert.ok(setupResult.events.some(e=>e.native?.method==='fixture/foreignDecision'&&e.native.params.error?.code===-32602));
  assert.equal(adapter.state,'ready');
});


test('Codex cancellation fences approvals arriving after interrupt, not just approvals already awaiting a decision',async t=>{
  let approvals=0;
  const {adapter,events}=await setup(t,'codex','cancel-late-approval',{
    onApproval:async()=>{approvals++;return {optionId:'accept'};}
  });
  await adapter.start();
  const turn=adapter.send({text:'cancel native work'});
  await new Promise(resolve=>setTimeout(resolve,90));
  await adapter.cancel();
  const result=await turn;
  assert.equal(result.status,'interrupted');
  assert.equal(approvals,0,'A fresh native approval must not start after cancellation');
  assert.ok(events.some(e=>e.native?.method==='fixture/lateDecision'&&e.native.params.decision?.decision==='decline'));
});


test('Claude native cross-session inbox and experimental Agent Teams are explicit, provider-owned opt-ins',async t=>{
  const normalized=normalizeConfig({providers:{claude:{nativePeerMessaging:true,nativeAgentTeams:true}}});
  assert.equal(normalized.providers.claude.nativePeerMessaging,true);
  assert.equal(normalized.providers.claude.nativeAgentTeams,true);
  assert.equal(normalizeConfig({providers:{claude:{}}}).providers.claude.nativePeerMessaging,false);
  assert.equal(normalizeConfig({providers:{claude:{}}}).providers.claude.nativeAgentTeams,false);
  const {adapter}=await setup(t,'claude','native-features',{
    nativePeerMessaging:normalized.providers.claude.nativePeerMessaging,
    nativeAgentTeams:normalized.providers.claude.nativeAgentTeams
  });
  const session=await adapter.start();
  assert.equal(session.capabilities.nativePeerMessaging,'during-active-turn');
  assert.equal(session.capabilities.nativeAgentTeams,'experimental-opt-in');
  assert.equal((await adapter.send({text:'exercise native provider features'})).status,'completed');
});


test('Codex native grandchild events and approval follow transitive App Server thread lineage without crossing another conversation',async t=>{
  let approvals=0;
  const {adapter,events}=await setup(t,'codex','subagent-nested',{
    onApproval:async request=>{
      approvals++;
      assert.equal(request.threadId,'grandchild-thread');
      assert.equal(request.turnId,'grandchild-turn');
      assert.equal(request.details.itemId,'grandchild');
      return {optionId:'accept'};
    }
  });
  await adapter.start();
  const result=await adapter.send({text:'Use nested native Codex workers'});
  assert.equal(result.status,'completed');
  assert.equal(approvals,1);
  assert.ok(events.some(e=>e.type==='message'&&e.nativeSubagent===true&&e.nativeThreadId==='grandchild-thread'&&e.nativeParentThreadId==='child-thread'));
  assert.ok(events.some(e=>e.native?.method==='fixture/grandchildDecision'&&e.native.params.decision?.decision==='accept'));
  assert.ok(events.some(e=>e.native?.method==='fixture/foreignDecision'&&e.native.params.error?.code===-32602));
});


test('Codex never grants fresh native approvals after the owning root turn has completed',async t=>{
  let requests=0;
  const {adapter,events}=await setup(t,'codex','post-turn-approval',{
    onApproval:async()=>{requests++;return {optionId:'accept'};}
  });
  await adapter.start();
  const result=await adapter.send({text:'complete root turn'});
  assert.equal(result.status,'completed');
  for(let i=0;i<45&&!events.some(e=>e.native?.method==='fixture/postTurnDecision');i++)
    await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(requests,0,'No approval may escape the completed native turn');
  assert.ok(events.some(e=>e.native?.method==='fixture/postTurnDecision'&&
    e.native.params.decision?.decision==='decline'));
});


test('Codex App Server native spawnAgent tool evidence routes a child approval without fabricating a DevMate child session',async t=>{
  const decisions=[];
  const {adapter,events}=await setup(t,'codex','collab-spawn',{
    onApproval:async req=>{decisions.push(req);return {optionId:'accept'};}
  });
  await adapter.start();
  const result=await adapter.send({text:'Spawn a native Codex subagent'});
  assert.equal(result.status,'completed');
  assert.equal(decisions.length,1);
  assert.equal(decisions[0].threadId,'spawned-child');
  assert.ok(events.some(e=>e.native?.method==='fixture/spawnDecision'&&
    e.native.params.decision?.decision==='accept'));
  assert.equal(adapter.childThreads.size,0,'Native child references expire when the owning turn ends');
});

test('Codex refuses stale native child approval after its child turn completes while parent is active',async t=>{
  let humanRequests=0;
  const {adapter,events}=await setup(t,'codex','subagent-late',{
    onApproval:async()=>{humanRequests++;return {optionId:'accept'};}
  });
  await adapter.start();
  const result=await adapter.send({text:'Child has completed, deny late request'});
  assert.equal(result.status,'completed');
  assert.equal(humanRequests,0);
  assert.ok(events.some(e=>e.native?.method==='fixture/staleChildDecision' &&
    e.native.params.decision?.decision==='decline'));
});
