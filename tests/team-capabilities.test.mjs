import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const temp = await fsp.mkdtemp(path.join(os.tmpdir(),'devmate-team-cap-'));
const configPath = path.join(temp,'config.json'); process.env.DEVMATE_CONFIG=configPath;
await fsp.writeFile(configPath,JSON.stringify({version:11,auth:{required:true,token:'owner-token-value-long-enough'},permissions:{profile:'fullAccess'},connection:{provider:'external',publicUrl:'https://devmate.example.com'},team:{members:[],requireWorkspaceLeaseForWrites:true},requestPolicy:{allowedHosts:[]},runtime:{},jobs:{},maintenance:{auditRetentionDays:90},activeWorkspaceId:'app',workspaces:[{id:'app',name:'app',root:temp,mode:'workspace-write',reference:false}],plugins:{enabled:[],settings:{}}},null,2));
const { __test: teamCapabilitiesTest, installTeamCapabilities }=await import('../gateway/team-capabilities.mjs');
const { runWithRequestContext }=await import('../gateway/request-context.mjs');
const { __test: teamToolDataTest }=await import('../gateway/team-tool-data.mjs');
class MockServer{constructor(){this.tools=new Map()} registerTool(n,c,h){this.tools.set(n,{config:c,handler:h})} async connect(){return'ok'}}
installTeamCapabilities(MockServer);

test('registers instance, member, and lease capabilities',async()=>{
 const server=new MockServer(); server.registerTool('write_file',{annotations:{destructiveHint:true},inputSchema:{}},async()=>({ok:true})); await server.connect();
 for(const name of ['deployment_status','deployment_readiness','team_member_create','workspace_lease_acquire']) assert.equal(server.tools.has(name),true);
 const created=await server.tools.get('team_member_create').handler({name:'Alice',role:'developer',workspaceIds:['app']}); const member=created.structuredContent.member;
 const principal={id:member.id,name:member.name,role:'developer',workspaceIds:['app'],source:'team-token'};
 await assert.rejects(runWithRequestContext({principal},()=>server.tools.get('write_file').handler({workspaceId:'app'})),/requires a lease/);
 await runWithRequestContext({principal},()=>server.tools.get('workspace_lease_acquire').handler({workspaceId:'app',ttlSeconds:120}));
 assert.equal((await runWithRequestContext({principal},()=>server.tools.get('write_file').handler({workspaceId:'app'}))).ok,true);
});

test('Host allowlist is an explicit request capability independent of provider',()=>{
 const config={connection:{provider:'external',publicUrl:'https://devmate.example.com'},requestPolicy:{allowedHosts:['wrong.example.com']}};
 assert.equal(teamToolDataTest.allowedPublicHost(config,{publicUrl:config.connection.publicUrl}),false);
 config.requestPolicy.allowedHosts=['devmate.example.com']; assert.equal(teamToolDataTest.allowedPublicHost(config,{publicUrl:config.connection.publicUrl}),true);
 config.requestPolicy.allowedHosts=[]; assert.equal(teamToolDataTest.allowedPublicHost(config,{publicUrl:config.connection.publicUrl}),true);
});

test('redacts command secrets from structured and text MCP results',()=>{
 const raw={
  command:'tool --token top-secret --mode safe',
  exitCode:0,
  timedOut:false,
  stdout:'client_secret=client-value&mode=safe',
  stderr:'Authorization: Bearer abc.def-123'
 };
 const result={structuredContent:{result:{...raw}},content:[{type:'text',text:JSON.stringify({result:raw},null,2)}]};
 teamCapabilitiesTest.sanitizeToolResult('run_command',result);
 const serialized=JSON.stringify(result);
 assert.doesNotMatch(serialized,/top-secret|client-value|abc\.def-123/);
 assert.match(result.structuredContent.result.command,/--token=redacted/);
 assert.match(result.structuredContent.result.stdout,/client_secret=redacted&mode=safe/);
 assert.match(result.structuredContent.result.stderr,/Authorization: Bearer redacted/);
});

test('preserves independent JSON text payload semantics while redacting them',()=>{
 const structured={summary:'keep',result:{command:'tool --token structured-secret',exitCode:0,stdout:'ok',stderr:''}};
 const partial={part:{command:'tool --token text-secret',exitCode:0,stdout:'ok',stderr:''}};
 const result={structuredContent:structured,content:[{type:'text',text:JSON.stringify(partial)}]};
 teamCapabilitiesTest.sanitizeToolResult('run_command',result);
 const text=JSON.parse(result.content[0].text);
 assert.deepEqual(Object.keys(text),['part']);
 assert.equal(text.summary,undefined);
 assert.match(text.part.command,/--token=redacted/);
 assert.doesNotMatch(JSON.stringify(result),/structured-secret|text-secret/);
});

test('redacts persistent process output events without rewriting ordinary text',()=>{
 const result={structuredContent:{events:[{text:'owner_token=owner-value then ok'}]},content:[{type:'text',text:'process output ready'}]};
 teamCapabilitiesTest.sanitizeToolResult('read_process_output',result);
 assert.equal(result.structuredContent.events[0].text,'owner_token=redacted then ok');
 assert.equal(result.content[0].text,'process output ready');
});

test.after(async()=>fsp.rm(temp,{recursive:true,force:true}));