#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {buildRuntimeCandidate} from './runtime-build.mjs';
import {validateExtensionManifest} from './check-runtime.mjs';
const require=createRequire(import.meta.url);
const vsceRequire=createRequire(require.resolve('@vscode/vsce/package.json'));
const yauzl=vsceRequire('yauzl'),yazl=vsceRequire('yazl');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
export function readArchive(file){
  return new Promise((resolve,reject)=>yauzl.open(file,{lazyEntries:true},(error,zip)=>{
    if(error)return reject(error);const files=new Map();let total=0;
    zip.on('error',reject);zip.on('end',()=>resolve(files));
    zip.on('entry',entry=>{
      if(entry.fileName.endsWith('/'))return zip.readEntry();
      if(entry.fileName.startsWith('/')||entry.fileName.split('/').includes('..')||files.has(entry.fileName)){zip.close();return reject(new Error('Unsafe archive entry.'));}
      total+=entry.uncompressedSize;if(total>128*1024*1024){zip.close();return reject(new Error('Archive exceeds validation limit.'));}
      zip.openReadStream(entry,(error,stream)=>{if(error){zip.close();return reject(error);}const chunks=[];stream.on('error',reject);stream.on('data',chunk=>chunks.push(chunk));stream.on('end',()=>{files.set(entry.fileName,Buffer.concat(chunks));zip.readEntry();});});
    });zip.readEntry();
  }));
}
function verifyCandidate(candidate){
  const manifest=JSON.parse(fs.readFileSync(path.join(candidate,'package.json'),'utf8'));
  validateExtensionManifest(candidate,manifest);
  if(manifest.files&&fs.existsSync(path.join(candidate,'.vscodeignore')))throw new Error('Use either package.files or .vscodeignore, not both.');
  const build=JSON.parse(fs.readFileSync(path.join(candidate,'build-manifest.json'),'utf8'));
  assert.equal(build.version,manifest.version);
  for(const entry of build.files){
    const target=path.resolve(candidate,entry.path),relative=path.relative(candidate,target);
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
    assert.equal(hash(fs.readFileSync(target)),entry.sha256,'Candidate changed after build: '+entry.path);
  }
  return{manifest,build};
}
async function writeObsidianArchive(candidate,file){
  const zip=new yazl.ZipFile(),output=fs.createWriteStream(file,{flags:'wx'});
  const done=new Promise((resolve,reject)=>{output.on('close',resolve);output.on('error',reject);zip.outputStream.on('error',reject);});
  zip.outputStream.pipe(output);
  for(const name of ['main.js','manifest.json','styles.css'])zip.addFile(path.join(candidate,'obsidian',name),name);
  zip.end();await done;
}
// The command line on its own: the built runtime under a manifest that holds only what npm needs.
// Everything is bundled, so `npm install -g <file>` gives the `devmate` command with nothing to download or build.
const CLI_PAYLOAD=['runtime','workbench','plugin.json','LICENSE','README.md','THIRD_PARTY_NOTICES.txt'];
function npm(args,cwd){
  // npm is a shell script on Windows; the arguments here are fixed words and paths never go through the shell.
  const result=spawnSync('npm '+args,{cwd,encoding:'utf8',shell:true,windowsHide:true,timeout:180000,maxBuffer:8*1024*1024});
  assert.equal(result.status,0,'npm '+args.split(' ')[0]+' failed: '+String(result.stderr||result.stdout||result.error||''));
  return result.stdout;
}
function writeCliPackage(candidate,manifest,out){
  const staging=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-cli-package-'));
  try{
    for(const entry of CLI_PAYLOAD)fs.cpSync(path.join(candidate,entry),path.join(staging,entry),{recursive:true});
    const {name,version,description,license,homepage,repository,bugs,keywords,bin}=manifest;
    fs.writeFileSync(path.join(staging,'package.json'),JSON.stringify({name,version,description,license,homepage,repository,bugs,keywords,bin,engines:{node:manifest.engines.node}},null,2)+'\n');
    const [packed]=JSON.parse(npm('pack --json',staging));
    const listed=new Map(packed.files.map(file=>[file.path,file.size]));
    for(const file of fs.readdirSync(staging,{recursive:true,withFileTypes:true}))if(file.isFile()){
      const relative=path.relative(staging,path.join(file.parentPath,file.name)).replace(/\\/g,'/');
      if(relative===packed.filename)continue;
      assert.equal(listed.get(relative),fs.statSync(path.join(staging,relative)).size,'CLI package is missing or changed: '+relative);
      listed.delete(relative);
    }
    assert.deepEqual([...listed.keys()],[],'Unexpected CLI package payload.');
    fs.copyFileSync(path.join(staging,packed.filename),out,fs.constants.COPYFILE_EXCL);
    // Installed the way a user installs it, with the network off: the command exists and answers.
    const prefix=path.join(staging,'installed');fs.mkdirSync(prefix);fs.writeFileSync(path.join(prefix,'package.json'),'{"private":true}\n');
    npm('install --offline --no-audit --no-fund --no-package-lock '+JSON.stringify(out),prefix);
    const installed=path.join(prefix,'node_modules',name);
    assert.equal(fs.existsSync(path.join(installed,'node_modules')),false,'The CLI package must not need dependencies.');
    assert.ok(fs.existsSync(path.join(prefix,'node_modules','.bin',Object.keys(bin)[0]+(process.platform==='win32'?'.cmd':''))),'npm did not create the devmate command.');
    const answer=spawnSync(process.execPath,[path.join(installed,bin[Object.keys(bin)[0]]),'--version'],{encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(answer.status,0,String(answer.stderr||answer.error||''));assert.equal(answer.stdout.trim(),version);
  }finally{fs.rmSync(staging,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
export async function packageRuntime(kind,{candidate,out,manifestPath,pluginManifestPath,reuseWorkbench=false}={}){
  if(!['vscode','obsidian','cli'].includes(kind))throw new Error('Choose vscode, obsidian or cli.');
  if(!candidate)candidate=(await buildRuntimeCandidate({reuseWorkbench,manifestPath,pluginManifestPath})).out;
  candidate=path.resolve(candidate);const {manifest,build}=verifyCandidate(candidate);
  const extension=kind==='vscode'?'vsix':kind==='cli'?'tgz':'zip';
  out=path.resolve(out||path.join(path.dirname(candidate),path.basename(candidate)+'-'+kind+'.'+extension));
  if(fs.existsSync(out))throw new Error('Package output already exists; select a new file.');
  fs.mkdirSync(path.dirname(out),{recursive:true});
  try{
    if(kind==='vscode'){
      const metaPath=require.resolve('@vscode/vsce/package.json'),meta=JSON.parse(fs.readFileSync(metaPath,'utf8'));
      const bin=path.resolve(path.dirname(metaPath),typeof meta.bin==='string'?meta.bin:meta.bin.vsce);
      const result=spawnSync(process.execPath,[bin,'package','--no-dependencies','--out',out],{cwd:candidate,encoding:'utf8',shell:false,windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});
      assert.equal(result.status,0,'VSIX packaging failed: '+String(result.stderr||result.stdout||result.error||''));
      const files=await readArchive(out),packaged=JSON.parse(files.get('extension/package.json'));
      assert.equal(packaged.version,manifest.version);assert.equal(packaged.main,manifest.main);
      assert.deepEqual(packaged.contributes,manifest.contributes);assert.deepEqual(packaged.activationEvents,manifest.activationEvents);
      for(const file of ['extension.vsixmanifest','[Content_Types].xml','extension/'+manifest.main.replace(/^\.\//,''),'extension/'+manifest.icon,
        'extension/runtime/main.mjs','extension/runtime/cli.mjs','extension/runtime/agent-channel.mjs','extension/runtime/claude-permission-server.mjs',
        'extension/runtime/host-client.cjs','extension/runtime/client.mjs','extension/runtime/launcher.mjs',
        'extension/LICENSE.txt','extension/readme.md','extension/changelog.md','extension/package.nls.json','extension/package.nls.zh-cn.json','extension/vscode-host/walkthrough/start.md','extension/vscode-host/walkthrough/share.md','extension/vscode-host/walkthrough/connect.md','extension/workbench/index.html','extension/workbench/bridge.bundle.js','extension/workbench/styles.css','extension/workbench/app.js','extension/plugin.json','extension/THIRD_PARTY_NOTICES.txt'])assert.ok(files.has(file),'Missing VSIX file: '+file);
      assert.equal([...files.keys()].some(file=>file.startsWith('extension/gateway/')||file.startsWith('extension/node_modules/')),false);
      for(const [name,data]of files)if(name.startsWith('extension/')){
        // VSCE's documented processors rename LICENSE and README, and rewrite
        // README relative links to repository URLs. Executable payloads stay exact.
        const relative=name==='extension/LICENSE.txt'?'LICENSE':name==='extension/readme.md'?'README.md':name==='extension/changelog.md'?'CHANGELOG.md':name.slice(10);
        const original=path.join(candidate,relative);
        assert.ok(fs.existsSync(original),'Unexpected VSIX payload: '+name);
        if(relative==='README.md')assert.equal(data.toString('utf8').split('\n')[0],fs.readFileSync(original,'utf8').split('\n')[0]);
        else assert.equal(hash(data),hash(fs.readFileSync(original)),'VSIX changed file: '+name);
      }
    }else if(kind==='cli')writeCliPackage(candidate,manifest,out);
    else{
      await writeObsidianArchive(candidate,out);const files=await readArchive(out);
      assert.deepEqual([...files.keys()].sort(),['main.js','manifest.json','styles.css']);
      const plugin=JSON.parse(files.get('manifest.json'));assert.equal(plugin.version,manifest.version);assert.equal(plugin.isDesktopOnly,true);
      const main=files.get('main.js').toString('utf8');assert.ok(main.includes(build.runtimeAssetId),'Obsidian package is missing its embedded runtime identity.');
      for(const entry of ['runtime/main.mjs','runtime/cli.mjs','runtime/agent-channel.mjs','runtime/claude-permission-server.mjs','workbench/index.html'])assert.ok(main.includes(entry),'Missing embedded runtime asset: '+entry);
      assert.ok(main.includes('materializeRuntimeAssets'));assert.equal(main.includes('contentBase64'),false,'The Obsidian plugin must carry its runtime as readable text.');
      for(const [name,data]of files)assert.equal(hash(data),hash(fs.readFileSync(path.join(candidate,'obsidian',name))));
    }
  }catch(error){fs.rmSync(out,{force:true});throw error;}
  return{ok:true,kind,candidate,artifact:out,bytes:fs.statSync(out).size,sha256:hash(fs.readFileSync(out)),version:manifest.version,reusedWorkbench:build.reusedWorkbench===true};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const [kind,...args]=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--candidate')options.candidate=args[++i];
    else if(args[i]==='--out')options.out=args[++i];
    else if(args[i]==='--manifest')options.manifestPath=args[++i];
    else if(args[i]==='--plugin-manifest')options.pluginManifestPath=args[++i];
    else if(args[i]==='--reuse-workbench')options.reuseWorkbench=true;
    else throw new Error('Usage: package-runtime.mjs <vscode|obsidian|cli> [--candidate <directory>] [--out <file>] [--manifest <package.json>] [--plugin-manifest <plugin.json>] [--reuse-workbench]');
  }
  console.log(JSON.stringify(await packageRuntime(kind,options),null,2));
}
