import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createConnection, inspectTunnelClient, normalizeConnectionConfig } from '../runtime/connection.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4567;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

test('local default and external HTTPS do not start a relay', async () => {
  let spawns = 0;
  const shared = { localMcpUrl:'http://127.0.0.1:32123/mcp', spawnImpl:()=>{spawns++;throw new Error('Must not spawn');} };
  const local = createConnection(shared);
  assert.equal((await local.start()).phase, 'local');
  assert.equal((await local.status()).remoteMcpVerified, false);
  const external = createConnection({...shared, config:{kind:'external-https',url:'https://example.test/mcp'}});
  assert.equal((await external.start()).phase, 'configured');
  assert.equal(spawns, 0);
});

test('connection configuration accepts secret references, not secret values or old providers', () => {
  assert.throws(()=>normalizeConnectionConfig({kind:'ngrok'}), /Connection kind/);
  assert.throws(()=>normalizeConnectionConfig({kind:'external-https',url:'http://example.test/mcp'}), /HTTPS/);
  assert.throws(()=>normalizeConnectionConfig({kind:'openai-tunnel',tunnelId:'tunnel_test',executable:process.execPath,apiKey:'do-not-store'}), /Unsupported connection setting/);
  assert.throws(()=>normalizeConnectionConfig({kind:'openai-tunnel',tunnelId:'tunnel_test',executable:path.resolve('client.cmd')}), /shell script/);
});

test('official tunnel child uses native argv and its key stays out of arguments and status', async t => {
  const instanceRoot = fs.mkdtempSync(path.join(os.tmpdir(),'devmate-tunnel-unit-'));
  t.after(()=>fs.rmSync(instanceRoot,{recursive:true,force:true}));
  const child = fakeChild();
  let invocation;
  let terminated;
  const key = 'test-runtime-key-not-a-real-credential';
  const connection = createConnection({
    instanceRoot, localMcpUrl:'http://127.0.0.1:32123/mcp',
    config:{kind:'openai-tunnel',tunnelId:'tunnel_isolated',executable:process.execPath,runtimeKeyEnv:'TEST_RUNTIME_KEY'},
    env:{TEST_RUNTIME_KEY:key,DEVMATE_UNRELATED_SECRET:'not-for-tunnel',HTTPS_PROXY:'http://127.0.0.1:7890'},
    spawnImpl:(file,args,options)=>{invocation={file,args,options};return child;},
    terminateImpl:async target=>{terminated=target;child.exitCode=0;child.emit('exit',0);return{exitConfirmed:true};},
    fetchImpl:async url=>{
      assert.equal(String(url),'http://127.0.0.1:32124/readyz');
      return new Response('{}',{status:200});
    }
  });
  assert.equal((await connection.start()).phase,'connecting');
  assert.equal(invocation.options.shell,false);
  assert.equal(invocation.options.windowsHide,true);
  assert.equal(invocation.options.env.CONTROL_PLANE_API_KEY,key);
  assert.equal(invocation.options.env.DEVMATE_UNRELATED_SECRET,undefined);
  assert.equal(invocation.options.env.HTTPS_PROXY,'http://127.0.0.1:7890');
  assert.equal(JSON.stringify(invocation.args).includes(key),false);
  assert.equal(invocation.args[0],'run');
  assert.equal(invocation.args.includes('--mcp.server-url'),true);
  fs.writeFileSync(path.join(instanceRoot,'tunnel-health.url'),'http://127.0.0.1:32124');
  const state = await connection.status();
  assert.equal(state.phase,'relay-ready');
  assert.equal(state.remoteMcpVerified,false);
  assert.equal(JSON.stringify(state).includes(key),false);
  await connection.stop();
  assert.equal(terminated,child);
  assert.equal((await connection.status()).phase,'stopped');
});

test('missing tunnel key does not create an instance or run a process', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(),'devmate-tunnel-missing-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const instanceRoot=path.join(base,'absent');
  const connection=createConnection({
    instanceRoot,localMcpUrl:'http://127.0.0.1:32123/mcp',env:{},
    config:{kind:'openai-tunnel',tunnelId:'tunnel_isolated',executable:process.execPath},
    spawnImpl:()=>{throw new Error('Must not spawn');}
  });
  await assert.rejects(connection.start(),/Missing runtime key environment variable/);
  assert.equal(fs.existsSync(instanceRoot),false);
});

test('spawn error becomes failed state rather than an unhandled child error', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-tunnel-error-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const child=fakeChild();
  const connection=createConnection({
    instanceRoot:root,localMcpUrl:'http://127.0.0.1:32123/mcp',
    config:{kind:'openai-tunnel',tunnelId:'tunnel_isolated',executable:process.execPath},
    env:{CONTROL_PLANE_API_KEY:'test-only'},
    spawnImpl:()=>child,
    terminateImpl:async()=>({exitConfirmed:true})
  });
  await connection.start();
  child.emit('error',new Error('unavailable'));
  assert.equal((await connection.status()).phase,'failed');
  await connection.stop();
});

test('version inspection invokes only native --version', async () => {
  const actual=await inspectTunnelClient({
    executable:process.execPath,
    execFileImpl:async(file,args,options)=>{
      assert.equal(file,process.execPath);
      assert.deepEqual(args,['--version']);
      assert.equal(options.shell,false);
      assert.equal(options.windowsHide,true);
      return{stdout:'tunnel-client v0.0.15'};
    }
  });
  assert.equal(actual.version,'0.0.15');
});

test('version failure excludes child output from diagnostics', async () => {
  await assert.rejects(inspectTunnelClient({executable:process.execPath,execFileImpl:async()=>{
    throw new Error('fake secret from child stderr');
  }}), error => /version check failed/.test(error.message) && !error.message.includes('fake secret'));
});
