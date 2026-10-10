import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { main, parseCli, readCliInput, CLI_HELP } from '../runtime/cli.mjs';
import { stopRuntime } from '../runtime/launcher.mjs';

function output() {
  let text='';
  return {write(value){text+=value;},get text(){return text;}};
}
function temp(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-cli-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  return directory;
}
// Run the real command-line program in its own process, as a person would.
const cli=(args,options={})=>spawnSync(process.execPath,[path.resolve('runtime/cli.mjs'),...args],{encoding:'utf8',windowsHide:true,timeout:60000,...options});

test('CLI discovers operations and provides exact schema help', async () => {
  const stdout=output(),stderr=output();
  const catalog={items:[{name:'project.create',inputSchema:{type:'object',required:['name']}}]};
  const clientFactory=()=>({operations:async()=>catalog,call:async(name,input)=>({items:name==='operations.list'?catalog.items.filter(item=>item.name===input.name):[]})});
  assert.equal(await main(['operations'],{stdout,stderr,clientFactory}),0);
  assert.deepEqual(JSON.parse(stdout.text),catalog);
  const help=output();
  assert.equal(await main(['help','project.create'],{stdout:help,stderr,clientFactory}),0);
  assert.deepEqual(JSON.parse(help.text),catalog.items[0]);
  assert.equal(stderr.text,'');
});

test('all four providers pass through the same CLI call path without a preferred agent', async () => {
  for(const provider of ['codex','claude','gemini','grok']) {
    const stdout=output(),stderr=output();
    let received;
    const input={provider,prompt:'中文 "quoted" $(literal) & %PATH%'};
    const code=await main(['call','agent.run','--json',JSON.stringify(input)],{
      stdout,stderr,clientFactory:()=>({call:async(operation,value)=>{received={operation,value};return{id:'run',provider};}})
    });
    assert.equal(code,0);
    assert.deepEqual(received,{operation:'agent.run',value:input});
    assert.equal(JSON.parse(stdout.text).provider,provider);
  }
});

test('stdin and file JSON preserve newlines, accept what PowerShell pipes, and reject ambiguous input sources', async t => {
  const directory=temp(t);
  const file=path.join(directory,'input 项目.json');
  const value={description:'line one\nline two',workspace:'A:\\Project\\Space Name'};
  fs.writeFileSync(file,JSON.stringify(value));
  assert.deepEqual(await readCliInput({file}),value);
  assert.deepEqual(await readCliInput({stdin:true},Readable.from([JSON.stringify(value).slice(0,5),JSON.stringify(value).slice(5)])),value);
  assert.deepEqual(await readCliInput({stdin:true},Readable.from(['\ufeff'+JSON.stringify(value)])),value,'a byte order mark from a PowerShell pipe is not an error');
  assert.throws(()=>parseCli(['call','x','--json','{}','--stdin']),/one input source/);
  await assert.rejects(readCliInput({json:'[]'}),/JSON object/);
  // A whole file can be written through the CLI: its input is not limited to a megabyte.
  const large={path:'big.txt',text:'x'.repeat(3*1024*1024)};
  assert.equal((await readCliInput({json:JSON.stringify(large)})).text.length,large.text.length);
});

test('help and connection information do not start or contact a runtime', async () => {
  const stdout=output(),stderr=output();
  const no=()=>{throw new Error('No runtime access expected');};
  assert.equal(await main(['help'],{stdout,stderr,clientFactory:no,launch:no}),0);
  assert.match(stdout.text,/operations/);
  assert.equal(await main([],{stdout:output(),stderr,clientFactory:no,launch:no}),0);
  assert.equal(await main(['connection','info'],{stdout:output(),stderr,clientFactory:no,launch:no}),0);
  const version=output();
  assert.equal(await main(['--version'],{stdout:version,stderr,clientFactory:no,launch:no}),0);
  assert.match(version.text,/^\d+\.\d+\.\d+\n$/);
  for(const command of ['start','stop','restart','status','serve','doctor','logs','project add','project list','mcp-url','connect cloudflare','secret set','login-code','ui','events'])
    assert.ok(CLI_HELP.includes('devmate '+command),'help names '+command);
});

test('CLI redacts credential fields and reports operation errors without echoing input', async () => {
  const stdout=output(),stderr=output();
  await main(['snapshot'],{stdout,stderr,clientFactory:()=>({snapshot:async()=>({ownerToken:'test-secret',tokenUsage:42,nested:{apiKey:'second-secret'}})})});
  assert.deepEqual(JSON.parse(stdout.text),{ownerToken:'[redacted]',tokenUsage:42,nested:{apiKey:'[redacted]'}});
  const errors=output();
  const code=await main(['call','project.create','--json','{"password":"not-printed"}'],{
    stdout:output(),stderr:errors,clientFactory:()=>({call:async()=>{const error=new Error('Invalid project');error.code='INVALID_PROJECT';throw error;}})
  });
  assert.equal(code,1);
  assert.equal(errors.text.includes('not-printed'),false);
  assert.equal(JSON.parse(errors.text).error.code,'INVALID_PROJECT');
  const typo=output();
  assert.equal(await main(['stauts'],{stdout:output(),stderr:typo,clientFactory:()=>({call:async()=>{throw new Error('must not be called');}})}),1);
  assert.match(JSON.parse(typo.text).error.message,/Unknown command: stauts\. Run devmate help/);
});

test('CLI delegates lifecycle to the selected isolated instance without opening UI', async () => {
  const stdout=output(),stderr=output();
  let received;
  const instance=path.resolve('isolated runtime');
  assert.equal(await main(['start','--instance',instance,'--port','34567'],{
    stdout,stderr,launch:async options=>{received=options;return{started:true};},
    clientFactory:()=>{throw new Error('No implicit browser/client');}
  }),0);
  assert.deepEqual(received,{instanceRoot:instance,port:34567});
  const order=[];
  assert.equal(await main(['restart','--instance',instance],{stdout:output(),stderr,
    stop:async()=>{order.push('stop');return{stopped:true};},launch:async()=>{order.push('start');return{started:true};}}),0);
  assert.deepEqual(order,['stop','start']);
});

test('the commands people copy from print just the value: MCP address, sign-in code, workbench link', async () => {
  const run=async(args,connection)=>{
    const stdout=output(),stderr=output(),opened=[];
    const code=await main(args,{stdout,stderr,open:url=>opened.push(url),clientFactory:()=>({origin:()=>'http://127.0.0.1:8788',
      signInUrl:async()=>'http://127.0.0.1:8788/?code=once',
      call:async name=>name==='connection.status'?connection:name==='auth.code.create'?{code:'dml_once',expiresAt:'2026-10-10T00:10:00.000Z'}:{}})});
    return{code,stdout:stdout.text,stderr:stderr.text,opened};
  };
  assert.deepEqual(await run(['mcp-url'],{kind:'local'}).then(r=>[r.stdout,/only on this computer/.test(r.stderr)]),['http://127.0.0.1:8788/mcp\n',true]);
  assert.equal((await run(['mcp-url'],{kind:'cloudflare',publicUrl:'https://devmate.example.com/mcp'})).stdout,'https://devmate.example.com/mcp\n');
  const tunnel=await run(['mcp-url'],{kind:'openai-tunnel',tunnelId:'tunnel_abc'});
  assert.equal(tunnel.stdout,'tunnel_abc\n');assert.match(tunnel.stderr,/Tunnel connection type/);
  assert.equal((await run(['login-code'],{})).stdout,'dml_once\n');
  const link=await run(['ui'],{});
  assert.equal(link.stdout,'http://127.0.0.1:8788/?code=once\n');assert.deepEqual(link.opened,[]);
  assert.deepEqual((await run(['ui','--open'],{})).opened,['http://127.0.0.1:8788/?code=once']);
});

test('with no runtime, no editor and nothing configured, the CLI says what to do and can be set up', async t => {
  const instance=path.join(temp(t),'fresh instance');
  const at=['--instance',instance];
  // Nothing is running: status is true about that and creates nothing.
  const status=cli(['status',...at]);
  assert.equal(status.status,0,status.stderr);
  assert.deepEqual(JSON.parse(status.stdout),{state:'stopped',instanceRoot:instance,running:false});
  assert.equal(fs.existsSync(instance),false);
  // Anything that needs the runtime names the command that starts it.
  const stopped=cli(['project','list',...at]);
  assert.equal(stopped.status,1);
  assert.deepEqual(JSON.parse(stopped.stderr).error,{code:'RUNTIME_STOPPED',message:'DevMate runtime is not running. Start it with: devmate start'});
  // The doctor still works, checks what it can, and ends with the next step.
  const doctor=cli(['doctor',...at]);
  assert.match(doctor.stdout,/\[ ok \] node: Node\.js/);assert.match(doctor.stdout,/\[warn\] runtime: The runtime is not running/);assert.match(doctor.stdout,/-> Start it with: devmate start/);
  // The connection and its credential are set up before the first start, with the credential read from standard input.
  const connected=cli(['connect','cloudflare','--url','https://devmate.example.com/mcp','--executable',process.execPath,'--auth','oauth',...at]);
  assert.equal(connected.status,0,connected.stderr);
  const answer=JSON.parse(connected.stdout);
  assert.deepEqual(answer.saved,{connection:{kind:'cloudflare',publicUrl:'https://devmate.example.com/mcp',executable:process.execPath,tokenEnv:'CLOUDFLARE_TUNNEL_TOKEN'},auth:{mode:'oauth',issuer:'https://devmate.example.com'}});
  assert.deepEqual(answer.next,['Store the credential: devmate secret set CLOUDFLARE_TUNNEL_TOKEN','Apply it: devmate restart','Then check: devmate doctor']);
  const stored=cli(['secret','set','CLOUDFLARE_TUNNEL_TOKEN',...at],{input:'  token-from-stdin\r\n'});
  assert.equal(stored.status,0,stored.stderr);
  assert.equal((stored.stdout+stored.stderr).includes('token-from-stdin'),false,'the credential is never echoed');
  assert.deepEqual(JSON.parse(cli(['secret','list',...at]).stdout),{names:['CLOUDFLARE_TUNNEL_TOKEN']});
  assert.equal(JSON.parse(fs.readFileSync(path.join(instance,'secrets.json'),'utf8')).CLOUDFLARE_TUNNEL_TOKEN,'token-from-stdin');
  // Mistakes are refused before anything is saved, and sign-in never outlives the address it belongs to.
  assert.equal(cli(['connect','cloudflare','--url','http://insecure.example.com/mcp','--executable',process.execPath,...at]).status,1);
  assert.match(JSON.parse(cli(['connect','openai-tunnel','--tunnel-id','tunnel_abc',...at]).stderr).error.message,/needs --executable/);
  assert.match(JSON.parse(cli(['connect','local','--auth','oauth',...at]).stderr).error.message,/needs a connection with a public URL/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(instance,'config.json'),'utf8')).connection.kind,'cloudflare','a refused change left the saved settings alone');
  const local=JSON.parse(cli(['connect','local',...at]).stdout);
  assert.deepEqual(local.saved,{connection:{kind:'local'},auth:{mode:'none'}});
  assert.match(cli(['doctor',...at]).stdout,/\[ ok \] settings: connection: local, auth: none/);
});

test('the CLI alone runs DevMate: start, register a project, work in it, open the workbench, stop', async t => {
  // Registered before the directory's own removal: the runtime is stopped while its instance directory still exists.
  let instance;t.after(()=>instance?stopRuntime({instanceRoot:instance,timeoutMs:15000}).catch(()=>{}):undefined);
  const base=temp(t),project=path.join(base,'my project');instance=path.join(base,'instance');
  fs.mkdirSync(project);
  const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const at=['--instance',instance];
  const started=cli(['start','--port',String(port),...at]);
  assert.equal(started.status,0,started.stderr);
  assert.deepEqual([JSON.parse(started.stdout).started,JSON.parse(started.stdout).record.port],[true,port]);
  assert.equal(JSON.parse(cli(['start',...at]).stdout).attached,true,'starting again joins the running runtime');
  // Without a directory argument the current directory is the project.
  const added=JSON.parse(cli(['project','add','--name','Mine',...at],{cwd:project}).stdout);
  assert.deepEqual([added.name,added.access],['Mine','write']);
  assert.deepEqual(JSON.parse(cli(['project','list',...at]).stdout).map(item=>[item.name,item.root]),[['Mine',fs.realpathSync.native(project)]]);
  // With one project, operations need no project id; input comes from an argument, a file or a pipe.
  assert.equal(JSON.parse(cli(['workspace.write','--json',JSON.stringify({path:'hello.txt',text:'from the CLI'}),...at]).stdout).written,true);
  assert.equal(JSON.parse(cli(['call','workspace.read','--stdin',...at],{input:'\ufeff{"path":"hello.txt"}'}).stdout).text,'from the CLI');
  const ran=JSON.parse(cli(['shell.run','--json',JSON.stringify({file:process.execPath,args:['-p','6*7']}),...at]).stdout);
  assert.deepEqual([ran.exitCode,ran.output.trim()],[0,'42']);
  assert.equal(cli(['mcp-url',...at]).stdout,'http://127.0.0.1:'+port+'/mcp\n');
  const link=cli(['ui',...at]).stdout.trim();
  assert.match(link,new RegExp('^http://127\\.0\\.0\\.1:'+port+'/\\?code=[A-Za-z0-9_-]{43}$'));
  const page=await fetch(link,{redirect:'manual'});
  assert.equal(page.status,200,'the link opens the page, which signs its own tab in');await page.text();
  assert.match(cli(['doctor',...at]).stdout,/\[ ok \] projects: 1 project\(s\) registered/);
  assert.match(cli(['logs','--lines','5',...at]).stdout,/"event":"ready"/);
  const invalid=JSON.parse(cli(['workspace.read','--json','{"path":7}',...at]).stderr).error;
  assert.equal(invalid.code,'invalid_input');assert.match(invalid.message,/Invalid input for workspace\.read: path/);
  assert.equal(JSON.parse(cli(['project','remove','Mine',...at]).stdout).removed,true);
  assert.equal(JSON.parse(cli(['stop',...at]).stdout).stopped,true);
  assert.equal(JSON.parse(cli(['status',...at]).stdout).state,'stopped');
  assert.equal(JSON.parse(cli(['stop',...at]).stdout).alreadyStopped,true);
});

test('the CLI answers when it is started through a link, as a global install does', async t => {
  const directory=temp(t),link=path.join(directory,'linked runtime');
  fs.symlinkSync(path.resolve('runtime'),link,process.platform==='win32'?'junction':'dir');
  const result=spawnSync(process.execPath,[path.join(link,'cli.mjs'),'--version'],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/^\d+\.\d+\.\d+\n$/,'it runs and prints instead of exiting silently');
  const status=spawnSync(process.execPath,[path.join(link,'cli.mjs'),'status','--instance',path.join(directory,'none')],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(JSON.parse(status.stdout).state,'stopped');
});
