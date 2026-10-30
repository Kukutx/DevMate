import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRuntimeClient } from '../runtime/client.mjs';
import { startRuntime, stopRuntime, runtimeStatus } from '../runtime/launcher.mjs';
import processTree from '../runtime/platform/process-tree.js';

// A runtime that ends and is started again: after an error of its own, after it was killed, from an editor, from
// a terminal. (Apart from runtime-launcher.test.mjs, which would take longer than one file may.)
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function temp(t, cleanup = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-new-runtime-'));
  if (cleanup) t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return directory;
}

test('a runtime that ends on an error of its own is one that ended unexpectedly: its record stays for the entries to read, and the next start works',{timeout:120000},async t=>{
  // It released what it owned and stopped the usual way, record and all: the status was a plain "stopped", and an
  // editor that keeps a runtime running starts one only after a runtime that ended unexpectedly. Nothing started it again.
  const base=temp(t,false),instanceRoot=path.join(base,'failed'),port=await freePort();
  t.after(async()=>{
    await stopRuntime({instanceRoot,timeoutMs:15000}).catch(()=>{});
    fs.rmSync(base,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  // A runtime as the launcher runs one, which then throws where nothing catches it.
  const program='import { serve } from '+JSON.stringify(pathToFileURL(path.resolve('runtime/main.mjs')).href)+';\n'+
    'await serve({ instanceRoot: '+JSON.stringify(instanceRoot)+', port: '+port+' });\nsetTimeout(() => { throw new Error("an error nothing catches"); }, 300);\n';
  const child=spawn(process.execPath,['--input-type=module','-e',program],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let said='';child.stdout.on('data',chunk=>{said+=chunk;});child.stderr.on('data',chunk=>{said+=chunk;});
  const code=await new Promise(resolve=>child.on('close',resolve));
  assert.equal(code,1,said);assert.match(said,/"event":"ready"/);assert.match(said,/uncaught exception: Error: an error nothing catches/);
  const ended=await runtimeStatus({instanceRoot});
  assert.deepEqual([ended.state,ended.running,ended.crashed],['stopped',false,true],JSON.stringify(ended));
  // What it owned is released: the port answers nobody, and the next start works. No launcher started it, so no port is
  // written down: a start that names none follows it on the port its record says.
  await assert.rejects(fetch('http://127.0.0.1:'+port+'/health'));
  assert.equal(fs.existsSync(path.join(instanceRoot,'port')),false);
  const next=await startRuntime({instanceRoot,entryPath:path.resolve('runtime/main.mjs'),timeoutMs:30000});
  assert.equal(next.started,true);assert.equal(next.record.port,port);assert.equal((await runtimeStatus({instanceRoot})).crashed,undefined);
  // And one that is told to stop leaves no record: that is not an unexpected end.
  await stopRuntime({instanceRoot,timeoutMs:15000});
  assert.deepEqual([(await runtimeStatus({instanceRoot})).state,(await runtimeStatus({instanceRoot})).crashed],['stopped',undefined]);
});

test('a runtime that is killed leaves a recoverable instance: the next start simply works',async t=>{
  const base=temp(t,false),instanceRoot=path.join(base,'crashed');
  const entryPath=path.resolve('runtime/main.mjs');
  // Stop first, then remove: the database file is held until the runtime has gone.
  t.after(async()=>{
    await stopRuntime({instanceRoot,timeoutMs:15000}).catch(()=>{});
    fs.rmSync(base,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  const first=await startRuntime({instanceRoot,entryPath,port:await freePort(),timeoutMs:30000});
  process.kill(first.record.pid,'SIGKILL');
  assert.equal(await processTree.waitForPidExit(first.record.pid,5000),true);
  const dead=await runtimeStatus({instanceRoot});
  assert.deepEqual([dead.state,dead.crashed],['stopped',true]);
  const second=await startRuntime({instanceRoot,entryPath,port:await freePort(),timeoutMs:30000});
  assert.equal(second.started,true);assert.notEqual(second.record.generation,first.record.generation);
  assert.equal((await createRuntimeClient({instanceRoot}).call('project.list',{})).items.length,0);
  // Ended unexpectedly once more and started with no port named (as a browser starts it, or a plain `devmate start`):
  // it is found where it was, by the clients and the route that were set to that port.
  process.kill(second.record.pid,'SIGKILL');
  assert.equal(await processTree.waitForPidExit(second.record.pid,5000),true);
  const third=await startRuntime({instanceRoot,entryPath,timeoutMs:30000});
  assert.equal(third.started,true);assert.equal(third.record.port,second.record.port);
});

test('an entry that stops the runtime and starts it again finds it on the port it ran on, unless the owner set another in that entry',{timeout:120000},async t=>{
  const { createRequire } = await import('node:module');
  const { createHostClient } = createRequire(import.meta.url)('../runtime/host-client.cjs');
  const base=temp(t,false),instanceRoot=path.join(base,'kept'),entryPath=path.resolve('runtime/main.mjs');
  t.after(async()=>{
    await stopRuntime({instanceRoot,timeoutMs:15000}).catch(()=>{});
    fs.rmSync(base,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  // Started from a terminal on a port of its own; the editor's setting names none (or the usual one).
  const ran=await freePort();
  await startRuntime({instanceRoot,entryPath,port:ran,timeoutMs:30000});
  const editor=createHostClient({instanceRoot,entryPath,nodePath:process.execPath,timeoutMs:30000});
  t.after(()=>editor.dispose());
  await editor.stop();
  assert.equal((await editor.status()).running,false);
  const again=await editor.start();
  assert.equal(again.started,true);assert.equal(again.record.port,ran,'a restart from the editor does not move the runtime');
  // The port is the instance's: stopped the usual way from anywhere, and started from an entry that names no port
  // (a browser, a plain `devmate start`), it is found where it was. The usual port is not what is tried.
  await stopRuntime({instanceRoot,timeoutMs:15000});
  assert.equal((await runtimeStatus({instanceRoot})).crashed,undefined);
  assert.equal(fs.readFileSync(path.join(instanceRoot,'port'),'utf8'),ran+'\n');
  assert.equal((await startRuntime({instanceRoot,entryPath,timeoutMs:30000})).record.port,ran);
  // An entry whose settings name a port of the owner's choosing starts it there: that is their word, and from then
  // on it is the one the instance is found on.
  const chosen=await freePort(),other=createHostClient({instanceRoot,entryPath,nodePath:process.execPath,port:chosen,timeoutMs:30000});
  t.after(()=>other.dispose());
  await other.stop();
  assert.equal((await other.start()).record.port,chosen);
  await editor.stop();
  assert.equal((await editor.start()).record.port,chosen);
  // A port that is named on the command line wins over what is written down, and is written down in its place.
  await stopRuntime({instanceRoot,timeoutMs:15000});
  const named=await freePort();
  assert.equal((await startRuntime({instanceRoot,entryPath,port:named,timeoutMs:30000})).record.port,named);
  assert.equal(fs.readFileSync(path.join(instanceRoot,'port'),'utf8'),named+'\n');
});

test('a stop to start again at once is said to the runtime beside the instance, and read by it; a plain stop says nothing',{timeout:120000},async t=>{
  const base=temp(t,false),instanceRoot=path.join(base,'again'),entryPath=path.resolve('runtime/main.mjs'),word=path.join(instanceRoot,'restarting');
  t.after(async()=>{await stopRuntime({instanceRoot,timeoutMs:15000}).catch(()=>{});fs.rmSync(base,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const said=()=>(fs.readFileSync(path.join(instanceRoot,'runtime.log'),'utf8').match(/stopping to be started again/g)||[]).length;
  for(const [again,times] of [[true,1],[false,1]]){
    await startRuntime({instanceRoot,entryPath,port:await freePort(),timeoutMs:30000});
    // (What the runtime does with it, a quick tunnel kept, is in runtime-ingress.test.mjs.)
    await stopRuntime({instanceRoot,timeoutMs:15000,again});
    assert.equal(said(),times,'again: '+again);
    assert.equal(fs.existsSync(word),false,'the word is read and taken away by the runtime that stops');
  }
});

test('a runtime that no launcher started is restarted from an editor on the port it ran on',{timeout:120000},async t=>{
  // One that ran before an update, or `devmate serve --port`: nothing was written down, and the first restart from an
  // editor (a stop, then a start that names no port) moved it to the usual port.
  const { createRequire } = await import('node:module');
  const { createHostClient } = createRequire(import.meta.url)('../runtime/host-client.cjs');
  const base=temp(t,false),instanceRoot=path.join(base,'served'),entryPath=path.resolve('runtime/main.mjs'),port=await freePort();
  t.after(async()=>{
    await stopRuntime({instanceRoot,timeoutMs:15000}).catch(()=>{});
    fs.rmSync(base,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  const program='import { serve } from '+JSON.stringify(pathToFileURL(entryPath).href)+';\nawait serve({ instanceRoot: '+JSON.stringify(instanceRoot)+', port: '+port+' });\n';
  const child=spawn(process.execPath,['--input-type=module','-e',program],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  t.after(()=>{ if(child.exitCode===null) child.kill(); });
  await new Promise((resolve,reject)=>{let said='';child.stdout.on('data',chunk=>{said+=chunk;if(said.includes('"event":"ready"'))resolve();});child.once('close',code=>reject(new Error('it ended first ('+code+')')));});
  assert.equal(fs.existsSync(path.join(instanceRoot,'port')),false);
  const editor=createHostClient({instanceRoot,entryPath,nodePath:process.execPath,timeoutMs:30000});
  t.after(()=>editor.dispose());
  await editor.stop();
  await new Promise(resolve=>child.exitCode===null?child.once('close',resolve):resolve());
  assert.equal((await editor.start()).record.port,port,'the restart keeps the port it ran on');
});

test('a stop with no runtime running ends a quick tunnel a runtime left running; a stop to start again leaves it',{timeout:60000},async t=>{
  // A runtime that failed, or a restart that did not get as far as the start, leaves the tunnel running for the next
  // one. With no runtime it forwards its public address to a port anything on this computer may take: a stop ends it.
  const { ownedProcess } = await import('../runtime/platform/owned-process.mjs');
  const base=temp(t),instanceRoot=path.join(base,'left');fs.mkdirSync(instanceRoot);
  const tunnel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
  t.after(()=>{try{tunnel.kill('SIGKILL');}catch{}});
  await new Promise((resolve,reject)=>{tunnel.once('spawn',resolve);tunnel.once('error',reject);});
  const record=path.join(instanceRoot,'quick-tunnel.json');
  assert.equal(await ownedProcess(record).remember(tunnel.pid,{kind:'cloudflare-quick',forwardsTo:8789}),true);
  await stopRuntime({instanceRoot,timeoutMs:15000,again:true});
  assert.equal(processTree.pidRunning(tunnel.pid),true,'kept for the start that follows');assert.equal(fs.existsSync(record),true);
  const ended=new Promise(resolve=>tunnel.once('exit',()=>resolve(true)));
  assert.equal((await stopRuntime({instanceRoot,timeoutMs:15000})).alreadyStopped,true);
  let timer;assert.equal(await Promise.race([ended,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),10000);})]).finally(()=>clearTimeout(timer)),true,'the tunnel was ended');
  assert.equal(fs.existsSync(record),false);
});