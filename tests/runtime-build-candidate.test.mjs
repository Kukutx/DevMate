import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {VERSION} from '../runtime/version.mjs';
import {buildRuntimeCandidate} from '../scripts/runtime-build.mjs';
const require=createRequire(import.meta.url);
test('candidate is self contained and its Obsidian main materializes a verified native runtime without starting it',async t=>{
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
  assert.equal(fs.existsSync(path.join(instance,'runtime.json')),false);
  assert.equal(fs.existsSync(path.join(instance,'owner-token')),false);
  const embeddedCli=spawnSync(process.execPath,[path.join(assetRoot,'runtime','cli.mjs'),'--help'],{cwd:temporary,encoding:'utf8',shell:false,windowsHide:true,timeout:15000});
  assert.equal(embeddedCli.status,0,embeddedCli.stderr);
  const hostClient=require(path.join(assetRoot,'runtime','host-client.cjs')).createHostClient({instanceRoot:instance});
  assert.equal((await hostClient.status()).running,false);hostClient.dispose();
});
