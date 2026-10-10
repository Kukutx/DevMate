import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {build} from 'esbuild';
import {VERSION} from '../runtime/version.mjs';
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const entries={
  'runtime/main.mjs':'runtime/main.mjs',
  'runtime/cli.mjs':'runtime/cli.mjs',
  'runtime/agent-channel.mjs':'runtime/agent-channel.mjs',
  'runtime/claude-permission-server.mjs':'runtime/agents/claude-permission-server.mjs',
  'runtime/client.mjs':'runtime/client.mjs',
  'runtime/launcher.mjs':'runtime/launcher.mjs'
};
function writeJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');}
function notices(root,inputs){
  const packages=new Map();
  for(const input of inputs){
    const full=path.resolve(root,input),match=full.replaceAll('\\','/').match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/);
    if(!match)continue;
    const directory=path.normalize(match[1]),file=path.join(directory,'package.json');
    if(packages.has(directory)||!fs.existsSync(file))continue;
    const meta=readJson(file),license=['LICENSE','LICENSE.md','LICENSE.txt','license','license.md'].map(name=>path.join(directory,name)).find(file=>fs.existsSync(file));
    packages.set(directory,{name:meta.name,version:meta.version,license:license?fs.readFileSync(license,'utf8'):'License: '+String(meta.license||'See upstream package')});
  }
  return [...packages.values()].sort((a,b)=>a.name.localeCompare(b.name)).map(item=>item.name+'@'+item.version+'\n'+item.license).join('\n\n');
}
export async function buildRuntimeCandidate({root=path.resolve(import.meta.dirname,'..'),out,manifestPath,pluginManifestPath,nodePaths=[],reuseWorkbench=false}={}){
  root=path.resolve(root);out=path.resolve(out||path.join(root,'dist','runtime-candidate-'+new Date().toISOString().replace(/[:.]/g,'-')));
  if(fs.existsSync(out))throw new Error('Candidate output already exists; select a new directory.');
  const manifest=readJson(path.resolve(manifestPath||path.join(root,'package.json')));
  if(manifest.version!==VERSION)throw new Error('Package and runtime versions must agree.');
  const plugin=readJson(path.resolve(pluginManifestPath||path.join(root,'plugin.json')));
  if(plugin.version!==manifest.version||plugin.name!=='devmate')throw new Error('Plugin and package versions must agree.');
  if(manifest.main!=='./vscode-host/runtime-entry.cjs'||manifest.bin?.devmate!=='./runtime/cli.mjs')throw new Error('Candidate manifest must select the new runtime entries.');
  for(const value of nodePaths)if(!path.isAbsolute(value)||!fs.statSync(value,{throwIfNoEntry:false})?.isDirectory())throw new Error('Extra module paths must be explicit existing absolute directories.');
  const staging=out+'.pending-'+crypto.randomUUID(),inputs=new Set(),outputs=[];
  fs.mkdirSync(staging,{recursive:true});
  const compile=async(source,target,options={})=>{
    const result=await build({absWorkingDir:root,entryPoints:[path.join(root,source)],outfile:path.join(staging,target),
      bundle:true,platform:'node',format:'esm',target:'node24',packages:'bundle',sourcemap:false,legalComments:'inline',logLevel:'warning',metafile:true,nodePaths,
      banner:{js:"import { createRequire as __devmateCreateRequire } from 'node:module'; const require = __devmateCreateRequire(import.meta.url);"},
      ...options});
    for(const input of Object.keys(result.metafile.inputs))inputs.add(input);
    outputs.push(target);return result;
  };
  try{
    for(const [target,source]of Object.entries(entries))await compile(source,target);
    // One CommonJS file with nothing left to import at run time: inside an Electron window without context isolation
    // (Obsidian), import() is the browser's and cannot load a Node module from disk.
    await compile('runtime/host-client.cjs','runtime/host-client.cjs',{format:'cjs',
      banner:{js:"const __devmateModuleUrl = require('node:url').pathToFileURL(__filename).href;"},define:{'import.meta.url':'__devmateModuleUrl'}});
    if(/\bimport\(/.test(fs.readFileSync(path.join(staging,'runtime/host-client.cjs'),'utf8').replace(/\/\/.*$/gm,'').replace(/\/\*[\s\S]*?\*\//g,'')))throw new Error('The packaged host client must not import at run time.');
    await compile('vscode-host/runtime-entry.cjs','vscode-host/runtime-entry.cjs',{format:'cjs',banner:{},external:['vscode','../runtime/host-client.cjs']});
    if(reuseWorkbench){
      fs.mkdirSync(path.join(staging,'workbench'),{recursive:true});
      fs.copyFileSync(path.join(root,'workbench','bridge.bundle.js'),path.join(staging,'workbench','bridge.bundle.js'));outputs.push('workbench/bridge.bundle.js');
    }else await compile('workbench/bridge.js','workbench/bridge.bundle.js',{platform:'browser',format:'iife',target:'es2022',minify:true,banner:{}});
    for(const file of ['index.html','styles.css','app.js']){
      fs.copyFileSync(path.join(root,'workbench',file),path.join(staging,'workbench',file));outputs.push('workbench/'+file);
    }
    const license=fs.readFileSync(path.join(root,'LICENSE'),'utf8');fs.writeFileSync(path.join(staging,'LICENSE'),license);
    const thirdParty=notices(root,inputs);fs.writeFileSync(path.join(staging,'THIRD_PARTY_NOTICES.txt'),thirdParty);
    const embeddedPaths=[...outputs.filter(file=>file.startsWith('runtime/')||file.startsWith('workbench/')),'LICENSE','THIRD_PARTY_NOTICES.txt'];
    // The files travel inside the plugin as the text they are, so that whoever reviews main.js reads the very code it will
    // write to disk. Nothing in it is encoded.
    const assets=embeddedPaths.sort().map(file=>{
      const data=fs.readFileSync(path.join(staging,file)),text=data.toString('utf8');
      if(!Buffer.from(text,'utf8').equals(data))throw new Error('Only text can be embedded in the Obsidian plugin: '+file);
      return{path:file,sha256:hash(data),text};
    });
    const embedded={id:hash(JSON.stringify(assets.map(({path,sha256})=>({path,sha256})))),assets};
    await compile('obsidian-plugin/src/runtime-plugin.cjs','obsidian/main.js',{format:'cjs',banner:{},charset:'utf8',external:['obsidian','../../runtime/host-client.cjs'],
      define:{__DEVMATE_RUNTIME_ASSETS__:JSON.stringify(embedded)}});
    // The manifest Obsidian reads from the repository root is the one that ships: a plugin describes itself once.
    const obsidian=readJson(path.join(root,'manifest.json'));
    if(obsidian.version!==manifest.version||obsidian.id!=='devmate')throw new Error('Obsidian manifest and package versions must agree.');
    writeJson(path.join(staging,'obsidian','manifest.json'),obsidian);
    fs.copyFileSync(path.join(root,'obsidian-plugin','src','runtime-styles.css'),path.join(staging,'obsidian','styles.css'));
    writeJson(path.join(staging,'package.json'),manifest);
    // What the manifest shows beside the walkthrough steps.
    fs.cpSync(path.join(root,'vscode-host','walkthrough'),path.join(staging,'vscode-host','walkthrough'),{recursive:true});
    if(manifest.icon){fs.mkdirSync(path.dirname(path.join(staging,manifest.icon)),{recursive:true});fs.copyFileSync(path.join(root,manifest.icon),path.join(staging,manifest.icon));}
    for(const file of ['README.md','CHANGELOG.md',...fs.readdirSync(root).filter(name=>/^package\.nls(\.[a-z-]+)?\.json$/.test(name))])fs.copyFileSync(path.join(root,file),path.join(staging,file));
    writeJson(path.join(staging,'plugin.json'),plugin);
    const closure=[...inputs].filter(file=>!file.includes('node_modules')).sort();
    writeJson(path.join(staging,'build-manifest.json'),{version:manifest.version,createdAt:new Date().toISOString(),runtimeAssetId:embedded.id,
      reusedWorkbench:reuseWorkbench,
      files:fs.readdirSync(staging,{recursive:true}).filter(file=>fs.statSync(path.join(staging,file)).isFile()).map(file=>({path:file.replaceAll('\\','/'),sha256:hash(fs.readFileSync(path.join(staging,file)))})),
      sourceInputs:closure,extraModulePaths:nodePaths.map(value=>path.basename(path.dirname(value)))});
    fs.renameSync(staging,out);
    return{out,version:manifest.version,runtimeAssetId:embedded.id,sourceInputs:closure};
  }catch(error){fs.rmSync(staging,{recursive:true,force:true});throw error;}
}
