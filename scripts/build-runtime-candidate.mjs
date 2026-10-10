#!/usr/bin/env node
import path from 'node:path';
import {buildRuntimeCandidate} from './runtime-build.mjs';
const options={nodePaths:[]},args=process.argv.slice(2);
for(let i=0;i<args.length;i++){
  const name=args[i];
  if(name==='--reuse-workbench'){options.reuseWorkbench=true;continue;}
  const value=args[++i];
  if(!value)throw new Error('Missing value for '+name);
  if(name==='--out')options.out=value;
  else if(name==='--manifest')options.manifestPath=value;
  else if(name==='--plugin-manifest')options.pluginManifestPath=value;
  else if(name==='--node-path')options.nodePaths.push(path.resolve(value));
  else throw new Error('Unknown option: '+name);
}
console.log(JSON.stringify(await buildRuntimeCandidate(options),null,2));
