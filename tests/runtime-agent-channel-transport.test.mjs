
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startRuntime } from '../runtime/main.mjs';

const owner={id:'owner',role:'owner',surface:'local'};
async function until(check,label,timeoutMs=10000) {
  const deadline=Date.now()+timeoutMs;
  while(!check()){
    if(Date.now()>deadline) throw new Error('Timed out: '+label);
    await new Promise(resolve=>setTimeout(resolve,20));
  }
}

test('official stdio MCP channel persists exactly one Codex to Claude delivery across a tool response retry',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'devmate-agent-mcp-'));
  const instanceRoot=path.join(home,'instance'),projectRoot=path.join(home,'project');
  fs.mkdirSync(instanceRoot);fs.mkdirSync(projectRoot);
  let runtime,client;
  const providers=[];
  try {
    runtime=await startRuntime({
      instanceRoot,port:0,
      connectionFactory:()=>({async start(){},async stop(){},status(){return {kind:'local',phase:'local'};}}),
      adapterFactory:options=>{
        const native={provider:options.provider,options,calls:[],
          capabilities:{mcp:true,approvals:true,steer:false},
          async start(){return {sessionId:'session-'+options.provider,capabilities:this.capabilities};},
          async send({text}){this.calls.push(text);return {status:'completed',text:'done:'+text};},
          async cancel(){return {requested:false};},
          async close(){}};
        providers.push(native);
        return native;
      }
    });
    const {service}=runtime;
    const project=await service.call('project.create',{root:projectRoot},owner);
    const workflow=await service.call('workflow.create',{projectId:project.id,title:'Cross provider'},owner);
    const codex=await service.call('agents.start',{projectId:project.id,workflowId:workflow.id,provider:'codex'},owner);
    const claude=await service.call('agents.start',{projectId:project.id,workflowId:workflow.id,provider:'claude'},owner);
    await until(()=>service.store.get('agent',codex.id).status==='ready' &&
      service.store.get('agent',claude.id).status==='ready','both native fixture adapters');
    const codexAdapter=providers.find(item=>item.provider==='codex');
    const token=codexAdapter.options.mcpServers.find(item=>item.name==='devmate_agent_channel').env.DEVMATE_AGENT_TOKEN;
    const endpoint='http://127.0.0.1:'+runtime.port+'/api/agent';
    client=new Client({name:'devmate-agent-stdio-proof',version:'1.0.0'});
    const transport=new StdioClientTransport({
      command:process.execPath,
      args:[path.resolve('runtime/agent-channel.mjs')],
      env:{...process.env,DEVMATE_AGENT_URL:endpoint,DEVMATE_AGENT_TOKEN:token}
    });
    await client.connect(transport);
    const discovery=await client.listTools();
    const sendTool=discovery.tools.find(item=>item.name==='agent_send_message');
    assert.ok(sendTool,'Native Agent bridge must advertise its tool');
    assert.ok(sendTool.inputSchema.required.includes('operationId'),
      'The at-most-once key is mandatory in the official MCP tool contract');
    const args={
      operationId:'stdio-review-id-0001',
      recipientIds:[claude.id],
      body:'Review the latest edit before merging'
    };
    const send=async()=>client.callTool({name:'agent_send_message',arguments:args});
    const first=await send();
    const second=await send();
    assert.notEqual(first.isError,true);
    assert.notEqual(second.isError,true);
    assert.equal(first.structuredContent.id,second.structuredContent.id);
    await until(()=>service.store.get('message',first.structuredContent.id).status==='delivered',
      'verified Codex to Claude native turn');
    assert.equal(providers.find(x=>x.provider==='claude').calls.length,1);
    assert.equal(service.store.deliveriesForMessage(first.structuredContent.id).length,1);
    assert.equal(service.store.get('workflow',workflow.id).usedTurns,1);
    const invalid=await client.callTool({name:'agent_send_message',
      arguments:{recipientIds:[claude.id],body:'No idempotency key'}});
    assert.equal(invalid.isError,true,'A direct MCP request cannot bypass the required operationId');
  } finally {
    if(client) await client.close().catch(()=>{});
    if(runtime) await runtime.stop();
    fs.rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});
