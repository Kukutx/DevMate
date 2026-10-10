import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { createRuntimeClient, readRuntimeRecord, localControlUrl } from '../runtime/client.mjs';
import { startRuntime, stopRuntime, runtimeStatus } from '../runtime/launcher.mjs';
import { acquireInstanceLock, probeInstanceLock } from '../runtime/instance-lock.mjs';
import processTree from '../runtime/platform/process-tree.js';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

// A minimal runtime that honours the same contract as the real one: own the
// instance lock first, publish the record last, release both on stop.
const fixture = `
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { acquireInstanceLock } from ${JSON.stringify(pathToFileURL(path.resolve('runtime/instance-lock.mjs')).href)};
const args = process.argv.slice(2);
const root = args[args.indexOf('--instance') + 1];
const port = Number(args[args.indexOf('--port') + 1]);
fs.mkdirSync(root, {recursive:true});
const generation = crypto.randomUUID();
const lock = await acquireInstanceLock(root, {pid:process.pid, instanceId:'fixture', generation});
const token = crypto.randomBytes(32).toString('hex');
fs.writeFileSync(path.join(root, 'owner-token'), token, {mode:0o600});
const record = {pid:process.pid, port, instanceId:'fixture', generation, buildId:'fixture', startedAt:new Date().toISOString()};
const server = http.createServer(async (req,res) => {
  res.setHeader('Content-Type','application/json');
  const send = (value,status=200) => {res.statusCode=status;res.end(JSON.stringify(value));};
  if(req.url==='/health') return send({status:'ready',name:'DevMate',version:'test',...record});
  if(req.headers.authorization!=='Bearer '+token) return send({ok:false,error:{code:'UNAUTHORIZED',message:'Owner token required'}},401);
  if(req.url==='/api/snapshot') return send({ok:true,result:{projects:[],providers:['codex','claude','gemini','grok']}});
  if(req.url==='/api/call') {
    if(req.headers.origin!=='http://127.0.0.1:'+port) return send({ok:false,error:{code:'ORIGIN',message:'Origin required'}},403);
    let raw='';for await(const chunk of req)raw+=chunk;
    const {operation,input}=JSON.parse(raw);
    if(operation==='operations.list')return send({ok:true,result:{operations:[{name:'echo',inputSchema:{type:'object'}}]}});
    if(operation==='echo')return send({ok:true,result:input});
    if(operation==='runtime.stop') {
      if(input.expectedGeneration!==record.generation)return send({ok:false,error:{code:'GENERATION',message:'Generation mismatch'}},409);
      send({ok:true,result:{stopping:true}});
      setTimeout(()=>{fs.rmSync(path.join(root,'runtime.json'),{force:true});server.close(async()=>{await lock.close();process.exit(0);});server.closeIdleConnections();},20);
      return;
    }
    return send({ok:false,error:{code:'UNKNOWN',message:'Unknown operation'}},404);
  }
  send({ok:false,error:{code:'NOT_FOUND',message:'Not found'}},404);
});
server.on('error',()=>process.exit(2));
server.listen(port,'127.0.0.1',()=>fs.writeFileSync(path.join(root,'runtime.json'),JSON.stringify(record)));
`;

function temp(t, cleanup = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-new-runtime-'));
  if (cleanup) t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return directory;
}

test('read-only status for a new instance does not initialize files', async t => {
  const root = path.join(temp(t), 'not initialized');
  assert.deepEqual(await runtimeStatus({ instanceRoot: root }), {
    state: 'stopped', instanceRoot: root, running: false
  });
  assert.equal(fs.existsSync(root), false);
});

test('native launcher handles spaced Unicode paths, reuse, authenticated calls, and graceful stop', async t => {
  const base = temp(t, false);
  const instanceRoot = path.join(base, 'instance with spaces 项目');
  const entryPath = path.join(base, 'native fixture ü.mjs');
  fs.writeFileSync(entryPath, fixture);
  const sentinel = path.join(base, 'unrelated.txt');
  fs.writeFileSync(sentinel, 'preserve');
  t.after(async () => {
    await stopRuntime({ instanceRoot, timeoutMs: 5000 }).catch(() => {});
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const port = await freePort();
  const first = await startRuntime({ instanceRoot, entryPath, port, timeoutMs: 5000 });
  assert.equal(first.started, true);
  assert.equal(first.record.port, port);
  const second = await startRuntime({ instanceRoot, entryPath, port, timeoutMs: 5000 });
  assert.equal(second.attached, true);
  assert.equal(second.record.pid, first.record.pid);
  const client = createRuntimeClient({ instanceRoot });
  const input = { text: '中文 "quotes" $(do-not-execute) & %PATH% ^', agent: 'grok' };
  assert.deepEqual(await client.call('echo', input), input);
  assert.deepEqual((await client.operations()).operations.map(item => item.name), ['echo']);
  assert.equal((await client.snapshot()).providers.length, 4);
  await assert.rejects(client.call('runtime.stop', { expectedGeneration: 'old' }), error => error.code === 'GENERATION');
  assert.equal((await runtimeStatus({ instanceRoot })).running, true);
  const stopped = await stopRuntime({ instanceRoot, timeoutMs: 5000 });
  assert.equal(stopped.stopped, true);
  assert.deepEqual(await probeInstanceLock(instanceRoot), { alive: false });
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
});

test('unrelated listener survives a failed launch on its fixed port', async t => {
  const base = temp(t);
  const entryPath = path.join(base, 'fixture.mjs');
  fs.writeFileSync(entryPath, fixture);
  const server = http.createServer((_req, res) => res.end('unrelated'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  await assert.rejects(
    startRuntime({ instanceRoot: path.join(base, 'new'), entryPath, port, timeoutMs: 4000 }),
    /exited before readiness/
  );
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'unrelated');
});

test('a record left by a dead runtime, with a recycled live process id, neither blocks a start nor gets that process stopped', async t => {
  const base = temp(t), instanceRoot = path.join(base, 'instance'), entryPath = path.join(base, 'fixture.mjs');
  fs.mkdirSync(instanceRoot); fs.writeFileSync(entryPath, fixture);
  // The recorded process id is this very test process: alive, and not a DevMate runtime.
  const stalePort = await freePort();
  fs.writeFileSync(path.join(instanceRoot, 'runtime.json'), JSON.stringify({ pid: process.pid, port: stalePort, instanceId: 'gone', generation: 'gone', buildId: 'gone' }));
  const stale = await runtimeStatus({ instanceRoot });
  assert.deepEqual([stale.state, stale.running, stale.crashed], ['stopped', false, true], 'nobody holds the instance, so nothing is running');
  await assert.rejects(createRuntimeClient({ instanceRoot, ownerToken: 'x' }).call('echo', {}), { code: 'RUNTIME_STOPPED' });
  const started = await startRuntime({ instanceRoot, entryPath, port: await freePort(), timeoutMs: 5000 });
  t.after(() => stopRuntime({ instanceRoot, timeoutMs: 5000 }).catch(() => {}));
  assert.equal(started.started, true); assert.notEqual(started.record.pid, process.pid);
  assert.equal(readRuntimeRecord(instanceRoot).generation, started.record.generation, 'the stale record was replaced');
  await stopRuntime({ instanceRoot, timeoutMs: 5000 });
  // An explicit stop also settles a crash, so no host is asked to bring the runtime back.
  fs.writeFileSync(path.join(instanceRoot, 'runtime.json'), JSON.stringify({ pid: process.pid, port: stalePort, instanceId: 'gone', generation: 'gone', buildId: 'gone' }));
  assert.deepEqual(await stopRuntime({ instanceRoot }), { stopped: true, alreadyStopped: true, instanceRoot });
  assert.equal((await runtimeStatus({ instanceRoot })).crashed, undefined);
});

test('a live owner that does not answer as this instance is neither stopped nor replaced', async t => {
  const instanceRoot = temp(t);
  const server = http.createServer((_req, res) => res.end(JSON.stringify({status:'ready',name:'Other'})));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const lock = await acquireInstanceLock(instanceRoot, { pid: process.pid, instanceId: 'foreign', generation: 'foreign' });
  t.after(async () => { await lock.close(); await new Promise(resolve => server.close(resolve)); });
  fs.writeFileSync(path.join(instanceRoot, 'runtime.json'), JSON.stringify({
    pid:process.pid, port:server.address().port, instanceId:'foreign', generation:'foreign', buildId:'foreign'
  }));
  assert.equal((await runtimeStatus({ instanceRoot })).state, 'unavailable');
  await assert.rejects(stopRuntime({ instanceRoot }), /nothing was stopped/);
  await assert.rejects(startRuntime({ instanceRoot, timeoutMs: 600 }), error => error.code === 'RUNTIME_ALREADY_RUNNING');
  assert.equal(server.listening, true);
  assert.equal((await probeInstanceLock(instanceRoot)).generation, 'foreign');
});

test('control client rejects non-loopback and credential-bearing origins', () => {
  for (const url of ['https://example.com', 'http://example.com', 'http://secret@127.0.0.1:1234', 'http://127.0.0.1:1234/?token=x']) {
    assert.throws(() => localControlUrl(url), /loopback/);
  }
  assert.equal(localControlUrl('http://127.0.0.1:8788'), 'http://127.0.0.1:8788');
});

test('startup process exit is reported with its reason, without waiting for the full deadline', async t => {
  const base = temp(t);
  const entryPath = path.join(base, 'exit.mjs');
  fs.writeFileSync(entryPath, 'process.stderr.write(JSON.stringify({event:"failed",code:"port_in_use",message:"Port 8788 is taken."})+"\\n");process.exit(7);');
  const started = Date.now();
  await assert.rejects(startRuntime({ instanceRoot:path.join(base,'new'), entryPath, port:await freePort(), timeoutMs:5000 }),
    error => /exited before readiness: Port 8788 is taken\./.test(error.message) && error.code === 'port_in_use');
  assert.ok(Date.now() - started < 4000);
});

test('a verified shutdown-failed instance can retry stop without killing its recorded PID', async t => {
  const base=temp(t),instanceRoot=path.join(base,'instance'),entryPath=path.join(base,'retry-stop.mjs');
  fs.writeFileSync(entryPath,fixture);
  await startRuntime({instanceRoot,entryPath,port:await freePort(),timeoutMs:5000});
  const clientFactory=options=>{
    const client=createRuntimeClient(options),health=client.health;
    client.health=async(...args)=>({...await health(...args),status:'shutdown_failed'});return client;
  };
  t.after(()=>stopRuntime({instanceRoot,timeoutMs:5000}).catch(()=>{}));
  assert.equal((await stopRuntime({instanceRoot,clientFactory,timeoutMs:5000})).stopped,true);
});

test('simultaneous Start from six windows, hosts and terminals yields one verified runtime that all of them join',async t=>{
  const base=temp(t,false),instanceRoot=path.join(base,'same-shared-runtime');
  const entryPath=path.resolve('runtime/main.mjs');
  const port=await freePort();
  t.after(async()=>{
    await stopRuntime({instanceRoot,timeoutMs:15000}).catch(()=>{});
    fs.rmSync(base,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  const all=await Promise.all(Array.from({length:6},()=>startRuntime({instanceRoot,entryPath,port,timeoutMs:30000})));
  assert.ok(all.every(item=>item.running));
  assert.equal(new Set(all.map(item=>item.record.pid)).size,1);
  assert.equal(new Set(all.map(item=>item.record.generation)).size,1);
  assert.equal(all.filter(item=>item.started).length,1,'exactly one caller started it; the others attached');
  assert.equal((await runtimeStatus({instanceRoot})).record.pid,all[0].record.pid);
  const token=fs.readFileSync(path.join(instanceRoot,'owner-token'),'utf8');
  const response=await fetch('http://127.0.0.1:'+port+'/api/snapshot',{headers:{authorization:'Bearer '+token}});
  assert.equal(response.status,200,'the losing starters never overwrote the owner token');await response.text();
  await stopRuntime({instanceRoot,timeoutMs:15000});
  assert.deepEqual(await runtimeStatus({instanceRoot}),{state:'stopped',instanceRoot,running:false});
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
});

test('the runtime is started with the owner environment, without the variables an editor injects into its own processes', async t => {
  const names = ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK', 'VSCODE_PID', 'DEVMATE_LAUNCH_VISIBLE'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = '1';
  t.after(() => { for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; });
  let launched;
  const { EventEmitter } = await import('node:events');
  const spawnImpl = (file, args, options) => { launched = { file, args, options }; const child = new EventEmitter(); child.pid = 1; child.exitCode = 1; child.unref = () => {}; return child; };
  const instanceRoot = path.join(temp(t), 'instance');
  await assert.rejects(startRuntime({ instanceRoot, spawnImpl, port: await freePort(), timeoutMs: 2000 }), /exited before readiness/);
  assert.deepEqual(names.filter(name => launched.options.env[name] !== undefined), ['DEVMATE_LAUNCH_VISIBLE']);
  assert.ok(Object.keys(launched.options.env).some(name => name.toLowerCase() === 'path'));
  assert.deepEqual([launched.options.detached, launched.options.shell, launched.args.slice(1, 3)], [true, false, ['--instance', instanceRoot]]);
});
