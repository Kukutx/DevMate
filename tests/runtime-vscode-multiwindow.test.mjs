import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fixture, until } from './runtime-integration-fixtures.mjs';
import { startRuntime } from '../runtime/main.mjs';
import { stopRuntime } from '../runtime/launcher.mjs';
const require=createRequire(import.meta.url);
const { createVscodeRuntimeEntry } = require('../vscode-host/runtime-entry.cjs');
const { createHostClient } = require('../runtime/host-client.cjs');
import { __test as tools } from '../runtime/platform/tools.mjs';

// One VS Code window: its folders, its settings and what the person at it answers.
function fakeWindow(instanceRoot, name, roots, { share = 'Read and write', settings = {}, client, hostOptions = {}, memory = new Map() } = {}) {
  const commands=new Map(),asked=[],shown=[],statusBars=[],providers=[],changed=[],trusted=[];
  const vscode={
    TreeItem:class {constructor(label){this.label=label;}},
    TreeItemCollapsibleState:{None:0},StatusBarAlignment:{Left:1},
    EventEmitter:class {constructor(){this.fired=0;this.event=()=>{};}fire(){this.fired++;}dispose(){}},
    McpHttpServerDefinition:class {constructor(label,uri,headers,version){Object.assign(this,{label,uri,headers,version});}},
    lm:{registerMcpServerDefinitionProvider:(id,provider)=>{providers.push({id,provider});return{dispose(){}};}},
    workspace:{
      name,isTrusted:true,
      workspaceFolders:roots.map(root=>({name:path.basename(root),uri:{scheme:'file',fsPath:root}})),
      getConfiguration:()=>({get:(key,fallback)=>key==='runtimeInstanceDirectory'?instanceRoot:Object.hasOwn(settings,key)?settings[key]:fallback}),
      onDidChangeWorkspaceFolders:()=>({dispose(){}}),
      onDidChangeConfiguration:listener=>{changed.push(listener);return{dispose(){}};},
      onDidGrantWorkspaceTrust:listener=>{trusted.push(listener);return{dispose(){}};}
    },
    window:{
      createOutputChannel:()=>({appendLine(line){shown.push(line);},show(){},dispose(){}}),
      registerTreeDataProvider:()=>({dispose(){}}),
      createStatusBarItem:()=>{const item={show(){item.visible=true;},dispose(){}};statusBars.push(item);return item;},
      showErrorMessage:async message=>{shown.push('error: '+message);},
      showInformationMessage:async(message,...actions)=>{asked.push(message);return typeof share==='function'?share(message,actions):actions.includes(share)?share:undefined;},
      showQuickPick:async items=>items[0]
    },
    commands:{registerCommand:(id,callback)=>{commands.set(id,callback);return{dispose(){}};},executeCommand:async(id,...args)=>commands.get(id)?.(...args)},
    Uri:{parse:value=>value},env:{openExternal:async()=>true}
  };
  let localClient=client;
  const entry=createVscodeRuntimeEntry(vscode,client?{client}:{clientFactory:options=>{
    localClient=createHostClient({...options,...hostOptions});return localClient;
  }});
  const context={subscriptions:[],workspaceState:{get:(key,fallback)=>memory.has(key)?memory.get(key):fallback,update:async(key,value)=>{memory.set(key,value);}}};
  const set=(key,value)=>{settings[key]=value;for(const listener of changed)listener({affectsConfiguration:name=>name==='devMate'||name==='devMate.'+key});};
  const trust=()=>{vscode.workspace.isTrusted=true;for(const listener of trusted)listener();};
  return {entry,commands,context,asked,shown,memory,statusBars,providers,set,trust,get client(){return localClient;},vscode,
    activate:()=>entry.activate(context),bound:()=>until(()=>entry.attachment?.selectedProjectId,name+' bound its folder')};
}
async function freePort() {
  const server=net.createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}

test('two real VS Code host instances attach independent windows to the same local runtime',async t=>{
  const f=await fixture(t);
  const roots=['alpha','beta'].map(name=>{const root=path.join(f.temp,'vscode-'+name);fs.mkdirSync(root);return root;});
  const windows=roots.map((root,i)=>fakeWindow(f.instanceRoot,'Editor '+i,[root]));
  t.after(async()=>{for(const window of windows)await window.entry.deactivate();});
  await Promise.all(windows.map(window=>window.activate()));
  await Promise.all(windows.map(window=>window.bound()));
  const attachments=windows.map(window=>window.entry.attachment);
  assert.notEqual(attachments[0].windowId,attachments[1].windowId);
  assert.notEqual(attachments[0].selectedProjectId,attachments[1].selectedProjectId);
  const listed=await f.call('window.list');
  assert.equal(listed.items.length,2);
  for(let i=0;i<2;i++){
    assert.equal(windows[i].asked.length,1,'each window said once what it shares');
    assert.match(windows[i].asked[0],/^DevMate shares "vscode-(alpha|beta)" with connected AI clients \(read and write\)\.( DevMate keeps running after you close this window, until you stop it \(DevMate: Stop DevMate Runtime\)\.)?$/);
    const local=await windows[i].client.call('project.list');
    assert.deepEqual(local.items.map(project=>project.id),[attachments[i].selectedProjectId]);
    await assert.rejects(windows[i].client.call('workspace.files',{projectId:attachments[1-i].selectedProjectId}),
      error=>error.code==='scope_mismatch');
    assert.equal(windows[i].statusBars[0].text,'$(plug) DevMate');assert.equal(windows[i].statusBars[0].command,'devMate.runtime.menu');
    // The editor's own language-model features get the local endpoint without configuration.
    const [definition]=await windows[i].providers[0].provider.provideMcpServerDefinitions();
    assert.equal(windows[i].providers[0].id,'devMate.runtime');assert.equal(definition.uri,'http://127.0.0.1:'+f.runtime.port+'/mcp');
  }
  await windows[0].entry.deactivate();
  assert.equal((await f.call('window.list')).items.length,1);
  assert.equal((await windows[1].client.call('project.list')).items[0].id,attachments[1].selectedProjectId);
  assert.equal(f.runtime.health.status,'ready');
});

test('with sharing set to ask, a window shares a folder only after its user agrees, and remembers "Don\'t share"',async t=>{
  const f=await fixture(t),root=path.join(f.temp,'undecided');fs.mkdirSync(root);
  const window=fakeWindow(f.instanceRoot,'Careful editor',[root],{share:'Don\'t share',settings:{shareFolders:'ask'}});
  t.after(()=>window.entry.deactivate());
  await window.activate();
  await until(()=>window.asked.length===1,'the window asked');
  await until(()=>window.memory.get('devMate.declinedFolders')?.length===1,'the answer was remembered');
  assert.match(window.asked[0],/Let AI clients connected to DevMate work in "undecided"\?/);
  assert.equal(window.entry.attachment.selectedProjectId,null);
  assert.deepEqual((await f.call('project.list')).items,[],'nothing was shared');
  const unshared=window.entry.provider.getChildren().find(item=>item.label==='undecided');
  assert.equal(unshared.command.command,'devMate.runtime.registerFolder');assert.match(unshared.description,/Not shared/);
  await window.entry.refresh();await window.entry.refresh();
  assert.equal(window.asked.length,1,'a declined folder is not asked about again');
  // The decision can be made later, deliberately, from the command.
  await window.commands.get('devMate.runtime.registerFolder')();
  const project=(await f.call('project.list')).items[0];
  assert.equal(window.entry.attachment.selectedProjectId,project.id);assert.equal(project.access,'write');
  assert.equal(window.entry.provider.getChildren().find(item=>item.label==='undecided').command.command,'devMate.runtime.selectWorkspace');
});

test('a multi-root host keeps its chosen folder across refresh and never borrows another window selection',async t=>{
  const f=await fixture(t),roots=['one','two'].map(name=>{const root=path.join(f.temp,'multiple-'+name);fs.mkdirSync(root);return root;});
  const window=fakeWindow(f.instanceRoot,'Multi root editor',roots);
  t.after(()=>window.entry.deactivate());
  await window.activate();
  await until(()=>window.entry.attachment?.roots.every(folder=>folder.projectId),'both folders shared');
  // With several shared folders the window works on none until its user chooses.
  assert.equal(window.entry.attachment.selectedProjectId,null);
  const chosen=window.entry.attachment.roots[1].projectId;
  await window.commands.get('devMate.runtime.selectWorkspace')(chosen);
  assert.equal(window.entry.attachment.selectedProjectId,chosen);
  await window.entry.refresh();
  assert.equal(window.entry.attachment.selectedProjectId,chosen);
  assert.deepEqual((await window.client.call('project.list')).items.map(item=>item.id),[chosen]);
  // A second window on the same two, already shared, folders has to choose: it borrows nothing from the first.
  const other=fakeWindow(f.instanceRoot,'Second multi root editor',roots);
  t.after(()=>other.entry.deactivate());
  await other.activate();
  await until(()=>other.asked.length===2,'the second window named what is shared');
  assert.ok(other.asked.every(message=>/^DevMate shares /.test(message)),'it is told, not asked');
  assert.equal(other.entry.attachment.selectedProjectId,null);
  assert.equal(window.entry.attachment.selectedProjectId,chosen);
});


test('a multi-root editor survives runtime restart and restores its own selected project',async t=>{
  const f=await fixture(t),roots=['A','B'].map(name=>{const root=path.join(f.temp,'restart-'+name);fs.mkdirSync(root);return root;});
  const window=fakeWindow(f.instanceRoot,'Restart editor',roots);
  let replacement;
  try {
    await window.activate();
    await until(()=>window.entry.attachment?.roots.every(folder=>folder.projectId),'both folders shared');
    const selected=window.entry.attachment.roots[1].projectId;
    await window.commands.get('devMate.runtime.selectWorkspace')(selected);
    assert.equal(window.entry.attachment.selectedProjectId,selected);
    const windowId=window.entry.windowId;
    await f.runtime.stop();
    replacement=await startRuntime({instanceRoot:f.instanceRoot,port:0});
    await until(()=>replacement.service.windows.list().some(item=>
      item.windowId===windowId&&item.selectedProjectId===selected),'editor reattached after runtime restart',10000);
    assert.equal((await window.client.call('project.list')).items[0].id,selected);
    assert.equal(replacement.service.windows.list().length,1);
    assert.equal(window.asked.length,2,'a restart says nothing again');
  } finally {
    await window.entry.deactivate();
    await replacement?.stop();
  }
});

test('three windows starting DevMate at the same moment share one runtime; closing or stopping from one is seen by the others',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-windows-start-')),instanceRoot=path.join(base,'instance');
  const port=await freePort();
  const roots=['x','y','z'].map(name=>{const root=path.join(base,'folder-'+name);fs.mkdirSync(root);return root;});
  const windows=roots.map((root,i)=>fakeWindow(instanceRoot,'Window '+i,[root],{settings:{runtimePort:port,nodeCommandPath:process.execPath},hostOptions:{timeoutMs:30000}}));
  t.after(async()=>{
    for(const window of windows)await window.entry.deactivate();
    await stopRuntime({instanceRoot,timeoutMs:15000}).catch(()=>{});
    fs.rmSync(base,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  await Promise.all(windows.map(window=>window.activate()));
  assert.ok(windows.every(window=>window.entry.state.state==='stopped'),'nothing starts by itself');
  await Promise.all(windows.map(window=>window.commands.get('devMate.runtime.start')()));
  assert.deepEqual(windows.flatMap(window=>window.shown.filter(line=>line.startsWith('error:'))),[]);
  await Promise.all(windows.map(window=>window.bound()));
  assert.equal(new Set(windows.map(window=>window.entry.state.record.pid)).size,1,'one runtime process for all three windows');
  assert.equal(new Set(windows.map(window=>window.entry.state.record.generation)).size,1);
  assert.equal(new Set(windows.map(window=>window.entry.attachment.selectedProjectId)).size,3);
  assert.equal((await windows[0].client.call('window.list')).items.length,1,'a window sees only itself');
  // Closing one window leaves the shared runtime and the other windows untouched.
  await windows[2].entry.deactivate();
  assert.equal((await windows[0].entry.refresh()).running,true);
  assert.equal((await windows[1].client.call('project.list')).items.length,1);
  // Stopping is a decision for everyone and is asked for explicitly; declining it changes nothing.
  windows[0].vscode.window.showWarningMessage=async()=>undefined;
  await windows[0].commands.get('devMate.runtime.stop')();
  assert.equal((await windows[1].entry.refresh()).running,true);
  windows[0].vscode.window.showWarningMessage=async(_message,_options,action)=>action;
  await windows[0].commands.get('devMate.runtime.stop')();
  const seen=await windows[1].entry.refresh();
  assert.deepEqual([seen.state,seen.running,seen.crashed],['stopped',false,undefined],'the other window sees a clean stop, not a crash');
  assert.equal(windows[1].entry.attachment,null);assert.equal(windows[1].statusBars[0].text,'$(circle-slash) DevMate');
});

// The remaining behaviours depend only on what the host is told, so a scripted client stands in for the runtime.
function scripted(overrides={}) {
  const calls=[];
  const state={running:false,crashed:false,outdated:false,starts:0,stops:0};
  const client={calls,state,dispose(){},subscribe:()=>({dispose(){}}),snapshot:async()=>({}),operations:async()=>({items:[]}),
    workbenchUrl:async()=>'http://127.0.0.1:1/?code=x',mcpUrl:async()=>'http://127.0.0.1:1/mcp',
    start:async()=>{state.starts++;state.running=true;state.crashed=false;},stop:async()=>{state.stops++;state.running=false;},
    status:async()=>state.running?{state:'ready',running:true,outdated:state.outdated,record:{generation:'g'+state.starts,port:1,version:'4.0.0'},host:{version:'4.1.0'},health:{}}
      :{state:'stopped',running:false,...(state.crashed?{crashed:true}:{})},
    call:async(name,input)=>{calls.push([name,input]);
      if(name==='window.attach')return{windowId:input.windowId,roots:input.roots.map(item=>({...item,opened:item.root,access:'write',projectId:'project-'+path.basename(item.root)})),selectedProjectId:input.roots.length===1?'project-'+path.basename(input.roots[0].root):null};
      return{};},...overrides};
  return client;
}

test('with auto-start a runtime that died is brought back, a bounded number of times; an explicit stop is respected',async()=>{
  const client=scripted(),window=fakeWindow('unused','Keeper',[process.cwd()],{client,settings:{autoStart:true}});
  await window.activate();
  assert.equal(client.state.starts,1,'auto-start brought it up with the editor');
  // A clean stop from anywhere leaves nothing to recover.
  client.state.running=false;
  await window.entry.refresh();
  assert.equal(client.state.starts,1);
  // A crash leaves its record behind; that is what recovery acts on.
  for(let round=0;round<5;round++){client.state.running=false;client.state.crashed=true;await window.entry.refresh();}
  assert.equal(client.state.starts,4,'three recoveries, then it stops trying instead of looping');
  assert.ok(window.shown.some(line=>/stopped unexpectedly/.test(line)));
  await window.entry.deactivate();
  const manual=scripted(),plain=fakeWindow('unused','Manual',[process.cwd()],{client:manual});
  await plain.activate();
  manual.state.crashed=true;
  await plain.entry.refresh();
  assert.equal(manual.state.starts,0,'without auto-start nothing is started on the user\'s behalf');
  await plain.entry.deactivate();
});

test('a newer extension offers to restart an older shared runtime once; diagnostics keep their errors under a flood of hints',async()=>{
  const client=scripted();client.state.running=true;client.state.outdated=true;client.state.starts=1;
  const answers=[];
  const window=fakeWindow('unused','Updated',[process.cwd()],{client,share:(message,actions)=>{answers.push(message);return /Restart the shared runtime/.test(message)?'Restart':actions[0];}});
  const file=path.join(process.cwd(),'runtime','main.mjs'),range={start:{line:0,character:0},end:{line:0,character:1}};
  const flood=Array.from({length:6000},(_,index)=>({severity:3,range,message:'hint '+index}));
  window.vscode.languages={getDiagnostics:()=>[[{scheme:'file',fsPath:file},[...flood,{severity:0,range,message:'the one real error'}]]]};
  await window.activate();
  await until(()=>client.state.stops===1&&client.state.starts===2,'the runtime was restarted on request');
  assert.match(answers.find(message=>/Restart the shared runtime/.test(message)),/version 4\.0\.0; this extension ships 4\.1\.0/);
  await window.entry.refresh();await window.entry.refresh();
  assert.equal(answers.filter(message=>/Restart the shared runtime/.test(message)).length,1,'the offer is made once');
  await until(()=>client.calls.some(([name])=>name==='window.context'),'editor state published');
  const published=client.calls.findLast(([name])=>name==='window.context')[1].context.diagnostics;
  assert.equal(published.length,1000);assert.deepEqual([published[0].severity,published[0].message],['error','the one real error']);
  // Sharing editor state is the user's choice.
  const quiet=scripted();quiet.state.running=true;
  const silent=fakeWindow('unused','Private',[process.cwd()],{client:quiet,settings:{shareEditorContext:false}});
  silent.vscode.languages=window.vscode.languages;
  silent.vscode.window.activeTextEditor={document:{uri:{scheme:'file',fsPath:file},languageId:'javascript',lineCount:1,getText:()=>'secret'},selection:{...range,isEmpty:false}};
  await silent.activate();
  await until(()=>quiet.calls.some(([name])=>name==='window.context'),'an empty state is published');
  assert.deepEqual(quiet.calls.findLast(([name])=>name==='window.context')[1].context,{active:null,open:[],diagnostics:[]});
  await window.entry.deactivate();await silent.entry.deactivate();
});

test('by default an opened folder is shared read and write and says so once; its owner can make it read only or take it out, and it stays out',async t=>{
  const f=await fixture(t),root=path.join(f.temp,'default-share');fs.mkdirSync(root);
  const picks=[],memory=new Map();
  const open=()=>{
    const window=fakeWindow(f.instanceRoot,'Default sharing',[root],{memory});
    window.vscode.window.showQuickPick=async items=>{const wanted=picks.shift();return items.find(item=>item.label===wanted);};
    window.vscode.window.showWarningMessage=async(message,options,action)=>{window.confirmed=[message,options];return action;};
    return window;
  };
  const window=open();
  t.after(()=>window.entry.deactivate());
  const change=async answer=>{picks.push(answer);await window.commands.get('devMate.runtime.registerFolder')();};
  const project=async()=>(await f.call('project.list')).items[0];
  await window.activate();await window.bound();
  assert.deepEqual([(await project()).access,(await project()).name],['write','default-share']);
  await until(()=>window.asked.length===1,'the window said what it shares');
  assert.match(window.asked[0],/^DevMate shares "default-share" with connected AI clients \(read and write\)\.( DevMate keeps running after you close this window, until you stop it \(DevMate: Stop DevMate Runtime\)\.)?$/);
  await window.entry.refresh();
  assert.equal(window.asked.length,1,'it says so once');
  assert.match(window.entry.provider.getChildren().find(item=>item.label==='default-share').description,/^Shared, read and write/);
  // Read only: clients keep reading and lose everything else, at once.
  await change('Read only');
  assert.equal((await project()).access,'read');assert.equal(window.entry.attachment.roots[0].access,'read');
  await assert.rejects(window.client.call('workspace.write',{path:'x.txt',text:'x'}),error=>error.code==='read_only');
  assert.equal((await window.client.call('workspace.files',{})).items.length,0);
  await change('Read and write');
  assert.equal((await window.client.call('workspace.write',{path:'x.txt',text:'x'})).written,true);
  // Not shared: asked for explicitly, confirmed, and remembered.
  await change('Do not share');
  assert.equal(window.confirmed[1].modal,true);assert.match(window.confirmed[0],/Stop sharing "default-share"/);
  assert.equal(await project(),undefined);
  assert.deepEqual([window.entry.attachment.selectedProjectId,window.entry.attachment.roots[0].projectId],[null,null]);
  assert.equal(fs.readFileSync(path.join(root,'x.txt'),'utf8'),'x','the files are untouched');
  await window.entry.refresh();await window.entry.refresh();
  assert.equal(await project(),undefined,'a folder taken out is not shared again by itself');
  // Reopening the same workspace later keeps that decision.
  const reopened=open();
  t.after(()=>reopened.entry.deactivate());
  await reopened.activate();
  assert.equal(await project(),undefined);assert.equal(reopened.asked.length,0);
  // The owner can bring it back, with the access they choose.
  picks.push('Read only');await reopened.commands.get('devMate.runtime.registerFolder')();
  assert.equal((await project()).access,'read');
  await reopened.entry.refresh();
  assert.equal((await project()).access,'read','sharing by default never widens an access the owner chose');
});

test('the sharing setting decides what happens to a folder nobody has decided about',async t=>{
  const f=await fixture(t);
  const folder=name=>{const root=path.join(f.temp,name);fs.mkdirSync(root);return root;};
  const readOnly=fakeWindow(f.instanceRoot,'Read only by default',[folder('ro')],{settings:{shareFolders:'readOnly'}});
  const never=fakeWindow(f.instanceRoot,'Shares nothing',[folder('none')],{settings:{shareFolders:'never'}});
  const untrusted=fakeWindow(f.instanceRoot,'Untrusted',[folder('untrusted')]);
  untrusted.vscode.workspace.isTrusted=false;
  t.after(async()=>{for(const window of [readOnly,never,untrusted])await window.entry.deactivate();});
  await Promise.all([readOnly,never,untrusted].map(window=>window.activate()));
  await readOnly.bound();
  assert.deepEqual((await f.call('project.list')).items.map(item=>[item.name,item.access]),[['ro','read']]);
  assert.deepEqual([never.entry.attachment.roots[0].projectId,never.asked.length],[null,0]);
  assert.deepEqual(untrusted.entry.attachment.roots,[],'an untrusted workspace offers no folder at all');
});

test('a window offers the ripgrep its editor ships, in either layout, so searching needs no separate install',async t=>{
  const f=await fixture(t);
  const name=process.platform==='win32'?'rg.exe':'rg';
  const install=(label,...segments)=>{const app=path.join(f.temp,label,'resources','app'),bin=path.join(app,...segments);fs.mkdirSync(bin,{recursive:true});fs.writeFileSync(path.join(bin,name),'');return{app,rg:path.join(bin,name)};};
  const current=install('editor-current','node_modules.asar.unpacked','@vscode','ripgrep-universal','bin',process.platform+'-'+process.arch);
  const classic=install('editor-classic','node_modules','@vscode','ripgrep','bin');
  const remembered=()=>JSON.parse(fs.readFileSync(path.join(f.instanceRoot,'tools.json'),'utf8'));
  const windows=[];
  t.after(async()=>{for(const window of windows)await window.entry.deactivate();tools.forget();});
  for(const [label,editor] of [['current',current],['classic',classic]]){
    const root=path.join(f.temp,'project-'+label);fs.mkdirSync(root);
    const window=fakeWindow(f.instanceRoot,'Editor '+label,[root]);
    window.vscode.env.appRoot=editor.app;
    windows.push(window);
    await window.activate();await window.bound();
    assert.deepEqual(remembered(),{rg:editor.rg});
  }
  // An editor without a bundled copy (or one laid out differently) offers nothing and attaches all the same.
  const bare=fakeWindow(f.instanceRoot,'Editor bare',[(()=>{const root=path.join(f.temp,'project-bare');fs.mkdirSync(root);return root;})()]);
  bare.vscode.env.appRoot=path.join(f.temp,'no-such-editor');
  windows.push(bare);
  await bare.activate();await bare.bound();
  assert.deepEqual(remembered(),{rg:classic.rg});
});

test('a window with several shared folders hears about every shared folder before its user has chosen one, and only about its own',async t=>{
  const f=await fixture(t),roots=['api','web'].map(name=>{const root=path.join(f.temp,'several-'+name);fs.mkdirSync(root);return root;});
  const elsewhere=path.join(f.temp,'several-elsewhere');fs.mkdirSync(elsewhere);
  const window=fakeWindow(f.instanceRoot,'Monorepo editor',roots);
  t.after(()=>window.entry.deactivate());
  await window.activate();
  await until(()=>window.entry.attachment?.roots.every(folder=>folder.projectId),'both folders shared');
  assert.equal(window.entry.attachment.selectedProjectId,null);
  assert.match(window.statusBars[0].tooltip,/Several folders are shared: choose the one this window works in/);
  const other=await f.call('project.create',{root:elsewhere});
  const store=f.runtime.service.store,waiting=projectId=>store.create('approval',{projectId,status:'pending',summary:'Run the migration'});
  await until(()=>window.asked.length===2,'the two sharing notices');
  // The stream starts at "now"; give it the moment it needs to connect before something happens.
  await new Promise(resolve=>setTimeout(resolve,500));
  waiting(other.id);
  const mine=waiting(window.entry.attachment.roots[1].projectId);
  await until(()=>window.asked.some(message=>/^An agent is waiting for your approval: Run the migration/.test(message)),'the approval is announced');
  assert.equal(window.asked.filter(message=>/waiting for your approval/.test(message)).length,1,'what happens in a folder of another window is not announced here');
  assert.ok(mine.id);
  // Sharing changed from elsewhere reaches the window at once.
  await f.call('project.update',{id:window.entry.attachment.roots[0].projectId,access:'read'});
  await until(()=>window.entry.attachment.roots[0].access==='read','the window shows the new access');
});

test('a changed setting and a workspace that becomes trusted take effect without reloading the window',async t=>{
  const f=await fixture(t),root=path.join(f.temp,'late-trust');fs.mkdirSync(root);
  const made=[];
  const window=fakeWindow(f.instanceRoot,'Late trust',[root],{settings:{autoStart:true},hostOptions:{}});
  window.vscode.workspace.isTrusted=false;
  t.after(()=>window.entry.deactivate());
  await window.activate();
  assert.deepEqual(window.entry.attachment.roots,[],'nothing is shared while the workspace is not trusted');
  window.trust();
  await until(()=>window.entry.attachment?.roots[0]?.projectId,'the folder is shared once the workspace is trusted');
  // Turning editor context off stops publishing it, at once.
  window.set('shareEditorContext',false);
  await until(async()=>(await f.call('editor.context',{projectId:window.entry.attachment.selectedProjectId})).open.length===0,'no open files are published');
  assert.ok(made);
});
