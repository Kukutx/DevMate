#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {buildRuntimeCandidate} from './runtime-build.mjs';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import processTree from '../runtime/platform/process-tree.js';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const protocol='2026-07-28';
export async function smokeRuntime({candidate,manifestPath,pluginManifestPath,reuseWorkbench=false}={}){
  if(!candidate)candidate=(await buildRuntimeCandidate({reuseWorkbench,manifestPath,pluginManifestPath})).out;
  candidate=path.resolve(candidate);
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-smoke 中文 ')),instance=path.join(temporary,'instance'),projectRoot=path.join(temporary,'project');
  fs.mkdirSync(projectRoot);fs.mkdirSync(instance);
  const unrelated=http.createServer((_req,res)=>res.end('unrelated'));
  await new Promise(resolve=>unrelated.listen(0,'127.0.0.1',resolve));
  const unrelatedUrl='http://127.0.0.1:'+unrelated.address().port;
  const child=spawn(process.execPath,[path.join(candidate,'runtime','main.mjs'),'--instance',instance,'--port','0'],{cwd:temporary,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let diagnostic='',spawnError,record,sequence=0,clean=false,leftRunning=false,result;
  child.stdout.on('data',chunk=>{diagnostic=(diagnostic+String(chunk)).slice(-32000);});
  child.stderr.on('data',chunk=>{diagnostic=(diagnostic+String(chunk)).slice(-32000);});
  child.on('error',error=>{spawnError=error;});
  const exited=new Promise(resolve=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',()=>resolve({error:true}));});
  async function waitForExit(ms){let timer;try{return await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned candidate did not exit after stop.')),ms);})]);}finally{clearTimeout(timer);}}
  const cli=(command,input,raw=false)=>{
    const args=[path.join(candidate,'runtime','cli.mjs'),'--instance',instance,'--timeout','20000'];
    args.push(...(input===undefined?command.split(' '):['call',command,'--json',JSON.stringify(input)]));
    const result=spawnSync(process.execPath,args,{cwd:temporary,shell:false,windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
    assert.equal(result.status,0,'CLI '+command+' failed: '+String(result.stderr||result.error||''));return raw?result.stdout:JSON.parse(result.stdout);
  };
  // What a presented tool result carries for the next call: its last line.
  const follow=result=>JSON.parse(result.content[0].text.split('\n').at(-1));
  try{
    const deadline=Date.now()+20000;
    while(Date.now()<deadline){
      if(spawnError)throw spawnError;
      if(child.exitCode!==null||child.signalCode!==null)throw new Error('Candidate exited before readiness: '+diagnostic);
      try{record=JSON.parse(fs.readFileSync(path.join(instance,'runtime.json'),'utf8'));break;}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
      await delay(40);
    }
    assert.ok(record,'Candidate did not publish readiness: '+diagnostic);
    assert.equal(record.pid,child.pid);assert.ok(record.port>0);
    const base='http://127.0.0.1:'+record.port;
    // The packaged launcher sees this runtime, and a second runtime for the same instance is refused without disturbing it.
    const seen=cli('status');assert.equal(seen.state,'ready');assert.equal(seen.record.pid,child.pid);
    const rival=spawnSync(process.execPath,[path.join(candidate,'runtime','main.mjs'),'--instance',instance,'--port','0'],{cwd:temporary,shell:false,windowsHide:true,encoding:'utf8',timeout:20000});
    assert.equal(rival.status,1);assert.match(rival.stderr,/"code":"instance_running"/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(instance,'runtime.json'),'utf8')).generation,record.generation);
    const health=await(await fetch(base+'/health',{signal:AbortSignal.timeout(5000)})).json();
    assert.equal(health.status,'ready');assert.equal(health.generation,record.generation);assert.equal(health.pid,child.pid);
    async function rpc(method,params={}){
      const response=await fetch(base+'/mcp',{method:'POST',signal:AbortSignal.timeout(15000),headers:{
        'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':protocol,'MCP-Method':method,
        ...((params.name||params.uri)?{'MCP-Name':params.name||params.uri}:{})
      },body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params:{...params,_meta:{
        'io.modelcontextprotocol/protocolVersion':protocol,'io.modelcontextprotocol/clientInfo':{name:'devmate-candidate-smoke',version:'4'},
        'io.modelcontextprotocol/clientCapabilities':{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}
      }}})});
      const text=await response.text();assert.equal(response.status,200,method+': '+text.slice(0,2000));
      let result;try{result=JSON.parse(text);}catch{result=text.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5).trim())).find(item=>item.id===sequence);}
      assert.ok(result,method+' did not return JSON-RPC');assert.equal(result.error,undefined,JSON.stringify(result.error));
      return result.result;
    }
    const tool=async(name,args={})=>{const result=await rpc('tools/call',{name,arguments:args});assert.notEqual(result.isError,true,JSON.stringify(result));return result.structuredContent;};
    const discovery=await rpc('server/discover');assert.ok(discovery.supportedVersions.includes(protocol));
    const listed=await rpc('tools/list'),tools=listed.tools;
    const launcher=tools.find(item=>item.name==='open_devmate_workbench');assert.ok(launcher);
    assert.ok(launcher._meta['openai/ui'].entrypoints.some(item=>item.type==='global'));
    assert.equal(tools.some(item=>item.name==='runtime_stop'||item.name==='host_attach'),false);
    const resources=await rpc('resources/list');assert.ok(resources.resources.some(item=>item.uri==='ui://devmate/workbench/v1'));
    const ui=await rpc('resources/read',{uri:'ui://devmate/workbench/v1'});
    assert.equal(ui.contents[0].mimeType,'text/html;profile=mcp-app');assert.match(ui.contents[0].text,/DevMate/);
    assert.deepEqual(Object.keys(ui.contents[0]._meta),['ui']);
    const global=await tool('open_devmate_workbench');assert.ok(global);
    // Sharing a folder is the owner's act at this computer, here through the packaged command line. A connected client has no tool for it,
    // and the generic call refuses it.
    assert.equal(tools.some(item=>item.name==='project_create'),false);
    const attempt=await rpc('tools/call',{name:'operations_call',arguments:{operation:'project.create',input:{root:projectRoot}}});
    assert.equal(attempt.isError,true);assert.match(attempt.content[0].text,/shared by the owner on their own computer/);
    const project=cli('project.create',{root:projectRoot,name:'Isolated packaged smoke'});
    await tool('workspace_write',{projectId:project.id,path:'roundtrip.txt',text:'MCP 中文 round trip',expectedSha256:null});
    const shown=await rpc('tools/call',{name:'workspace_read',arguments:{projectId:project.id,path:'roundtrip.txt'}});
    assert.match(shown.content[0].text,/^\s+1\tMCP 中文 round trip\n/);assert.equal(shown.structuredContent,undefined);assert.match(follow(shown).sha256,/^[a-f0-9]{64}$/);
    const edited=await tool('workspace_edit',{projectId:project.id,path:'roundtrip.txt',edits:[{oldText:'round trip',newText:'往返'}]});assert.equal(edited.replacements,1);
    const shell=await rpc('tools/call',{name:'shell_run',arguments:{projectId:project.id,command:'node -e "console.log(require(\'node:fs\').readFileSync(\'roundtrip.txt\',\'utf8\'))"'}});
    assert.match(shell.content[0].text,/MCP 中文 往返/);assert.equal(follow(shell).exitCode,0);
    cli('workspace.write',{projectId:project.id,path:'roundtrip.txt',text:'CLI update',expectedSha256:edited.sha256});
    assert.equal(cli('workspace.read',{projectId:project.id,path:'roundtrip.txt'}).text,'CLI update');
    const fileResource=await rpc('resources/read',{uri:'devmate://project/'+project.id+'/file/roundtrip.txt'});
    assert.equal(fileResource.contents[0].text,'CLI update');
    const code="require('node:fs').writeFileSync('job-output.txt','owned job complete');console.log('job proof')";
    const job=cli('job.start',{projectId:project.id,kind:'command',input:{file:process.execPath,args:['-e',code]}});
    let outcome;const jobDeadline=Date.now()+15000;
    do{outcome=cli('job.read',{id:job.id});if(['completed','failed','unknown','cancelled'].includes(outcome.status))break;await delay(80);}while(Date.now()<jobDeadline);
    assert.equal(outcome.status,'completed',JSON.stringify(outcome));assert.match(outcome.output,/job proof/);
    assert.equal(fs.readFileSync(path.join(projectRoot,'job-output.txt'),'utf8'),'owned job complete');
    assert.ok(cli('job.list',{projectId:project.id}).items.some(item=>item.id===job.id));
    // The workbench page holds nothing for whoever merely reaches the port. The CLI mints a single-use link for the owner's
    // browser; the page of that link exchanges the code for a session that stays in its tab and is no cookie.
    const anonymous=await fetch(base+'/',{signal:AbortSignal.timeout(5000)});assert.equal(anonymous.status,200);assert.equal(anonymous.headers.get('set-cookie'),null);assert.match(await anonymous.text(),/DevMate/);
    const closed=await fetch(base+'/api/snapshot',{signal:AbortSignal.timeout(5000)});assert.equal(closed.status,401);await closed.text();
    const link=cli('ui',undefined,true).trim();assert.ok(link.startsWith(base+'/?code='),link);
    const entered=await fetch(base+'/api/session/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:new URL(link).searchParams.get('code')}),signal:AbortSignal.timeout(5000)});
    assert.equal(entered.status,200);assert.equal(entered.headers.get('set-cookie'),null);
    const viewed=await fetch(base+'/api/snapshot',{headers:{authorization:'Bearer '+(await entered.json()).result.session},signal:AbortSignal.timeout(5000)});assert.equal(viewed.status,200);await viewed.text();
    assert.equal(cli('mcp-url',undefined,true).trim(),base+'/mcp');
    // The packaged stdio entry: a client that starts its server as a program reaches the same runtime and the same tools.
    const stdio=new Client({name:'devmate-candidate-smoke-stdio',version:'4'});
    await stdio.connect(new StdioClientTransport({command:process.execPath,args:[path.join(candidate,'runtime','cli.mjs'),'mcp','--instance',instance],stderr:'ignore'}));
    try{
      assert.equal((await stdio.listTools()).tools.length,tools.length);
      const viaStdio=await stdio.callTool({name:'workspace_read',arguments:{projectId:project.id,path:'roundtrip.txt'}});
      assert.match(viaStdio.content[0].text,/CLI update/);
    }finally{await stdio.close();}
    assert.match(cli('doctor',undefined,true),/\[ ok \] projects: 1 project\(s\) registered/);
    const stopped=cli('stop');assert.equal(stopped.stopped,true);
    const exit=await waitForExit(10000);
    assert.equal(exit.code,0,diagnostic);assert.equal(fs.existsSync(path.join(instance,'runtime.json')),false);assert.equal(fs.existsSync(path.join(instance,'owner-token')),false);
    assert.deepEqual(cli('status'),{state:'stopped',instanceRoot:instance,running:false});
    assert.equal(await(await fetch(unrelatedUrl)).text(),'unrelated');clean=true;
    result={ok:true,candidate,version:health.version,protocol,tools:tools.length,checks:['native-child-port-0','MCP-discover','global-workbench-resource','MCP-file-roundtrip','CLI-file-write-read','CLI-owned-job','single-instance','workbench-sign-in-link','stdio-entry','identity-checked-stop','unrelated-listener-preserved']};
  }finally{
    if(child.exitCode===null&&child.signalCode===null){
      try{if(record)cli('stop');}catch{}
      if(child.exitCode===null&&child.signalCode===null)await processTree.terminateProcessTree(child);
      await waitForExit(5000).catch(()=>{});
    }
    await new Promise(resolve=>unrelated.close(resolve));
    if(child.exitCode!==null||child.signalCode!==null||spawnError)fs.rmSync(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    else if(!clean)leftRunning=true;
  }
  if(leftRunning)throw new Error('The owned smoke child did not confirm exit; evidence retained at '+temporary);
  return result;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const options={},args=process.argv.slice(2);
  for(let i=0;i<args.length;i++){
    if(args[i]==='--candidate')options.candidate=args[++i];
    else if(args[i]==='--manifest')options.manifestPath=args[++i];
    else if(args[i]==='--plugin-manifest')options.pluginManifestPath=args[++i];
    else if(args[i]==='--reuse-workbench')options.reuseWorkbench=true;
    else throw new Error('Usage: smoke-runtime.mjs [--candidate <directory>] [--manifest <package.json>] [--plugin-manifest <plugin.json>] [--reuse-workbench]');
  }
  console.log(JSON.stringify(await smokeRuntime(options),null,2));
}
