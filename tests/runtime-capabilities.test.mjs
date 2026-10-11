import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { McpServer, inputRequired } from '@modelcontextprotocol/server';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { createCapabilities, normalizeExternalServers } from '../runtime/capabilities.mjs';
// The owner at their computer, who may also set an engine up.
// The owner where a decision is theirs to make: at their computer, or connected with full access.
const testOwner = Object.freeze({ ownerDecides: true });

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-capability-'));
  const project={id:'one',name:'Isolated project',root:path.join(root,'project'),access:'write'};
  fs.mkdirSync(project.root); fs.writeFileSync(path.join(project.root,'project.godot'),'config_version=5\n[application]\nconfig/name="Fixture"\n');
  const settings=new Map(),events=[];
  const service={
    project(id,{write=false}={}){assert.equal(id,'one');if(write&&project.access!=='write')throw new Error('read only');return project;},
    store:{setting(key,value){if(value!==undefined)settings.set(key,value);return settings.get(key);},event(...args){events.push(args);}}
  };
  t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  return {root,project,service,settings,events};
}

test('Godot catalog and static engine use the selected project without old config',async t=>{
  const f=fixture(t),cap=await createCapabilities({service:f.service,instanceRoot:path.join(f.root,'instance')});
  t.after(()=>cap.close());
  const catalog=await cap.list({projectId:'one'}, testOwner);
  const names=catalog.engines.flatMap(engine=>engine.capabilities.map(item=>item.name));
  assert.ok(names.includes('godot.performance_regression'));
  assert.ok(names.includes('godot.status'));
  assert.equal((await cap.list({projectId:'one',name:'godot.status'}, testOwner)).capability.inputSchema.properties.workspaceId,undefined);
  const result=await cap.call({projectId:'one',capability:'godot.status'}, testOwner);
  assert.equal(result.structuredContent.workspace.id,'one');
  await assert.rejects(cap.call({projectId:'one',capability:'godot.status',input:{workspaceId:'two'}}, testOwner));
  await assert.rejects(cap.call({projectId:'one',capability:'godot.status',input:{projectSubpath:'../'}}, testOwner));
  const configured=await cap.call({projectId:'one',capability:'godot.quick_setup',input:{defaultWebPreset:'Web fixture'}}, testOwner);
  assert.equal(configured.structuredContent.settings.defaultWebPreset,'Web fixture');
  assert.equal(f.settings.get('capability.one.godot').defaultWebPreset,'Web fixture');
  assert.equal(fs.existsSync(path.join(f.root,'instance','config.json')),false);
  f.project.access='read';
  await assert.rejects(cap.call({projectId:'one',capability:'godot.qa_bridge_install'}, testOwner),/read only/);
});

test('external config requires native command and credential references',()=>{
  assert.throws(()=>normalizeExternalServers([{id:'x',transport:'stdio',command:path.resolve('server.cmd')}]),/native/);
  assert.throws(()=>normalizeExternalServers([{id:'x',transport:'http',url:'https://user:password@example.test/mcp'}]),/credentials/);
  assert.throws(()=>normalizeExternalServers([{id:'x',transport:'http',url:'https://example.test/mcp',apiKey:'never-store'}]),/unsupported/);
  assert.deepEqual(normalizeExternalServers([{id:'dc',transport:'stdio',command:process.execPath,args:['server.mjs']}])[0].args,['server.mjs']);
});

test('external MCP keeps schema, resources and manual input_required fields intact',async t=>{
  const f=fixture(t);let options,connected=0,closed=0,seen;
  const requirement={kind:'input_required',inputRequests:{answer:{method:'elicitation/create',params:{message:'Confirm?'}}},requestState:'opaque+/='};
  const client={
    connect:async()=>{connected++;},close:async()=>{closed++;},
    listTools:async()=>({tools:[{name:'read_file',inputSchema:{type:'object',properties:{path:{type:'string'}}},outputSchema:{type:'object'}}]}),
    readResource:async params=>({contents:[{uri:params.uri,text:'resource body',mimeType:'text/plain'}]}),
    callTool:async(params,opts)=>{seen={params,opts};return requirement;}
  };
  const cap=await createCapabilities({service:f.service,instanceRoot:f.root,engines:[],
    externalServers:[{id:'dc',transport:'http',url:'http://127.0.0.1:34567/mcp'}],
    clientFactory:value=>{options=value;return client;},transportFactory:async()=>({})});
  await cap.list({projectId:'one'}, testOwner);assert.equal(connected,0);
  const catalog=await cap.list({projectId:'one',serverId:'dc'}, testOwner);
  assert.deepEqual(catalog.external.tools[0].outputSchema,{type:'object'});
  const input={name:'read_file',arguments:{path:'hello'},inputResponses:{answer:{action:'accept'}},requestState:'old opaque'};
  assert.deepEqual(await cap.call({projectId:'one',capability:'mcp.dc.tools.call',input}, testOwner),requirement);
  assert.deepEqual(seen.params,input);assert.equal(seen.opts.allowInputRequired,true);
  assert.deepEqual(options.versionNegotiation,{mode:'auto'});assert.equal(options.inputRequired.autoFulfill,false);
  const resource=await cap.call({projectId:'one',capability:'mcp.dc.resources.read',input:{uri:'file:///fixture'}}, testOwner);
  assert.equal(resource.contents[0].mimeType,'text/plain');
  await cap.close();assert.equal(closed,1);
});

test('explicit elicitation bridge preserves request and response objects',async t=>{
  const f=fixture(t);let handler,options,received;
  const cap=await createCapabilities({service:f.service,instanceRoot:f.root,engines:[],
    externalServers:[{id:'fixture',transport:'http',url:'http://127.0.0.1:34567/mcp'}],
    inputCapabilities:{elicitation:{form:{}}},
    onInputRequest:async request=>{received=request;return{action:'accept',content:{name:'Ada'}};},
    clientFactory:value=>{options=value;return{
      setRequestHandler:(method,run)=>{assert.equal(method,'elicitation/create');handler=run;},
      connect:async()=>{},close:async()=>{},listTools:async()=>({tools:[]})
    };},transportFactory:async()=>({})});
  t.after(()=>cap.close());await cap.list({projectId:'one',serverId:'fixture'}, testOwner);
  const params={message:'Your name?',requestedSchema:{type:'object',properties:{name:{type:'string'}}},_meta:{extra:'keep'}};
  const request={method:'elicitation/create',params};
  assert.deepEqual(await handler(request),{action:'accept',content:{name:'Ada'}});
  assert.equal(received.signal.aborted,false);
  const {signal,...requestFields}=received;
  assert.deepEqual(requestFields,{serverId:'fixture',projectId:'one',method:'elicitation/create',params,request});
  assert.equal(options.inputRequired.autoFulfill,true);
});

test('installed official SDK talks to a real MCP server and preserves tool and resource payloads',async t=>{
  const f=fixture(t);
  const server=new McpServer({name:'isolated-fixture',version:'1.0.0'});
  server.registerTool('echo',{description:'Echo data',inputSchema:z.object({text:z.string()})},async({text})=>({content:[{type:'text',text}],structuredContent:{text}}));
  server.registerResource('fixture','fixture://document',{mimeType:'text/plain'},async uri=>({contents:[{uri:uri.href,mimeType:'text/plain',text:'original resource'}]}));
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);t.after(()=>server.close());
  const cap=await createCapabilities({service:f.service,instanceRoot:f.root,engines:[],
    externalServers:[{id:'fixture',transport:'http',url:'http://127.0.0.1:34567/mcp'}],
    transportFactory:async()=>clientTransport});
  t.after(()=>cap.close());
  const catalog=await cap.list({projectId:'one',serverId:'fixture'}, testOwner);
  assert.equal(catalog.external.tools[0].name,'echo');
  const result=await cap.call({projectId:'one',capability:'mcp.fixture.tools.call',input:{name:'echo',arguments:{text:'中文 literal & %PATH%'}}}, testOwner);
  assert.equal(result.structuredContent.text,'中文 literal & %PATH%');
  const resource=await cap.call({projectId:'one',capability:'mcp.fixture.resources.read',input:{uri:'fixture://document'}}, testOwner);
  assert.equal(resource.contents[0].text,'original resource');
});

test('real modern MCP input_required completes through the explicit user input bridge',async t=>{
  const f=fixture(t);let questions=0,rounds=0;
  const server=new McpServer({name:'interactive-fixture',version:'1.0.0'});
  server.registerTool('confirm',{inputSchema:z.object({})},async(_args,context)=>{
    rounds++;
    if(!context.mcpReq.inputResponses?.answer)return inputRequired({
      inputRequests:{answer:inputRequired.elicit({message:'Continue?',requestedSchema:{type:'object',properties:{confirm:{type:'boolean'}},required:['confirm']}})}
    });
    return{content:[{type:'text',text:'confirmed'}],structuredContent:{response:context.mcpReq.inputResponses.answer}};
  });
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);t.after(()=>server.close());
  const cap=await createCapabilities({service:f.service,instanceRoot:f.root,engines:[],
    externalServers:[{id:'interactive',transport:'http',url:'http://127.0.0.1:34567/mcp'}],
    inputCapabilities:{elicitation:{form:{}}},
    onInputRequest:async({method,params})=>{questions++;assert.equal(method,'elicitation/create');assert.equal(params.message,'Continue?');return{action:'accept',content:{confirm:true}};},
    transportFactory:async()=>clientTransport});
  t.after(()=>cap.close());
  const result=await cap.call({projectId:'one',capability:'mcp.interactive.tools.call',input:{name:'confirm',arguments:{}}}, testOwner);
  assert.equal(result.isError,undefined,JSON.stringify(result));
  assert.equal(result.content[0].text,'confirmed');assert.equal(questions,1);assert.equal(rounds,2);
});

test('official stdio transport launches a native Node server with spaced Unicode paths and closes its child',async t=>{
  const f=fixture(t),directory=path.join(f.root,'MCP fixture 中文');
  fs.mkdirSync(directory);
  const filename=path.join(directory,'server entry.mjs');
  fs.writeFileSync(filename,[
    'import {McpServer} from '+JSON.stringify(import.meta.resolve('@modelcontextprotocol/server'))+';',
    'import {StdioServerTransport} from '+JSON.stringify(import.meta.resolve('@modelcontextprotocol/server/stdio'))+';',
    'const server=new McpServer({name:"stdio-fixture",version:"1.0.0"});',
    'server.registerTool("identity",{inputSchema:{}},async()=>({content:[{type:"text",text:process.argv[2]}],structuredContent:{pid:process.pid,literal:process.argv[2]}}));',
    'await server.connect(new StdioServerTransport());'
  ].join('\n'));
  const literal='中文 $(literal) & %PATH% "quoted"';
  const cap=await createCapabilities({service:f.service,instanceRoot:f.root,engines:[],
    externalServers:[{id:'native',transport:'stdio',command:process.execPath,args:[filename,literal]}]});
  t.after(()=>cap.close());
  const result=await cap.call({projectId:'one',capability:'mcp.native.tools.call',input:{name:'identity',arguments:{}}}, testOwner);
  assert.equal(result.structuredContent.literal,literal);
  const pid=result.structuredContent.pid;
  await cap.close();
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
});

test('closing one project closes only its external clients and prevents its new calls',async t=>{
  const f=fixture(t),closed=[];
  const original=f.service.project;
  f.service.project=(id,options)=>id==='two'?{...f.project,id:'two'}:original(id,options);
  let sequence=0;
  const cap=await createCapabilities({service:f.service,instanceRoot:f.root,engines:[],
    externalServers:[{id:'fixture',transport:'http',url:'http://127.0.0.1:34567/mcp'}],
    clientFactory:()=>{const id=++sequence;return{connect:async()=>{},close:async()=>closed.push(id),listTools:async()=>({tools:[]})};},
    transportFactory:async()=>({})});
  await cap.list({projectId:'one',serverId:'fixture'}, testOwner);
  await cap.list({projectId:'two',serverId:'fixture'}, testOwner);
  await cap.closeProject('one');assert.deepEqual(closed,[1]);
  await assert.rejects(cap.list({projectId:'one'}, testOwner),error=>error.code==='project_closing');
  await cap.list({projectId:'two',serverId:'fixture'}, testOwner);assert.equal(sequence,2);
  f.project.access='read';
  await cap.reopenProject('one');
  await cap.list({projectId:'one',serverId:'fixture'}, testOwner);assert.equal(sequence,3);
  await assert.rejects(cap.call({projectId:'one',capability:'mcp.fixture.tools.call',input:{name:'write'}}, testOwner),/read only/);
  await cap.close();assert.deepEqual(closed,[1,2,3]);
});

test('concurrent engine calls keep apart who may decide, and an engine is set up only where the owner decides',async t=>{
  const f=fixture(t);let count=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const engine={manifest:{id:'devmate.fixture',permissions:{}},settingsSchema:z.object({value:z.string().optional()}),defaultSettings:{},
    activate(context){
      context.server.registerTool('read',{inputSchema:{},annotations:{readOnlyHint:true}},async()=>context.toolText({ok:true}));
      context.server.registerTool('configure',{inputSchema:{value:z.string()},annotations:{readOnlyHint:false}},async({value})=>{
        if(++count===2)release();await gate;
        context.updateSettings({value});return context.toolText({value});
      });
    }};
  const cap=await createCapabilities({service:f.service,instanceRoot:f.root,engines:[engine]});t.after(()=>cap.close());
  assert.equal((await cap.call({projectId:'one',capability:'fixture.read'})).structuredContent.ok,true);
  const results=await Promise.allSettled([
    cap.call({projectId:'one',capability:'fixture.configure',input:{value:'owner'}},testOwner),
    // The owner reached through a connected client sets an engine up only with the full access profile (ownerDecides).
    cap.call({projectId:'one',capability:'fixture.configure',input:{value:'remote'}})
  ]);
  assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');
  assert.equal(results[1].reason.code,'forbidden');assert.match(results[1].reason.message,/set up by the owner/);
  assert.deepEqual(f.settings.get('capability.one.fixture'),{value:'owner'});
  // The read-only call never reaches something that changes.
  await assert.rejects(cap.call({projectId:'one',capability:'fixture.configure',input:{value:'query'}},{...testOwner,readOnly:true}),error=>error.code==='forbidden'&&/capability_call/.test(error.message));
  assert.equal((await cap.call({projectId:'one',capability:'fixture.read'},{readOnly:true})).structuredContent.ok,true);
  assert.deepEqual(f.settings.get('capability.one.fixture'),{value:'owner'});
});

test('per-call cancellation reaches the official MCP request and does not close another request',async t=>{
  const f=fixture(t),controller=new AbortController();
  const server=new McpServer({name:'cancel-fixture',version:'1.0.0'});
  let started;
  const entered=new Promise(resolve=>{started=resolve;});
  server.registerTool('wait',{inputSchema:z.object({})},async(_args,context)=>{
    started();await new Promise(resolve=>context.mcpReq.signal.addEventListener('abort',resolve,{once:true}));
    return{content:[{type:'text',text:'stopped'}]};
  });
  server.registerResource('alive','fixture://alive',{},async uri=>({contents:[{uri:uri.href,text:'still connected'}]}));
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);t.after(()=>server.close());
  const cap=await createCapabilities({service:f.service,instanceRoot:f.root,engines:[],
    externalServers:[{id:'fixture',transport:'http',url:'http://127.0.0.1:34567/mcp'}],transportFactory:async()=>clientTransport});
  t.after(()=>cap.close());
  const work=cap.call({projectId:'one',capability:'mcp.fixture.tools.call',input:{name:'wait',arguments:{}}},{signal:controller.signal});
  const rejected=assert.rejects(work);await entered;controller.abort(new Error('cancel this call'));await rejected;
  const result=await cap.call({projectId:'one',capability:'mcp.fixture.resources.read',input:{uri:'fixture://alive'}});
  assert.equal(result.contents[0].text,'still connected');
});

test('failed cleanup retains ownership, forbids calls, and retries both project and runtime close',async t=>{
  const f=fixture(t);let attempts=0;
  const engine={manifest:{id:'devmate.retry',permissions:{}},activate(context){
    context.server.registerTool('status',{inputSchema:{},annotations:{readOnlyHint:true}},()=>({ready:true}));
  },deactivate(){if(++attempts===1)throw new Error('exit is unconfirmed');}};
  const cap=await createCapabilities({service:f.service,instanceRoot:f.root,engines:[engine]});
  await cap.list({projectId:'one'}, testOwner);
  await assert.rejects(cap.closeProject('one'),/unconfirmed|shutdown/);
  await assert.rejects(cap.call({projectId:'one',capability:'retry.status'}, testOwner),/closing/);
  await cap.closeProject('one');assert.equal(attempts,2);
  await cap.reopenProject('one');await cap.list({projectId:'one'}, testOwner);
  attempts=0;
  await assert.rejects(cap.close(),/unconfirmed|shutdown/);
  await assert.rejects(cap.list({projectId:'one'}, testOwner),/closing/);
  await cap.close();assert.equal(attempts,2);
});
