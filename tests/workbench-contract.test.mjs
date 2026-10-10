import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workbenchToolDescriptors, callWorkbenchTool, registerWorkbench, readWorkbenchResource, handleWorkbench, WORKBENCH_RESOURCE_URI, WORKBENCH_MIME, WORKBENCH_OPERATIONS } from '../runtime/workbench.mjs';
import { DevMateService } from '../runtime/service.mjs';

const source=name=>readFileSync(new URL('../workbench/'+name,import.meta.url),'utf8');

test('one fullscreen resource advertises actual global/thread entrypoints and accepts an empty selection',async()=>{
  const [open,call]=workbenchToolDescriptors();
  assert.deepEqual(open._meta['openai/ui'].entrypoints,[{type:'global'},{type:'thread'}]);
  assert.equal(open._meta.ui.resourceUri,WORKBENCH_RESOURCE_URI);
  assert.deepEqual(call._meta.ui.visibility,['app']);
  assert.equal(open.inputSchema.additionalProperties,false);
  const calls=[],context={authInfo:{clientId:'owner'}};
  const service={snapshot:async(input,extra)=>{calls.push({input,extra});return{selection:{projectId:null,workflowId:null},projects:[]};}};
  const result=await callWorkbenchTool(open.name,{},service,context);
  assert.deepEqual(result.structuredContent.selection,{projectId:null,workflowId:null});
  assert.equal(calls.length,1);assert.equal(calls[0].extra,context);
  assert.deepEqual(calls[0].input,{});
  await assert.rejects(callWorkbenchTool(open.name,{token:'secret'},service,context),{code:'invalid_input'});
});
test('app tools forward only allowlisted operations to the same service, which is the one that authorizes them',async()=>{
  const records=[],service={call:async(...args)=>{records.push(args);return{id:'approval-1',status:'cancelled'};}};
  const context={authInfo:{clientId:'owner'}};
  const input={id:'approval-1',operationId:'operation-1'};
  const result=await callWorkbenchTool('workbench_call',{operation:'approval.cancel',input},service,context);
  assert.equal(records[0][0],'approval.cancel');assert.equal(records[0][1],input);assert.equal(records[0][2],context);
  assert.equal(result.structuredContent.status,'cancelled');
  // Answering an agent and sharing a folder reach the service like everything else. It refuses them from an embedded
  // workbench unless the owner chose full access (tests/runtime-access-profile.test.mjs).
  await assert.rejects(callWorkbenchTool('workbench_call',{operation:'eval',input:{}},service),{code:'invalid_input'});
  await assert.rejects(callWorkbenchTool('workbench_call',{operation:'project.list',input:[]},service),{code:'invalid_input'});
  await assert.rejects(callWorkbenchTool('workbench_call',{operation:'project.list',context:{admin:true}},service),{code:'invalid_input'});
  // Local-only operations are refused before the service is asked.
  for(const operation of ['runtime.doctor','settings.read','settings.replace','secret.set','secret.list','connection.verify','auth.status','runtime.stop','operations.call','access.update'])
    await assert.rejects(callWorkbenchTool('workbench_call',{operation,input:{}},service),{code:'invalid_input'});
  assert.equal(records.length,1);
});
test('the allow-list is exactly what the app calls, exists in the service and never contains a local-only operation',async t=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'devmate-workbench-contract-'));
  const service=new DevMateService({instanceRoot:directory,endpoint:''});
  t.after(async()=>{await service.close();rmSync(directory,{recursive:true,force:true});});
  await service.ready;
  assert.equal(new Set(WORKBENCH_OPERATIONS).size,WORKBENCH_OPERATIONS.length,'no operation is listed twice');
  for(const name of WORKBENCH_OPERATIONS) {
    const operation=service.operations.get(name);
    assert.ok(operation,name+' is registered in the service');
    assert.notEqual(operation.localOnly,true,name+' is local-only and must not be reachable through workbench_call');
  }
  // Every operation the app names is either allow-listed or local-only (and then only offered by the local page).
  const app=source('app.js'),named=[...service.operations.keys()].filter(name=>app.includes("'"+name+"'"));
  const localOnly=named.filter(name=>service.operations.get(name).localOnly);
  assert.deepEqual(localOnly,['runtime.doctor']);
  assert.match(app,/!bridge\.embedded && can\('runtime\.doctor'\)/);
  // Everything else the app names is allow-listed, the owner's own decisions included: the service offers those to an
  // embedded workbench only when the owner chose full access, and the app shows a button only for what is offered.
  const ownDecision=name=>{const operation=service.operations.get(name);return operation.humanOnly===true||!!operation.ownerDecision;};
  assert.deepEqual(named.filter(ownDecision).sort(),['approval.resolve','input.respond','project.create']);
  assert.deepEqual(named.filter(name=>!service.operations.get(name).localOnly).sort(),[...WORKBENCH_OPERATIONS].sort());
  const embedded=()=>service.visibleOperations({id:'owner',role:'owner',projectIds:null}).map(operation=>operation.name);
  for(const name of ['approval.resolve','input.respond','project.create'])assert.equal(embedded().includes(name),false,name);
  service.setAccessProfile('full');
  for(const name of ['approval.resolve','input.respond','project.create'])assert.equal(embedded().includes(name),true,name);
});
test('registration uses the same callbacks as the direct contract and keeps the error code of a failed call',async()=>{
  const tools=new Map(),resources=new Map();
  const server={registerTool:(name,config,fn)=>tools.set(name,{config,fn}),registerResource:(name,uri,config,fn)=>resources.set(uri,{config,fn})};
  registerWorkbench(server,{snapshot:async()=>({projects:[{id:'p',root:'C:/secret/path'}],counts:{tasks:3},selection:{projectId:null,workflowId:null}}),
    call:async name=>{if(name==='workspace.delete')throw Object.assign(new Error('Too large to keep.'),{code:'too_large_to_keep'});return{items:[]};}});
  assert.equal(tools.size,2);assert.equal(resources.size,1);
  assert.equal(resources.get(WORKBENCH_RESOURCE_URI).config.mimeType,WORKBENCH_MIME);
  const open=tools.get('open_devmate_workbench');
  assert.equal(open.config.inputSchema.safeParse({}).success,true);
  assert.equal(open.config.inputSchema.safeParse({auth:{owner:true}}).success,false);
  // Opening answers the model with what was opened and how much is there, never with the workspace itself.
  assert.deepEqual((await open.fn({},{})).structuredContent,{selection:{projectId:null,workflowId:null},counts:{tasks:3}});
  const call=tools.get('workbench_call');
  assert.equal(call.config.inputSchema.safeParse({operation:'runtime.doctor'}).success,false);
  assert.deepEqual((await call.fn({operation:'project.list'},{})).structuredContent,{items:[]});
  const failed=await call.fn({operation:'workspace.delete',input:{path:'big'}},{});
  assert.equal(failed.isError,true);
  assert.deepEqual(failed.structuredContent.error,{code:'too_large_to_keep',message:'Too large to keep.'});
  assert.equal(failed.content[0].text,'Too large to keep.');
});
test('HTML is standalone and uses only the bundled official SDK without a legacy bridge',async()=>{
  const resource=await readWorkbenchResource(),content=resource.contents[0];
  assert.equal(content.mimeType,WORKBENCH_MIME);
  assert.deepEqual(content._meta.ui.csp,{connectDomains:[],resourceDomains:[]});
  assert.match(content.text,/ui\/initialize/);
  assert.match(content.text,/workbench_call/);
  // Fullscreen is asked for through the official request, not assumed from resource metadata.
  assert.match(content.text,/ui\/request-display-mode/);
  assert.match(source('bridge.js'),/this\.app\.requestDisplayMode\(\{mode\}/);
  assert.doesNotMatch(content.text,/window\.openai|<script[^>]+src=|<link[^>]+href=/);
  assert.doesNotMatch(content.text,/DEVMATE_NONCE|DEVMATE_STYLES|DEVMATE_BRIDGE|DEVMATE_APP/);
  const nonce=content.text.match(/script-src 'nonce-([^']+)'/)[1];
  const scriptNonces=[...content.text.matchAll(/<script nonce="([^"]+)"/g)].map(match=>match[1]);
  assert.deepEqual(scriptNonces,[nonce,nonce]);
  assert.equal(content.text.match(/<style nonce="([^"]+)"/)[1],nonce);
  // Every response gets its own nonce, and embedded sources cannot close their own element.
  assert.notEqual((await readWorkbenchResource()).contents[0].text.match(/script-src 'nonce-([^']+)'/)[1],nonce);
  assert.equal(content.text.match(/<\/script/g).length,2);assert.equal(content.text.match(/<\/style/g).length,1);
});
test('the bridge bundle that is served is the current build of bridge.js',async()=>{
  const {build}=await import('esbuild');
  // The same options as workbench/build.mjs, kept in memory.
  const result=await build({entryPoints:[fileURLToPath(new URL('../workbench/bridge.js',import.meta.url))],write:false,
    bundle:true,platform:'browser',format:'iife',target:'es2022',minify:true,legalComments:'inline',sourcemap:false});
  assert.equal(result.outputFiles[0].text===source('bridge.bundle.js'),true,'workbench/bridge.bundle.js is stale: run node workbench/build.mjs');
});
test('the app builds every node through DOM APIs and never from markup, script URLs or browser dialogs',()=>{
  const app=source('app.js'),absent=(pattern,why)=>assert.equal(app.match(pattern)?.[0],undefined,why);
  absent(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|javascript:/,'nodes are built with DOM APIs only');
  absent(/(?<![.\w])(confirm|alert|prompt)\(/,'sandboxed hosts answer browser dialogs with "no"; use the in-page dialogs');
  absent(/setAttribute\('(style|href|src|on\w+)'/,'no inline styles, links or handlers from data');
  // The session of the local page travels in a request header only: never in a cookie, never in a URL.
  absent(/[?&](token|key|auth|access_token|session)=/i,'no credential in a URL');
  absent(/EventSource|document\.cookie|localStorage/,'the event stream is read with fetch, which can carry the header; nothing outlives the tab');
  const bridge=source('bridge.js');
  assert.match(bridge,/fetch\('\/api\/call',\{method:'POST',credentials:'omit'/);assert.match(bridge,/fetch\('\/events',\{credentials:'omit'/);
  assert.doesNotMatch(bridge,/credentials:'(same-origin|include)'|document\.cookie|localStorage|[?&](token|session)=/);
  const html=source('index.html');
  assert.doesNotMatch(html,/method="dialog"|\son\w+=|javascript:/);
  assert.match(html,/form-action 'none'/);
});
test('text, control borders and focus rings keep WCAG AA contrast in the light and the dark theme',()=>{
  const css=source('styles.css');
  const full=hex=>hex.length===4?'#'+[...hex.slice(1)].map(c=>c+c).join(''):hex;
  const tokens=block=>Object.fromEntries([...block.matchAll(/--([a-z]+):(#[0-9a-f]{3,6})\b/g)].map(match=>[match[1],full(match[2])]));
  const light=tokens(css.match(/:root\{([^}]+)\}/)[1]),dark=tokens(css.match(/:root\[data-theme=dark\]\{([^}]+)\}/)[1]);
  const media=tokens(css.match(/@media\(prefers-color-scheme:dark\)\{:root:not\(\[data-theme=light\]\)\{([^}]+)\}/)[1]);
  for(const key of Object.keys(dark))assert.equal(media[key],dark[key],'the system dark theme uses the same '+key+' as the chosen dark theme');
  const luminance=hex=>{
    const [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(c=>c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4);
    return 0.2126*r+0.7152*g+0.0722*b;
  };
  const contrast=(a,b)=>{const [hi,lo]=[luminance(a),luminance(b)].sort((x,y)=>y-x);return (hi+0.05)/(lo+0.05);};
  for(const [theme,t] of [['light',light],['dark',dark]]) {
    const text=[['ink','bg'],['ink','panel'],['ink','tint'],['muted','bg'],['muted','panel'],['muted','tint'],['accent','panel'],['accent','tint'],['accent','bg'],
      ['danger','panel'],['danger','tint'],['danger','bg'],['warn','panel'],['warn','tint'],['panel','accent'],['panel','danger']];
    for(const [fg,bg] of text)assert.ok(contrast(t[fg],t[bg])>=4.5,theme+': '+fg+' on '+bg+' is '+contrast(t[fg],t[bg]).toFixed(2)+':1');
    for(const [fg,bg] of [['control','panel'],['control','bg'],['accent','panel'],['accent','bg'],['accent','tint']])
      assert.ok(contrast(t[fg],t[bg])>=3,theme+': '+fg+' against '+bg+' is '+contrast(t[fg],t[bg]).toFixed(2)+':1');
  }
  assert.match(css,/:focus-visible\{outline:3px solid var\(--accent\)/);
});
test('local HTML routing is explicit and never handles API or unrelated routes',async()=>{
  let status,headers,body;const res={writeHead:(s,h)=>{status=s;headers=h;},end:b=>{body=b;}};
  assert.equal(await handleWorkbench({url:'/api/call',method:'POST'},res),false);
  assert.equal(await handleWorkbench({url:'/',method:'POST'},res),true);assert.equal(status,405);
  assert.equal(await handleWorkbench({url:'/workbench',method:'HEAD'},res),true);
  assert.equal(status,200);assert.equal(headers['Cache-Control'],'no-store');assert.equal(body,undefined);
});
