import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRuntime } from '../runtime/main.mjs';

// Stand-ins for the vendor CLIs, driven through the real adapters, the real coordinator
// and the real loopback agent channel. They never talk to a model; each reports what it
// was started with inside its "answer".
const stub = String.raw`
import fs from 'node:fs';
import readline from 'node:readline';
const argv=process.argv.slice(1);
if(argv.includes('--version')){console.log('9.9.9 (stub)');process.exit(0);}
if(argv.includes('mcp')){console.log(JSON.stringify([{name:'owner_tools',enabled:true}]));process.exit(0);}
const out=x=>process.stdout.write(JSON.stringify(x)+'\n');
const peers=async env=>(await fetch(env.DEVMATE_AGENT_URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+env.DEVMATE_AGENT_TOKEN},
  body:JSON.stringify({name:'agent_peers',input:{}})})).status;
if(argv.includes('-p')){
  let text='';for await(const chunk of process.stdin)text+=chunk;
  const file=argv[argv.indexOf('--mcp-config')+1];
  const channel=JSON.parse(fs.readFileSync(file,'utf8')).mcpServers.devmate_agent_channel.env;
  out({type:'system',subtype:'init',session_id:'claude-session'});
  out({type:'result',subtype:'success',is_error:false,session_id:'claude-session',result:JSON.stringify({prompt:text,argv,file,channel,
    env:Object.keys(process.env),status:await peers(channel)})});
} else {
  let thread,channel;
  readline.createInterface({input:process.stdin}).on('line',async line=>{
    const m=JSON.parse(line),p=m.params||{};
    if(m.method==='initialize')out({id:m.id,result:{userAgent:'stub'}});
    else if(m.method==='thread/start'||m.method==='thread/resume'){
      thread={method:m.method,excludeTurns:p.excludeTurns??null,reviewer:p.approvalsReviewer};
      channel=p.config.mcp_servers.devmate_agent_channel.env;
      out({id:m.id,result:{thread:{id:'codex-thread'},model:'stub-model'}});
    } else if(m.method==='mcpServerStatus/list')out({id:m.id,result:{data:[{name:'devmate_agent_channel',runtimeStatus:'connected',tools:{agent_peers:{}}},{name:'owner_tools',runtimeStatus:'disabled',tools:{}}],nextCursor:null}});
    else if(m.method==='turn/start'){
      const text=p.input[0].text,at={threadId:'codex-thread',turnId:'turn-1'};
      out({id:m.id,result:{turn:{id:'turn-1',status:'inProgress'}}});
      if(text==='die')process.exit(3);
      const say=(id,words,phase)=>{
        for(const word of words.split(' '))out({method:'item/agentMessage/delta',params:{...at,itemId:id,delta:word+' '}});
        out({method:'item/completed',params:{...at,completedAtMs:1,item:{type:'agentMessage',id,text:words,phase}}});
      };
      say('m1','I will run the test suite first','commentary');
      out({method:'item/started',params:{...at,startedAtMs:1,item:{type:'commandExecution',id:'c1',command:'npm test',cwd:'.',status:'inProgress',commandActions:[]}}});
      for(let i=0;i<60;i++)out({method:'item/commandExecution/outputDelta',params:{...at,itemId:'c1',delta:'TOOL_OUTPUT line '+i+'\n'}});
      for(let i=0;i<40;i++)out({method:'item/reasoning/textDelta',params:{...at,itemId:'r1',contentIndex:0,delta:'REASONING '+i+' '}});
      out({method:'item/completed',params:{...at,completedAtMs:2,item:{type:'commandExecution',id:'c1',command:'npm test',cwd:'.',status:'completed',commandActions:[],aggregatedOutput:'TOOL_OUTPUT all'}}});
      say('m2',JSON.stringify({prompt:text,argv,thread,env:Object.keys(process.env),status:await peers(channel)}),'final_answer');
      out({method:'turn/completed',params:{threadId:'codex-thread',turn:{id:'turn-1',status:'completed'}}});
    }
  });
}
`;
const owner = Object.freeze({ id: 'owner', role: 'owner', surface: 'local' });
const actor = Object.freeze({ kind: 'user', id: 'owner', label: 'You' });
async function until(check, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-agent-lifecycle-'));
  const instanceRoot = path.join(home, 'instance'), projectRoot = path.join(home, 'project');
  fs.mkdirSync(instanceRoot); fs.mkdirSync(projectRoot);
  const command = { file: process.execPath, args: ['--input-type=module', '-e', stub, '--'] };
  fs.writeFileSync(path.join(instanceRoot, 'config.json'), JSON.stringify({ providers: { claude: { command }, codex: { command } } }));
  const saved = { ...process.env };
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-ant-owner', OPENAI_API_KEY: 'sk-openai-owner', CLOUDFLARE_TUNNEL_TOKEN: 'tunnel-secret' });
  const runtime = await startRuntime({ instanceRoot, port: 0,
    connectionFactory: () => ({ async start() {}, async stop() {}, status() { return { kind: 'local', phase: 'local' }; } }) });
  t.after(async () => {
    await runtime.stop();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const project = await runtime.service.call('project.create', { root: projectRoot }, owner);
  const channel = token => fetch('http://127.0.0.1:' + runtime.port + '/api/agent', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ name: 'agent_peers', input: {} }) });
  return { runtime, instanceRoot, project, agents: runtime.service.agents, store: runtime.service.store, channel };
}

test('a delegated Claude turn keeps its credentials off the command line and its channel token dies with the process', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const done = await f.agents.delegate({ projectId: f.project.id, provider: 'claude', prompt: 'Report your launch', waitMs: 30000, caller: 'owner' }, actor);
  assert.equal(done.settled, true, JSON.stringify(done.error || done.turn));
  assert.equal(done.turn.status, 'completed');
  const seen = JSON.parse(done.output);
  assert.equal(seen.prompt, 'Report your launch');
  assert.equal(seen.status, 200, 'the channel token works while the turn is running');
  assert.match(seen.channel.DEVMATE_AGENT_TOKEN, /^[a-f0-9]{64}$/);
  assert.equal(seen.argv.some(arg => arg.includes(seen.channel.DEVMATE_AGENT_TOKEN)), false, 'no credential is visible in a process listing');
  assert.ok(path.resolve(seen.file).startsWith(path.join(fs.realpathSync.native(f.instanceRoot), 'agents') + path.sep) ||
    path.resolve(seen.file).startsWith(path.join(f.instanceRoot, 'agents') + path.sep), 'the MCP launch file lives in the private instance directory');
  assert.equal(fs.existsSync(seen.file), false, 'and is removed when the process has exited');
  assert.equal(seen.argv[seen.argv.indexOf('--setting-sources') + 1], 'user');
  assert.ok(seen.argv.includes('--strict-mcp-config'));
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLOUDFLARE_TUNNEL_TOKEN', 'DEVMATE_AGENT_TOKEN', 'DEVMATE_AGENT_APPROVAL_TOKEN'])
    assert.equal(seen.env.includes(name), false, name + ' must not reach the agent');
  await until(() => !f.agents.sessions.get(done.agentId)?.draining, 'turn finished');
  assert.notEqual((await f.channel(seen.channel.DEVMATE_AGENT_TOKEN)).status, 200, 'after the process exited its token is refused');
  assert.equal(f.agents.tokens.size, 0);
  const again = await f.agents.delegate({ projectId: f.project.id, agentId: done.agentId, prompt: 'Second turn', waitMs: 30000 }, actor);
  const next = JSON.parse(again.output);
  assert.equal(next.status, 200); assert.notEqual(next.channel.DEVMATE_AGENT_TOKEN, seen.channel.DEVMATE_AGENT_TOKEN, 'every turn gets its own token');
  assert.ok(next.argv.includes('--resume=claude-session'));
});

test('a delegated Codex session is isolated, answers with its final message only and resumes after its process dies', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const first = await f.agents.delegate({ projectId: f.project.id, provider: 'codex', prompt: 'Run the tests', waitMs: 30000 }, actor);
  assert.equal(first.settled, true, JSON.stringify(first.error || first.turn));
  assert.equal(first.turn.status, 'completed');
  const seen = JSON.parse(first.output);
  assert.equal(seen.prompt, 'Run the tests', 'the answer is the final_answer message, not every assistant message of the turn');
  assert.deepEqual(seen.argv, ['app-server', '-c', 'mcp_servers.owner_tools.enabled=false', '-c', 'features.apps=false']);
  assert.deepEqual(seen.thread, { method: 'thread/start', excludeTurns: null, reviewer: 'user' });
  assert.equal(seen.status, 200);
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLOUDFLARE_TUNNEL_TOKEN']) assert.equal(seen.env.includes(name), false, name + ' must not reach the agent');
  // Durable journal: bursts are coalesced and tool output and reasoning are not kept.
  const journal = f.store.events({ projectId: f.project.id, limit: 2000 }).filter(event => event.type === 'agent.native' && event.jobId === first.jobId);
  assert.ok(journal.length < 30, 'a turn with ' + 130 + ' fragments wrote ' + journal.length + ' journal rows');
  const text = JSON.stringify(journal);
  assert.equal(text.includes('TOOL_OUTPUT'), false); assert.equal(text.includes('REASONING'), false);
  assert.ok(journal.some(event => event.nativeEvent.nativeMethod === 'item/commandExecution/outputDelta' && event.nativeEvent.chars > 500));
  assert.ok(journal.filter(event => event.nativeEvent.type === 'message' && event.nativeEvent.delta).map(event => event.nativeEvent.text).join('').includes('I will run the test suite first'));
  assert.equal(JSON.stringify(f.store.get('job', first.jobId).nativeResult).includes('TOOL_OUTPUT'), false);
  const token = f.agents.sessions.get(first.agentId).token;
  assert.equal((await f.channel(token)).status, 200, 'a session process keeps its token between turns');
  // The app-server dies in the middle of the next turn.
  const dead = await f.agents.delegate({ projectId: f.project.id, agentId: first.agentId, prompt: 'die', waitMs: 30000 }, actor);
  assert.equal(dead.settled, true); assert.equal(dead.turn.status, 'unknown'); assert.equal(dead.status, 'disconnected');
  assert.equal(dead.error.code, 'process_exited'); assert.equal(dead.output, '');
  await until(() => !f.agents.sessions.has(first.agentId), 'dead session released');
  assert.notEqual((await f.channel(token)).status, 200, 'the token of a dead process is refused');
  const resumed = await f.agents.delegate({ projectId: f.project.id, agentId: first.agentId, prompt: 'Carry on', waitMs: 30000 }, actor);
  assert.equal(resumed.settled, true, JSON.stringify(resumed.error || resumed.turn));
  const after = JSON.parse(resumed.output);
  assert.equal(after.prompt, 'Carry on');
  assert.deepEqual(after.thread, { method: 'thread/resume', excludeTurns: true, reviewer: 'user' });
  assert.notEqual(resumed.jobId, dead.jobId);
});
