import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SharedTunnelRecordStore, configurationKey } = require('../vscode-host/shared-tunnel-record-store.js');
const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-connection-readiness-'));
const configPath = path.join(temp, 'config.json');
process.env.DEVMATE_CONFIG = configPath;
await fsp.writeFile(configPath, JSON.stringify({ version: 11 }), 'utf8');
const { effectivePublicIngress, runtimePublicIngress } = await import('../gateway/public-ingress-state.mjs');
const { __test: teamToolDataTest } = await import('../gateway/team-tool-data.mjs');

function baseConfig(provider = 'cloudflare-quick', publicUrl = '') {
  return { version: 11, connection: { provider, publicUrl }, team: { members: [] }, requestPolicy: { allowedHosts: [] }, runtime: {}, jobs: {} };
}
function clearTunnel(){ const store=new SharedTunnelRecordStore({stateDirectory:temp}); const record=store.read(); if(record) store.remove(record.ownerId); }
function publishTemporaryTunnel(publicUrl='https://temporary.trycloudflare.com') {
  const settings={provider:'cloudflare-quick',publicUrl:'',ngrokUrl:'',ngrokCommandPath:'ngrok',ngrokUseManagedAccount:true,ngrokPoolingEnabled:false,ngrokTrafficPolicyFile:'',cloudflareCommandPath:'cloudflared'};
  const store=new SharedTunnelRecordStore({stateDirectory:temp}); const ownerId=`test-owner-${Date.now()}-${Math.random()}`;
  store.write(ownerId,{hostId:'vscode-test',port:8787,provider:'cloudflare-quick',configurationKey:configurationKey(settings,8787),status:'pending',publicUrl:''});
  store.write(ownerId,{status:'ready',publicUrl,readyAt:new Date().toISOString()}); return store.read();
}
function markPreflight(config, record, overrides={}) {
  config.connection={...config.connection,lastPreflightAt:new Date(Date.parse(record.readyAt)+1000).toISOString(),lastPublicHost:new URL(record.publicUrl).host,lastMcpPath:'/mcp',lastToolCount:10,lastServerName:'devmate',...overrides};
}

test('dynamic public connection is not Ready until current tunnel passes MCP preflight',()=>{
  clearTunnel(); const config=baseConfig(); const record=publishTemporaryTunnel();
  const before=runtimePublicIngress(config,{stateDirectory:temp}); assert.equal(before.available,true); assert.equal(before.verified,false);
  const effectiveBefore=effectivePublicIngress(config,{stateDirectory:temp}); assert.equal(effectiveBefore.available,false); assert.equal(effectiveBefore.verified,false);
  markPreflight(config,record); const after=effectivePublicIngress(config,{stateDirectory:temp}); assert.equal(after.available,true); assert.equal(after.verified,true); assert.equal(after.publicUrl,record.publicUrl);
});

test('stale or mismatched preflight cannot validate a newly ready tunnel',()=>{
  clearTunnel(); const config=baseConfig(); const record=publishTemporaryTunnel('https://second.trycloudflare.com');
  markPreflight(config,record,{lastPreflightAt:new Date(Date.parse(record.readyAt)-1000).toISOString()}); assert.equal(runtimePublicIngress(config,{stateDirectory:temp}).verified,false);
  markPreflight(config,record,{lastPublicHost:'wrong.example.com'}); assert.equal(runtimePublicIngress(config,{stateDirectory:temp}).verified,false);
  markPreflight(config,record,{lastServerName:'not-devmate'}); assert.equal(runtimePublicIngress(config,{stateDirectory:temp}).verified,false);
});

test('verified runtime becomes stale immediately when connection provider changes',()=>{
  clearTunnel(); const config=baseConfig(); const record=publishTemporaryTunnel('https://old.trycloudflare.com'); markPreflight(config,record);
  assert.equal(runtimePublicIngress(config,{stateDirectory:temp}).verified,true);
  config.connection.provider='ngrok'; config.connection.publicUrl=''; const stale=runtimePublicIngress(config,{stateDirectory:temp});
  assert.equal(stale.available,false); assert.equal(stale.stale,true); assert.match(stale.reason,/does not match configured provider ngrok/); assert.equal(effectivePublicIngress(config,{stateDirectory:temp}).available,false);
});

test('runtime URL cannot stand in for a different configured stable endpoint',()=>{
  clearTunnel(); const config=baseConfig(); const record=publishTemporaryTunnel('https://runtime.trycloudflare.com'); markPreflight(config,record);
  config.connection.publicUrl='https://configured.example.com'; const runtime=runtimePublicIngress(config,{stateDirectory:temp}); assert.equal(runtime.available,false); assert.equal(runtime.stale,true);
  const effective=effectivePublicIngress(config,{stateDirectory:temp}); assert.equal(effective.source,'configured'); assert.equal(effective.publicUrl,'https://configured.example.com'); assert.equal(effective.available,false); assert.equal(effective.verified,false);
});

test('explicit Host allowlist validates the effective verified URL',()=>{
  clearTunnel(); const config=baseConfig(); const record=publishTemporaryTunnel('https://allowed.trycloudflare.com'); markPreflight(config,record); const ingress=effectivePublicIngress(config,{stateDirectory:temp});
  config.requestPolicy.allowedHosts=['allowed.trycloudflare.com']; assert.equal(teamToolDataTest.allowedPublicHost(config,ingress),true);
  config.requestPolicy.allowedHosts=['wrong.example.com']; assert.equal(teamToolDataTest.allowedPublicHost(config,ingress),false);
});

test('managed stable URL requires its own preflight and cannot borrow a temporary tunnel verification',()=>{
  clearTunnel(); const config=baseConfig('cloudflare-managed','https://prod.example.com'); const record=publishTemporaryTunnel('https://production-temp.trycloudflare.com'); markPreflight(config,record);
  const runtime=runtimePublicIngress(config,{stateDirectory:temp}); assert.equal(runtime.stale,true); assert.equal(runtime.verified,false);
  const before=effectivePublicIngress(config,{stateDirectory:temp}); assert.equal(before.source,'configured'); assert.equal(before.available,false);
  config.connection.lastPreflightAt=new Date().toISOString(); config.connection.lastPublicHost='prod.example.com'; config.connection.lastMcpPath='/mcp'; config.connection.lastToolCount=10; config.connection.lastServerName='devmate';
  const stable=effectivePublicIngress(config,{stateDirectory:temp}); assert.equal(stable.source,'configured'); assert.equal(stable.publicUrl,'https://prod.example.com'); assert.equal(stable.available,true); assert.equal(stable.verified,true);
});

test.after(async()=>{clearTunnel();await fsp.rm(temp,{recursive:true,force:true});});
