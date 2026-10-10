#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {normalizeConfig} from '../runtime/config.mjs';
import {VERSION} from '../runtime/version.mjs';
const root=path.resolve(import.meta.dirname,'..');
function contained(root,file){const target=path.resolve(root,file),rel=path.relative(root,target);assert.ok(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel),'Manifest path must stay in the package: '+file);return target;}
export function validateExtensionManifest(directory,manifest){
  assert.equal(manifest.version,VERSION,'Runtime and package versions must agree.');
  assert.equal(manifest.main,'./vscode-host/runtime-entry.cjs');
  assert.equal(manifest.bin?.devmate,'./runtime/cli.mjs');
  assert.match(manifest.engines?.node||'',/24/);
  const commands=new Set((manifest.contributes?.commands||[]).map(item=>item.command));
  const required=['start','stop','restart','status','open','operations','call','selectWorkspace','registerFolder','menu','doctor','copyMcpUrl','loginCode','configureConnection'].map(name=>'devMate.runtime.'+name);
  assert.deepEqual([...commands].sort(),required.sort(),'Command contributions must select the new host handlers.');
  // Every contributed command must have a handler in the host, and the other way round.
  const host=fs.readFileSync(contained(directory,manifest.main),'utf8');
  for(const command of commands)assert.ok(new RegExp('\\b'+command.split('.').pop()+'\\b').test(host),'No host handler for '+command);
  const views=new Set(Object.values(manifest.contributes?.views||{}).flat().map(view=>view.id));
  assert.ok(views.has('devMate.runtime'));
  // The editor activates an extension for its own commands and views; only the startup event is declared.
  assert.deepEqual(manifest.activationEvents,['onStartupFinished']);
  assert.deepEqual((manifest.contributes?.mcpServerDefinitionProviders||[]).map(item=>item.id),['devMate.runtime']);
  assert.deepEqual(manifest.extensionKind,['workspace']);
  for(const file of [manifest.main,manifest.bin.devmate,manifest.icon]){
    assert.equal(typeof file,'string');assert.ok(fs.statSync(contained(directory,file)).isFile(),'Missing package path: '+file);
  }
  for(const walkthrough of manifest.contributes?.walkthroughs||[])for(const step of walkthrough.steps)assert.ok(fs.statSync(contained(directory,step.media.markdown)).isFile(),'Missing walkthrough page: '+step.media.markdown);
  for(const views of Object.values(manifest.contributes?.viewsContainers||{}))for(const view of views)assert.ok(fs.statSync(contained(directory,view.icon)).isFile());
  for(const pattern of manifest.files||[])assert.equal(typeof pattern,'string');
  const named=[...new Set([...JSON.stringify({contributes:manifest.contributes,capabilities:manifest.capabilities}).matchAll(/"%([^%"]+)%"/g)].map(match=>match[1]))];
  const texts=fs.readdirSync(directory).filter(name=>/^package\.nls(\.[a-z-]+)?\.json$/.test(name));
  if(named.length)assert.ok(texts.includes('package.nls.json'),'The manifest names texts but package.nls.json is missing.');
  for(const file of texts){const defined=JSON.parse(fs.readFileSync(path.join(directory,file),'utf8'));
    assert.deepEqual(named.filter(key=>typeof defined[key]!=='string'||!defined[key]),[],file+' lacks texts the manifest names.');
    assert.deepEqual(Object.keys(defined).filter(key=>!named.includes(key)),[],file+' carries texts the manifest does not use.');}
  return{commands:commands.size,views:views.size};
}
// One version in every file that states it: a release that disagrees with itself is found here, not by a user.
export function validateVersions(directory){
  const read=file=>JSON.parse(fs.readFileSync(path.join(directory,file),'utf8'));
  const lock=read('package-lock.json'),obsidian=read('manifest.json');
  assert.equal(lock.version,VERSION,'package-lock.json states another version.');
  assert.equal(lock.packages?.['']?.version,VERSION,'package-lock.json states another version for its root package.');
  assert.equal(read('plugin.json').version,VERSION,'plugin.json states another version.');
  assert.equal(obsidian.version,VERSION,'manifest.json (Obsidian) states another version.');
  assert.equal(read('versions.json')[VERSION],obsidian.minAppVersion,'versions.json must map this version to the minAppVersion of manifest.json.');
  assert.ok(fs.readFileSync(path.join(directory,'CHANGELOG.md'),'utf8').split(/\r?\n/).includes('## '+VERSION),'CHANGELOG.md has no section for version '+VERSION+'.');
}
// Every action a workflow runs is named by its commit, so a moved tag cannot change what runs with this repository's permissions.
export function validateWorkflows(directory){
  const folder=path.join(directory,'.github','workflows');let actions=0;
  for(const name of fs.readdirSync(folder))for(const [,uses]of fs.readFileSync(path.join(folder,name),'utf8').matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)){
    actions++;assert.match(uses,/^(?:\.\/|[\w.-]+\/[\w./-]+@[0-9a-f]{40}$)/,name+' runs an action that is not pinned to a commit: '+uses);
  }
  return actions;
}
export async function checkRuntime({manifestPath=path.join(root,'package.json')}={}){
  const manifest=JSON.parse(fs.readFileSync(path.resolve(manifestPath),'utf8'));
  const host=validateExtensionManifest(root,manifest);
  validateVersions(root);const pinnedActions=validateWorkflows(root);
  assert.equal(normalizeConfig({}).connection.kind,'local');
  assert.equal(normalizeConfig({}).auth.mode,'none');
  const entries=['runtime/main.mjs','runtime/cli.mjs','runtime/agent-channel.mjs','runtime/agents/claude-permission-server.mjs','runtime/host-client.cjs','vscode-host/runtime-entry.cjs','obsidian-plugin/src/runtime-plugin.cjs'];
  const compiled=await build({absWorkingDir:root,entryPoints:entries,outdir:'check-only-output',write:false,bundle:true,platform:'node',format:'esm',target:'node24',external:['obsidian','vscode'],metafile:true,logLevel:'silent'});
  const inputs=Object.keys(compiled.metafile.inputs).filter(file=>!file.includes('node_modules')&&!file.startsWith('<')).map(file=>file.replaceAll('\\','/'));
  const syntaxFiles=[...new Set([...inputs,'workbench/app.js','workbench/bridge.js','workbench/build.mjs','scripts/runtime-build.mjs','scripts/build-runtime-candidate.mjs','scripts/check-runtime.mjs','scripts/smoke-runtime.mjs','scripts/package-runtime.mjs','scripts/release-candidate.mjs','scripts/set-version.mjs','scripts/test-vscode-host.mjs','tests/vscode-host-real-suite.cjs'])];
  for(const file of syntaxFiles){
    const result=spawnSync(process.execPath,['--check',path.join(root,file)],{encoding:'utf8',shell:false,windowsHide:true,timeout:10000});
    assert.equal(result.status,0,'Syntax check failed: '+file+'\n'+String(result.stderr||result.error||''));
  }
  return{ok:true,version:VERSION,manifest:path.relative(root,path.resolve(manifestPath)),sourceFiles:syntaxFiles.length,pinnedActions,...host};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const args=process.argv.slice(2);
  if(args.length&&!(args.length===2&&args[0]==='--manifest'))throw new Error('Usage: check-runtime.mjs [--manifest <package.json>]');
  console.log(JSON.stringify(await checkRuntime({...(args.length?{manifestPath:args[1]}:{})}),null,2));
}
