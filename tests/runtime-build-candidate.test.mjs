import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import {spawn,spawnSync} from 'node:child_process';
import {VERSION} from '../runtime/version.mjs';
import {EXTENSION_ORIGIN} from '../runtime/chrome.mjs';
import {frame,frames} from '../runtime/chrome-host.mjs';
import {buildRuntimeCandidate} from '../scripts/runtime-build.mjs';
const require=createRequire(import.meta.url);
test('candidate is self contained and its Obsidian main materializes a verified native runtime without starting it',{timeout:180000},async t=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-candidate 中文 '));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const out=path.join(temporary,'package'),instance=path.join(temporary,'instance');
  const manifestPath=path.join(temporary,'package.fixture.json'),pluginManifestPath=path.join(temporary,'plugin.fixture.json');
  fs.writeFileSync(manifestPath,JSON.stringify({name:'devmate-test',version:VERSION,main:'./vscode-host/runtime-entry.cjs',bin:{devmate:'./runtime/cli.mjs'}}));
  fs.writeFileSync(pluginManifestPath,JSON.stringify({name:'devmate',version:VERSION}));
  const built=await buildRuntimeCandidate({out,manifestPath,pluginManifestPath,reuseWorkbench:true});
  assert.equal(fs.existsSync(path.join(out,'node_modules')),false);
  await assert.rejects(buildRuntimeCandidate({out,reuseWorkbench:true}),/already exists/);
  const manifest=JSON.parse(fs.readFileSync(path.join(out,'build-manifest.json'),'utf8'));
  assert.equal(manifest.reusedWorkbench,true);
  assert.equal(manifest.runtimeAssetId,built.runtimeAssetId);
  const cli=spawnSync(process.execPath,[path.join(out,'runtime','cli.mjs'),'--help'],{cwd:temporary,encoding:'utf8',shell:false,windowsHide:true,timeout:15000});
  assert.equal(cli.status,0,cli.stderr);assert.match(cli.stdout,/devmate call/);
  const commands=new Map(),notices=[];
  class Plugin{
    constructor(){this.app={workspace:{getLeavesOfType:()=>[]}};}
    async loadData(){return{runtimeInstanceDirectory:instance};}
    registerView(){} addRibbonIcon(){} addCommand(command){commands.set(command.id,command.callback);} addSettingTab(){}
  }
  const api={Plugin,PluginSettingTab:class{},Setting:class{},ItemView:class{},Notice:class{constructor(message){notices.push(message);}}};
  const original=Module._load;
  Module._load=function(request,...rest){return request==='obsidian'?api:original.call(this,request,...rest);};
  let plugin;
  try{const Entry=require(path.join(out,'obsidian','main.js'));plugin=new Entry();await plugin.onload();await plugin.onunload();}
  finally{Module._load=original;}
  assert.ok(commands.has('runtime-attach-vault'));assert.equal(notices.length,0);
  const assetRoot=path.join(instance,'host-assets',built.runtimeAssetId);
  for(const file of ['main.mjs','cli.mjs','agent-channel.mjs','claude-permission-server.mjs','client.mjs','launcher.mjs','host-client.cjs'])assert.ok(fs.existsSync(path.join(assetRoot,'runtime',file)),file);
  // The browser extension comes out beside the runtime as it is in the repository, so that a DevMate that came through
  // Obsidian has one to register with a browser and to keep current.
  const extension=new URL('../chrome-extension/',import.meta.url);
  for(const file of fs.readdirSync(extension))assert.equal(fs.readFileSync(path.join(assetRoot,'chrome-extension',file),'utf8'),fs.readFileSync(new URL(file,extension),'utf8'),file);
  assert.equal(fs.existsSync(path.join(instance,'runtime.json')),false);
  assert.equal(fs.existsSync(path.join(instance,'owner-token')),false);
  const embeddedCli=spawnSync(process.execPath,[path.join(assetRoot,'runtime','cli.mjs'),'--help'],{cwd:temporary,encoding:'utf8',shell:false,windowsHide:true,timeout:15000});
  assert.equal(embeddedCli.status,0,embeddedCli.stderr);
  const hostClient=require(path.join(assetRoot,'runtime','host-client.cjs')).createHostClient({instanceRoot:instance});
  assert.equal((await hostClient.status()).running,false);hostClient.dispose();

  // The program a browser starts, as it is built, ends when an update replaced it: the process itself, while the
  // browser still holds its end of the connection open. (It "left" and stayed: it served nobody, and the extension
  // went on showing that it was connected.) Two ways an update goes are tried, each with a host of its own.
  const program=path.join(out,'runtime','cli.mjs');
  const host=where=>{
    const child=spawn(process.execPath,[program,'chrome-host',EXTENSION_ORIGIN,'--parent-window=0','--instance',where],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    const heard=[];let said='';
    child.stdout.on('data',frames(message=>heard.push(message)));child.stderr.on('data',chunk=>{said+=chunk;});
    child.stdin.write(frame({type:'hello',protocol:1,extension:VERSION,browser:'A browser',methods:[]}));
    const ended=new Promise(resolve=>child.on('close',code=>resolve(code)));
    return{child,heard,ended,said:()=>said};
  };
  const within=(promise,ms,what)=>Promise.race([promise,new Promise((resolve,reject)=>setTimeout(()=>reject(new Error(what)),ms))]);
  const until=async(check,what)=>{for(const end=Date.now()+15000;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,50)))if(check())return;throw new Error('Timed out waiting for '+what);};
  // 1. The file it was started from is written anew (a global install does that).
  const rewritten=host(path.join(temporary,'instance-rewritten'));
  t.after(()=>{try{rewritten.child.kill();}catch{}});
  await until(()=>rewritten.heard.some(message=>message.type==='ready'),'the host to be ready');
  await new Promise(resolve=>setTimeout(resolve,2500));
  assert.equal(rewritten.child.exitCode,null,'it serves for as long as its program is the one that was started');
  const later=new Date(Date.now()+60000);fs.utimesSync(program,later,later);
  assert.equal(await within(rewritten.ended,20000,'the host did not end after its program was written anew: '+rewritten.said()),0);
  assert.match(rewritten.said(),/this program was replaced by an update/);
  // 2. What the browser starts is another file now (an editor installs every version into a folder of its own, and
  // a start of the runtime writes down which program the browser starts from then on).
  const moved=path.join(temporary,'instance-moved'),newer=path.join(temporary,'newer-cli.mjs');
  fs.mkdirSync(path.join(moved,'chrome'),{recursive:true});fs.writeFileSync(newer,'');
  fs.writeFileSync(path.join(moved,'chrome','registration.json'),JSON.stringify({node:process.execPath,cli:program}));
  const elsewhere=host(moved);
  t.after(()=>{try{elsewhere.child.kill();}catch{}});
  await until(()=>elsewhere.heard.some(message=>message.type==='ready'),'the second host to be ready');
  await new Promise(resolve=>setTimeout(resolve,2500));
  assert.equal(elsewhere.child.exitCode,null,'registered as the program it is, it stays');
  fs.writeFileSync(path.join(moved,'chrome','registration.json'),JSON.stringify({node:process.execPath,cli:newer}));
  assert.equal(await within(elsewhere.ended,20000,'the host did not end after another program was registered: '+elsewhere.said()),0);
  // A program that is registered and is not there replaces nothing: the browser could start no other.
  const kept=path.join(temporary,'instance-kept');
  fs.mkdirSync(path.join(kept,'chrome'),{recursive:true});
  fs.writeFileSync(path.join(kept,'chrome','registration.json'),JSON.stringify({node:process.execPath,cli:path.join(temporary,'no-such-cli.mjs')}));
  const staying=host(kept);
  await until(()=>staying.heard.some(message=>message.type==='ready'),'the third host to be ready');
  await new Promise(resolve=>setTimeout(resolve,6500));
  assert.equal(staying.child.exitCode,null);
  // And it ends, as ever, when the browser closes its end.
  staying.child.stdin.end();
  assert.equal(await within(staying.ended,15000,'the host did not end when the browser left'),0);
});
