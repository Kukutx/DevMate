import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createRuntimeClient } from '../runtime/client.mjs';
const require=createRequire(import.meta.url);
const {createVscodeRuntimeEntry}=require('../vscode-host/runtime-entry.cjs');
const {createObsidianRuntimeEntry}=require('../obsidian-plugin/src/runtime-entry.cjs');

function clientFixture() {
  const calls={start:0,stop:0,dispose:0,subscribe:0,unsubscribe:0,scoped:[]};
  let running=false;
  return {
    calls,
    client:{
      start:async()=>{calls.start++;running=true;},
      stop:async()=>{calls.stop++;running=false;},
      status:async()=>({running,state:running?'ready':'stopped'}),
      snapshot:async()=>({projects:[{id:'project',name:'Example'}]}),
      operations:async()=>({items:[{name:'project.list'}]}),
      call:async(name, input)=>{
        if(name==='window.attach')return{windowId:input.windowId,title:input.title,trusted:input.trusted,
          roots:input.roots.map(root=>({...root,projectId:'project'})),selectedProjectId:input.roots.length===1?'project':null};
        if(name==='window.detach')return{detached:true};
        if(name==='window.heartbeat')return{attached:true};
        if(name==='window.select')return{selectedProjectId:input.projectId,
          roots:[{name:'Example',root:process.cwd(),projectId:'project'}]};
        return{};
      },
      workbenchUrl:async()=>'http://127.0.0.1:32123',
      subscribe:(_listener,_onError,_onConnected,options={})=>{calls.subscribe++;calls.scoped.push(options.scoped!==false);return{dispose:()=>{calls.unsubscribe++;}};},
      dispose:()=>{calls.dispose++;}
    }
  };
}

test('VS Code activation and deactivation only attach and detach; Start is explicit', async () => {
  const fixture=clientFixture();
  const commands=new Map();
  const vscode={
    TreeItem:class {constructor(label){this.label=label;}},
    TreeItemCollapsibleState:{None:0},
    EventEmitter:class {constructor(){this.event=()=>{};}fire(){}dispose(){}},
    workspace:{name:'Fixture window',isTrusted:true,workspaceFolders:[
      {name:'Example',uri:{scheme:'file',fsPath:process.cwd()}}
    ],getConfiguration:()=>({get:(_name,fallback)=>fallback})},
    window:{
      createOutputChannel:()=>({appendLine(){},show(){},dispose(){}}),
      registerTreeDataProvider:()=>({dispose(){}}),
      showErrorMessage:async message=>{throw new Error(message);},
      showWarningMessage:async()=>undefined
    },
    commands:{registerCommand:(id,handler)=>{commands.set(id,handler);return{dispose(){}};}},
    env:{openExternal:async()=>true},Uri:{parse:value=>value}
  };
  const entry=createVscodeRuntimeEntry(vscode,{client:fixture.client});
  await entry.activate({subscriptions:[]});
  assert.equal(fixture.calls.start,0);
  assert.equal(fixture.calls.stop,0);
  await commands.get('devMate.runtime.start')();
  assert.equal(fixture.calls.start,1);
  assert.equal(fixture.calls.subscribe,1);
  await commands.get('devMate.runtime.stop')();
  assert.equal(fixture.calls.stop,0,'a window must not stop the shared runtime without explicit confirmation');
  assert.ok(entry.provider.getChildren().some(item=>item.label==='Example'));
  assert.equal(entry.attachment.selectedProjectId,'project');
  await entry.deactivate();
  assert.equal(fixture.calls.stop,0);
  assert.equal(fixture.calls.unsubscribe,1);
  assert.equal(fixture.calls.dispose,1);
});

test('Obsidian registers sidebar and commands without creating a runtime or stopping it on unload', async () => {
  const fixture=clientFixture();
  const commands=new Map(),views=[];
  const plugin={
    app:{workspace:{getLeavesOfType:()=>[]}},
    registerView:(id,create)=>views.push({id,create}),
    addRibbonIcon:()=>({}),
    addCommand:command=>commands.set(command.id,command.callback)
  };
  const entry=createObsidianRuntimeEntry(plugin,{
    client:fixture.client,obsidian:{ItemView:class{},Notice:class{}}
  });
  await entry.activate();
  assert.equal(views[0].id,'devmate-runtime');
  assert.equal(fixture.calls.start,0);
  assert.equal(fixture.calls.stop,0);
  await commands.get('runtime-start')();
  assert.equal(fixture.calls.start,1);
  await entry.deactivate();
  assert.equal(fixture.calls.stop,0);
  assert.equal(fixture.calls.dispose,1);
});

test('SSE client keeps owner token in headers and parses fragmented events', async () => {
  const encoder=new TextEncoder();
  const stream=new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: changed\r'));
      controller.enqueue(encoder.encode('\ndata: {"projectId":"one"}\r\n\r\nid: 2\nevent: task\ndata: {"id":"two"}\n\n'));
      controller.close();
    }
  });
  const client=createRuntimeClient({
    baseUrl:'http://127.0.0.1:32123',ownerToken:'fake-owner-token',
    fetchImpl:async(url,options)=>{
      assert.equal(String(url),'http://127.0.0.1:32123/events');
      assert.equal(options.headers.Authorization,'Bearer fake-owner-token');
      assert.equal(options.redirect,'error');
      return new Response(stream,{status:200,headers:{'content-type':'text/event-stream'}});
    }
  });
  const actual=[];
  for await(const event of client.events())actual.push(event);
  assert.deepEqual(actual,[
    {type:'changed',data:{projectId:'one'}},
    {type:'task',id:'2',data:{id:'two'}}
  ]);
});


test('a multi-root VS Code window listens to all its shared folders with a stream that needs no selection', async () => {
  const fixture=clientFixture(),commands=new Map();
  const vscode={
    TreeItem:class{constructor(label){this.label=label;}},
    TreeItemCollapsibleState:{None:0},
    EventEmitter:class{constructor(){this.event=()=>{};}fire(){}dispose(){}},
    workspace:{name:'Multi root',isTrusted:true,workspaceFolders:[
      {name:'A',uri:{scheme:'file',fsPath:process.cwd()}},
      {name:'B',uri:{scheme:'file',fsPath:process.cwd()+'-other'}}
    ],getConfiguration:()=>({get:(_name,fallback)=>fallback})},
    window:{
      createOutputChannel:()=>({appendLine(){},show(){},dispose(){}}),
      registerTreeDataProvider:()=>({dispose(){}}),
      showErrorMessage:async error=>{throw Error(error);},
      showQuickPick:async()=>undefined
    },
    commands:{registerCommand:(name,handler)=>{commands.set(name,handler);return{dispose(){}};}},
    env:{openExternal:async()=>true},Uri:{parse:value=>value}
  };
  const entry=createVscodeRuntimeEntry(vscode,{client:fixture.client});
  try {
    await entry.activate({subscriptions:[]});
    await commands.get('devMate.runtime.start')();
    assert.equal(entry.attachment.selectedProjectId,null);
    // A stream narrowed to the window's selected project would be refused while nothing is selected. The window asks
    // for the unnarrowed one instead and picks out what concerns its own folders, so an agent waiting in any of them is heard.
    assert.ok(fixture.calls.subscribe>=1);
    assert.equal(fixture.calls.scoped.includes(true),false,'never a stream that depends on a selection');
    await commands.get('devMate.runtime.selectWorkspace')('project');
    assert.equal(fixture.calls.scoped.includes(true),false);
    assert.equal(fixture.calls.subscribe-fixture.calls.unsubscribe,1,'exactly one stream is open at a time');
  } finally {await entry.deactivate();}
  assert.equal(fixture.calls.unsubscribe,fixture.calls.subscribe,'and none is left open');
});
