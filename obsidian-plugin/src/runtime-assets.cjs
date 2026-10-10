'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
function materializeRuntimeAssets(instanceRoot,bundle){
  if(!path.isAbsolute(instanceRoot)||!bundle||!Array.isArray(bundle.assets)||!bundle.assets.length)throw new Error('An explicit instance and embedded runtime assets are required.');
  for(const asset of bundle.assets)if(typeof asset.path!=='string'||asset.path.split('/').some(part=>!part||part==='.'||part==='..'||!/^[-a-zA-Z0-9_.]+$/.test(part)))throw new Error('Invalid runtime asset path.');
  const identity=hash(JSON.stringify(bundle.assets.map(({path,sha256})=>({path,sha256}))));
  if(identity!==bundle.id)throw new Error('Embedded runtime manifest hash mismatch.');
  const base=path.join(instanceRoot,'host-assets'),target=path.join(base,identity);
  // What is on disk is checked against the declared hashes on every start; unpacking happens only when files must be written.
  const verify=()=>{for(const asset of bundle.assets){const file=path.join(target,asset.path);if(!fs.statSync(file,{throwIfNoEntry:false})?.isFile()||hash(fs.readFileSync(file))!==asset.sha256)throw new Error('Immutable runtime asset was changed: '+asset.path);}return target;};
  if(fs.existsSync(target))return verify();
  const assets=bundle.assets.map(asset=>{
    const data=Buffer.from(asset.text,'utf8');if(hash(data)!==asset.sha256)throw new Error('Embedded runtime asset hash mismatch: '+asset.path);
    return{...asset,data};
  });
  fs.mkdirSync(base,{recursive:true,mode:0o700});
  const staging=path.join(base,'.pending-'+crypto.randomUUID());fs.mkdirSync(staging,{mode:0o700});
  try{
    for(const asset of assets){const file=path.join(staging,asset.path);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,asset.data,{flag:'wx',mode:0o600});}
    try{fs.renameSync(staging,target);}catch(error){if(!fs.existsSync(target))throw error;verify();}
  }finally{fs.rmSync(staging,{recursive:true,force:true});}
  return verify();
}
module.exports={materializeRuntimeAssets};
