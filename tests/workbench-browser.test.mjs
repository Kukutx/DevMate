import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { DevMateService } from '../runtime/service.mjs';
import { workbenchHtml } from '../runtime/workbench.mjs';
import { resolveTool } from '../runtime/platform/tools.mjs';

const testOwner = Object.freeze({ id: 'owner', role: 'owner', surface: 'local' });
const ownerCall = (service, name, input = {}) => service.call(name, input, testOwner);
const candidates=[process.env.DEVMATE_TEST_BROWSER,chromium.executablePath(),
  path.join(process.env.PROGRAMFILES||'C:/Program Files','Google/Chrome/Application/chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe')].filter(Boolean);
const executablePath=candidates.find(value=>existsSync(value));
const skip=!executablePath?'No installed Chromium browser; set DEVMATE_TEST_BROWSER.':false;
const hasTool=name=>{try{return !!resolveTool(name);}catch{return false;}};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,what,timeout=10000) {
  for(const end=Date.now()+timeout;Date.now()<end;await delay(25))if(await check())return;
  throw new Error('Timed out waiting for '+what);
}
let browser;
before(async()=>{if(executablePath)browser=await chromium.launch({executablePath,headless:true});});
after(async()=>{await browser?.close();});

/** An in-memory stand-in for the service that answers like it: lists honour status, newestFirst, limit and cursor. */
function fixture() {
  const calls=[],refs=[],failures=new Map();
  const projects=[{id:'p-one',name:'Project One',root:'C:/fixture-one',access:'write',revision:1},{id:'p-two',name:'Project Two',root:'C:/fixture-two',access:'write',revision:1}];
  const workflows=[{id:'w-one',projectId:'p-one',title:'Workflow One',status:'active',revision:1}];
  const agents=[{id:'a-one',projectId:'p-one',workflowId:'w-one',provider:'codex',label:'First agent',status:'ready',capabilities:{steer:true,resume:true}}];
  const approvals=[{id:'approval-001',projectId:'p-one',agentId:'a-one',summary:'Permission from native agent',status:'pending',revision:1,
    options:[{optionId:'allow_once_native',name:'Allow once from provider'},{optionId:'reject_native',name:'Reject from provider'}]}];
  const inputs=[{id:'input-001',projectId:'p-one',kind:'item/tool/requestUserInput',status:'pending',details:{questions:[{id:'route',question:'Choose a route',isOther:false,options:[{label:'Short',description:'Direct'},{label:'Scenic',description:'Long'}]}]}}];
  const messages=[],tasks=[],history=[],files=[{name:'note.md',path:'note.md',type:'file'}];
  let text='original text',sha256='sha-original';
  const inProject=(all,input)=>all.filter(item=>(!input.projectId||item.projectId===input.projectId)&&(!input.status||item.status===input.status));
  function page(all,input) {
    const ordered=input.newestFirst?[...all].reverse():[...all],start=input.cursor?ordered.findIndex(item=>item.id===input.cursor)+1:0,limit=input.limit||100;
    const items=ordered.slice(start,start+limit);
    return {items,...(start+limit<ordered.length?{nextCursor:items.at(-1).id}:{})};
  }
  const snapshot=input=>({instance:{name:'Isolated fixture'},viewer:{id:'owner',displayName:'Owner',role:'owner'},projects,workflows:workflows.filter(item=>item.projectId===input.projectId),
    selection:{projectId:input.projectId||null,workflowId:input.workflowId||null},providers:['codex','claude','gemini','grok'].map(id=>({id,name:id,available:true})),
    agents:inProject(agents,input),tasks:[],approvals:[],inputs:[],artifacts:[],references:refs,activity:[],revision:0});
  async function call(operation,input={}) {
    calls.push({operation,input});
    if(failures.has(operation)){const failure=failures.get(operation);failures.delete(operation);throw failure;}
    if(operation==='workbench.snapshot')return snapshot(input);
    if(operation==='project.list')return {items:projects};
    if(operation==='project.remove'){projects.splice(projects.findIndex(item=>item.id===input.id),1);return{id:input.id,removed:true};}
    if(operation==='workspace.files')return {items:files};
    if(operation==='workspace.read')return {path:input.path,text,sha256};
    if(operation==='workspace.write') {
      if(input.expectedSha256!==sha256)throw Object.assign(new Error('File changed; refresh before saving.'),{code:'conflict'});
      text=input.text;sha256='sha-next';return {path:input.path,sha256};
    }
    if(operation==='workspace.history')return {items:history};
    if(operation==='agents.list')return page(inProject(agents,input),input);
    if(operation==='agents.stop'){agents.find(item=>item.id===input.id).status='closed';return{id:input.id,status:'closed'};}
    if(operation==='approval.list')return page(inProject(approvals,input),input);
    if(operation==='input.list')return page(inProject(inputs,input),input);
    if(operation==='approval.resolve'){const item=approvals.find(x=>x.id===input.id);item.status='resolved';return item;}
    if(operation==='input.respond'){const item=inputs.find(x=>x.id===input.id);item.status='resolved';return item;}
    if(operation==='message.list')return page(inProject(messages,input),input);
    if(operation==='message.send'){const item={id:'message-'+String(messages.length+1).padStart(3,'0'),projectId:input.projectId,sender:{label:'You'},recipientIds:input.recipientIds,body:input.body,status:'queued'};messages.push(item);return item;}
    if(operation==='task.list')return page(inProject(tasks,input),input);
    if(operation==='task.create'){const item={id:'task-'+String(tasks.length+1).padStart(4,'0'),projectId:input.projectId,title:input.title,instruction:input.instruction,status:'pending',revision:1};tasks.push(item);return item;}
    if(operation==='reference.list')return {items:refs.filter(x=>x.projectId===input.projectId)};
    if(operation==='reference.add'){const item={...input,id:'ref-'+(refs.length+1)};refs.push(item);return item;}
    if(operation==='reference.remove'){const i=refs.findIndex(x=>x.id===input.id);if(i>=0)refs.splice(i,1);return{removed:true};}
    return {items:[]};
  }
  const count=operation=>calls.filter(item=>item.operation===operation).length;
  return {calls,call,count,refs,projects,agents,approvals,inputs,messages,tasks,files,history,
    setExternalEdit:()=>{sha256='external-change';},failNext:(operation,message,code='operation_failed')=>failures.set(operation,Object.assign(new Error(message),{code}))};
}
/** Hold the next call of one operation until released, to observe the page while it is in flight. */
function gate(f,operation) {
  const original=f.call;let release,entered,armed=true;
  const open=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  f.call=async(name,input)=>{if(name===operation&&armed){armed=false;entered();await open;}return original(name,input);};
  return {started,release};
}
/**
 * Serves the real page like the runtime: a single-use link signs a tab in, /api/call answers with JSON errors, /events is a
 * stream, both are 401 once signed out; /host embeds the page like an MCP Apps host. With requireSession, calls without the
 * session of a signed-in tab are refused, as the runtime refuses them.
 */
async function serverFixture(f,{sandbox='',context={theme:'dark',displayMode:'fullscreen'},requireSession=false}={}) {
  const html=await workbenchHtml(),streams=new Set(),state={signedOut:false},codes=new Set(),sessions=new Set(),seen=[];
  const allowed=req=>{
    seen.push({url:req.url,authorization:req.headers.authorization,cookie:req.headers.cookie});
    return !state.signedOut&&(!requireSession||sessions.has(String(req.headers.authorization||'').replace(/^Bearer /,'')));
  };
  const refuse=res=>{res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:{code:'unauthorized',message:'Local owner authentication required.'}}));};
  const server=createServer(async(req,res)=>{
    if(req.url==='/api/call') {
      let body='';for await(const part of req)body+=part;
      if(!allowed(req))return refuse(res);
      try {const {operation,input}=JSON.parse(body),result=await f.call(operation,input);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,result}));}
      catch(error){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:{code:error.code,message:error.message}}));}
    } else if(req.url==='/api/session/exchange') {
      let body='';for await(const part of req)body+=part;
      const {code}=JSON.parse(body);
      if(!codes.delete(code))return refuse(res);
      const session='tab-'+randomUUID();sessions.add(session);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,result:{session}}));
    } else if(req.url==='/events') {
      if(!allowed(req))return refuse(res);
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});res.write('retry: 150\n: connected\n\n');
      streams.add(res);req.once('close',()=>streams.delete(res));
    } else if(req.url==='/host') {
      res.writeHead(200,{'Content-Type':'text/html'});res.end(String.raw`<!doctype html><html><body><iframe id="app" src="/iframe" ${sandbox?'sandbox="'+sandbox+'"':''} style="width:1100px;height:900px"></iframe><script>
        window.received=[];window.contextUpdates=[];window.displayRequests=[];
        const hostContext=${JSON.stringify(context)};
        addEventListener('message',async event=>{
          const m=event.data;if(m?.jsonrpc!=='2.0')return;received.push(m);
          const send=result=>event.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');
          if(m.method==='ui/initialize')send({protocolVersion:m.params.protocolVersion,hostInfo:{name:'Isolated test host',version:'1.0.0'},hostCapabilities:{serverTools:{},updateModelContext:{text:{},resourceLink:{}}},hostContext});
          else if(m.method==='ui/notifications/initialized'){
            event.source.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-input',params:{arguments:{projectId:'p-one',workflowId:'w-one'}}},'*');
            const r=await fetch('/api/call',{method:'POST',body:JSON.stringify({operation:'workbench.snapshot',input:{projectId:'p-one',workflowId:'w-one'}})}).then(x=>x.json());
            event.source.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{content:[{type:'text',text:'Ready'}],structuredContent:r.result}},'*');
          } else if(m.method==='tools/call'){
            const r=await fetch('/api/call',{method:'POST',body:JSON.stringify(m.params.arguments)}).then(x=>x.json());
            send(r.ok?{content:[{type:'text',text:'Done'}],structuredContent:r.result}:{isError:true,content:[{type:'text',text:r.error.message}],structuredContent:{error:r.error}});
          } else if(m.method==='ui/update-model-context'){contextUpdates.push(m.params);send({});}
          else if(m.method==='ui/request-display-mode'){
            displayRequests.push(m.params);send({mode:m.params.mode});
            event.source.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{displayMode:m.params.mode}},'*');
          }
        });
        </script></body></html>`);
    } else {res.writeHead(200,{'Content-Type':'text/html'});res.end(html);}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {url:'http://127.0.0.1:'+server.address().port,streams,seen,
    link:()=>{const code='code-'+randomUUID();codes.add(code);return '/?code='+code;},
    push:event=>{for(const res of streams)res.write('data: '+JSON.stringify(event)+'\n\n');},
    signOut:({dropStreams=true}={})=>{state.signedOut=true;if(dropStreams)for(const res of streams)res.destroy();},signIn:()=>{state.signedOut=false;},
    close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
/** A fresh browser context on the served page. Any browser dialog or page error fails the test that opened it. */
async function open(t,server,{route=server.link(),viewport={width:1365,height:960}}={}) {
  const context=await browser.newContext({viewport}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',dialog=>{errors.push('browser dialog: '+dialog.message());void dialog.dismiss().catch(()=>{});});
  t.after(()=>context.close());
  await page.goto(server.url+route);
  return {page,errors};
}
const dialogClosed=page=>page.waitForFunction(()=>!document.getElementById('dialog').open);
const focused=page=>page.evaluate(()=>{const node=document.activeElement;return{tag:node.tagName,id:node.id,text:node.textContent.slice(0,40),value:node.value,start:node.selectionStart,end:node.selectionEnd};});
async function selectScope(page) {
  await page.getByRole('heading',{name:'Your projects, together'}).waitFor();
  await page.selectOption('#project','p-one');await page.selectOption('#workflow','w-one');
  await page.getByRole('heading',{name:'Workflow One',exact:true}).waitFor();
}

// Every test has its own server, fixture and browser context, and most of their time is waiting, so they run side by side.
describe('workbench in a real browser',{concurrency:6},()=>{
test('real Workbench in isolated Chromium: explicit scope, files, native approvals and structured input',{skip,timeout:60000},async t=>{
  const f=fixture(),server=await serverFixture(f);t.after(server.close);
  const {page,errors}=await open(t,server);
  await page.getByRole('heading',{name:'Your projects, together'}).waitFor();
  assert.equal(await page.locator('#project').inputValue(),'');
  assert.equal(f.calls.some(x=>x.operation==='agents.start'),false);
  await page.selectOption('#project','p-one');await page.selectOption('#workflow','w-one');
  await page.getByRole('tab',{name:'Files',exact:true}).click();
  await page.getByRole('button',{name:'note.md',exact:true}).click();
  const editor=page.getByRole('textbox',{name:'File contents'});
  await editor.fill('edited content');await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('file-status')?.textContent==='Saved');
  assert.equal(f.calls.find(x=>x.operation==='workspace.write').input.expectedSha256,'sha-original');
  await editor.fill('unsaved conflict draft');f.setExternalEdit();await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'File changed'}).waitFor();
  assert.equal(await editor.inputValue(),'unsaved conflict draft');
  // Another tab does not cost the unsaved draft, and no browser dialog is involved.
  await page.getByRole('tab',{name:'Approvals',exact:true}).click();
  await page.getByRole('button',{name:'Allow once from provider',exact:true}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.badge')].some(x=>x.textContent==='resolved'));
  assert.equal(f.calls.find(x=>x.operation==='approval.resolve').input.optionId,'allow_once_native');
  assert.equal(await page.getByRole('button',{name:'Approve',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Allow once from provider',exact:true}).count(),0,'an answered request offers no decision any more');
  await page.getByLabel('Choose a route').selectOption('Short');
  await page.getByRole('button',{name:'Respond',exact:true}).click();
  await until(()=>f.count('input.respond')===1,'the answer');
  assert.deepEqual(f.calls.find(x=>x.operation==='input.respond').input.response,{answers:{route:{answers:['Short']}}});
  await page.getByRole('tab',{name:'Files',exact:true}).click();
  assert.equal(await editor.inputValue(),'unsaved conflict draft');
  assert.deepEqual(errors,[]);
  mkdirSync('tmp/workbench-validation',{recursive:true});
  await page.screenshot({path:'tmp/workbench-validation/local-files.png',fullPage:true});
  await page.getByRole('tab',{name:'Agents',exact:true}).click();
  await page.screenshot({path:'tmp/workbench-validation/local-agents.png',fullPage:true});
});

test('official MCP Apps SDK runs in iframe and attaches real saved references without sending a chat message',{skip,timeout:60000},async t=>{
  const f=fixture(),server=await serverFixture(f);t.after(server.close);
  const {page,errors}=await open(t,server,{route:'/host',viewport:{width:1400,height:1100}});
  const frame=page.frameLocator('#app');
  await frame.getByRole('heading',{name:'Workflow One',exact:true}).waitFor();
  assert.equal(await frame.locator('#project').inputValue(),'p-one');
  assert.equal(await frame.locator('#connection').textContent(),'Connected · Isolated test host');
  await frame.getByRole('tab',{name:'Files',exact:true}).click();await frame.getByRole('button',{name:'note.md',exact:true}).click();
  await frame.getByRole('button',{name:'Reference',exact:true}).click();
  await frame.locator('#reference-count').filter({hasText:'1'}).waitFor();
  await frame.getByRole('button',{name:'Add to conversation',exact:true}).click();
  await page.waitForFunction(()=>window.contextUpdates.length===1);
  const messages=await page.evaluate(()=>({methods:received.map(x=>x.method),contexts:contextUpdates,display:displayRequests}));
  assert(messages.methods.includes('ui/initialize'));assert(messages.methods.includes('tools/call'));
  assert.equal(messages.methods.includes('ui/message'),false);
  assert.equal(messages.contexts[0].content[0].type,'resource_link');
  assert.match(messages.contexts[0].content[0].uri,/devmate:\/\/project\/p-one\/file\/note.md/);
  // The host already shows the app fullscreen and offers no other mode: nothing is requested and no control is offered.
  assert.deepEqual(messages.display,[]);
  assert.equal(await frame.locator('#display').isVisible(),false);
  assert(f.calls.some(x=>x.operation==='reference.add'));
  assert.equal(f.calls.some(x=>x.operation==='agents.start'),false);
  assert.equal(await page.frames().find(item=>item.url().endsWith('/iframe')).evaluate(()=>document.documentElement.dataset.theme),'dark','the host theme is applied');
  mkdirSync('tmp/workbench-validation',{recursive:true});
  await page.screenshot({path:'tmp/workbench-validation/embedded-dark.png'});
  // No event stream reaches a hosted app, so while an agent is working it looks again by itself.
  f.agents[0].status='running';
  await frame.getByRole('button',{name:'Refresh',exact:true}).click();
  await until(async()=>await frame.locator('#refresh').getAttribute('aria-busy')===null,'the refresh to end');
  const seen=f.count('workbench.snapshot');
  await until(()=>f.count('workbench.snapshot')>seen,'a refresh by itself while an agent is working',16000);
  assert.equal(server.streams.size,0);
  assert.deepEqual(errors,[]);
});

test('finding 1: a server event refreshes the lists and never touches what the person is typing',{skip,timeout:60000},async t=>{
  const f=fixture(),server=await serverFixture(f);t.after(server.close);
  const {page,errors}=await open(t,server);
  await selectScope(page);
  await until(()=>server.streams.size===1,'the event stream');
  await page.getByRole('tab',{name:'Messages',exact:true}).click();
  await page.getByLabel('First agent').check();
  const draft=page.getByLabel('Message',{exact:true});
  await draft.fill('half written thought');
  await draft.evaluate(node=>{node.focus();node.setSelectionRange(4,9);});
  f.messages.push({id:'message-900',projectId:'p-one',sender:{label:'First agent'},recipientIds:[],body:'reply from the agent',status:'delivered'});
  server.push({type:'message.created',projectId:'p-one',entity:{body:{omitted:true,bytes:20}}});
  await page.getByText('reply from the agent').waitFor();
  assert.deepEqual(await focused(page),{tag:'TEXTAREA',id:'',text:'',value:'half written thought',start:4,end:9});
  assert.equal(await page.getByLabel('First agent').isChecked(),true);
  await page.keyboard.type('X');
  assert.equal(await draft.inputValue(),'halfXten thought');
  // A burst of events while typing: every keystroke lands, in order, in the same control.
  const snapshots=f.count('workbench.snapshot');
  for(let i=0;i<6;i++){server.push({type:'agent.native',projectId:'p-one'});await page.keyboard.type(String(i));await delay(120);}
  await until(()=>f.count('workbench.snapshot')>snapshots,'a refresh during the burst');
  assert.equal(await draft.inputValue(),'halfX012345ten thought');
  assert.equal((await focused(page)).tag,'TEXTAREA');
  // Events of another project are not this page's business. What the burst still owes arrives first: a refresh follows
  // its event by up to a second, and later than that on a busy machine.
  let quiet;
  do{quiet=f.count('workbench.snapshot');await delay(1500);}while(f.count('workbench.snapshot')!==quiet);
  server.push({type:'task.updated',projectId:'p-two'});await delay(1500);
  assert.equal(f.count('workbench.snapshot'),quiet);
  // A structured answer in progress survives a new request arriving.
  await page.getByRole('tab',{name:'Approvals',exact:true}).click();
  const route=page.getByLabel('Choose a route');
  await route.selectOption('Scenic');await route.focus();
  f.approvals.push({id:'approval-002',projectId:'p-one',agentId:'a-one',summary:'Second permission request',status:'pending',revision:1,options:[{optionId:'ok',name:'Allow second'}]});
  server.push({type:'approval.created',projectId:'p-one'});
  await page.getByRole('heading',{name:'Second permission request'}).waitFor();
  assert.equal(await route.inputValue(),'Scenic');
  assert.equal((await focused(page)).tag,'SELECT');
  // So does the search box of the file browser.
  await page.getByRole('tab',{name:'Files',exact:true}).click();
  const search=page.getByRole('textbox',{name:'Search text or file pattern'});
  await search.fill('needle in a haystack');await search.evaluate(node=>node.setSelectionRange(6,6));
  f.files.push({name:'added-by-agent.md',path:'added-by-agent.md',type:'file'});
  server.push({type:'workspace.file.written',projectId:'p-one'});
  await page.getByRole('button',{name:'added-by-agent.md',exact:true}).waitFor();
  assert.deepEqual(await focused(page),{tag:'INPUT',id:'',text:'',value:'needle in a haystack',start:6,end:6});
  // The message draft is still there after all of that.
  await page.getByRole('tab',{name:'Messages',exact:true}).click();
  assert.equal(await draft.inputValue(),'halfX012345ten thought');
  assert.equal(await page.getByLabel('First agent').isChecked(),true);
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await until(()=>f.count('message.send')===1,'the message');
  assert.deepEqual(f.calls.find(x=>x.operation==='message.send').input.recipientIds,['a-one']);
  await page.waitForFunction(()=>document.querySelector('textarea').value==='');
  assert.deepEqual(errors,[]);
});

test('findings 2 and 3: changes never drop each other, a dialog closes only after its own change, Enter submits and × does not',{skip,timeout:60000},async t=>{
  const f=fixture(),server=await serverFixture(f);t.after(server.close);
  const {page,errors}=await open(t,server);
  await selectScope(page);
  const tasks=()=>f.count('task.create'),inDialog=page.locator('#dialog');
  // A slow change is in flight ...
  await page.getByRole('tab',{name:'Agents',exact:true}).click();
  const stop=gate(f,'agents.stop'),stopButton=page.getByRole('button',{name:'Stop',exact:true});
  await stopButton.click();await stop.started;
  assert.equal(await stopButton.isDisabled(),true);assert.equal(await stopButton.getAttribute('aria-busy'),'true');
  // ... and another one, submitted with Enter from a dialog field, is sent at once and closes its dialog when it has succeeded.
  await page.getByRole('tab',{name:'Tasks',exact:true}).click();
  const createTask=page.getByRole('button',{name:'Create task',exact:true});
  await createTask.click();
  await page.getByRole('dialog',{name:'Create task'}).waitFor();
  assert.equal((await focused(page)).tag,'INPUT','the first field has the focus');
  await page.getByLabel('Instruction',{exact:true}).fill('Inspect the fixture');
  await page.getByLabel('Title',{exact:true}).fill('Created with Enter');
  await page.getByLabel('Title',{exact:true}).press('Enter');
  await until(()=>tasks()===1,'task.create while agents.stop is still running');
  await dialogClosed(page);
  assert.equal(f.count('agents.stop'),0,'the slow change has not finished yet');
  assert.equal(await page.locator('#notice').textContent(),'Task created.');
  await page.getByRole('heading',{name:'Created with Enter'}).waitFor();
  assert.equal((await focused(page)).text,'Create task','focus returns to the control that opened the dialog');
  stop.release();await until(()=>f.count('agents.stop')===1,'agents.stop');
  // Enter with a field missing sends nothing, keeps the dialog and says why.
  await createTask.click();await page.getByLabel('Title',{exact:true}).press('Enter');
  await inDialog.getByRole('alert').filter({hasText:'Enter a title.'}).waitFor();
  assert.equal(await inDialog.evaluate(node=>node.open),true);assert.equal(tasks(),1);
  // × is an ordinary button: it closes without submitting.
  assert.equal(await page.locator('#dialog-close').getAttribute('type'),'button');
  assert.equal(await inDialog.locator('button[type=submit]').count(),1);
  await page.getByLabel('Title',{exact:true}).fill('Never created');await page.getByLabel('Instruction',{exact:true}).fill('Nothing');
  await page.locator('#dialog-close').click();await dialogClosed(page);
  await delay(150);assert.equal(tasks(),1);
  // While its own change runs the dialog stays open with its submit control disabled.
  const slow=gate(f,'task.create');
  await createTask.click();
  await page.getByLabel('Title',{exact:true}).fill('Slow task');await page.getByLabel('Instruction',{exact:true}).fill('Wait for it');
  const submit=inDialog.getByRole('button',{name:'Create',exact:true});
  await submit.click();await slow.started;
  assert.equal(await inDialog.evaluate(node=>node.open),true);assert.equal(await submit.isDisabled(),true);
  await page.getByLabel('Title',{exact:true}).press('Enter');await delay(100);
  slow.release();await dialogClosed(page);
  assert.equal(tasks(),2,'a second Enter while the change was running did not send it twice');
  // A change that fails keeps the dialog and what was typed.
  f.failNext('task.create','Workflow turn budget reached.','workflow_budget');
  await createTask.click();
  await page.getByLabel('Title',{exact:true}).fill('Over budget');await page.getByLabel('Instruction',{exact:true}).fill('Try');
  await submit.click();
  await inDialog.getByRole('alert').filter({hasText:'Workflow turn budget reached.'}).waitFor();
  assert.equal(await inDialog.evaluate(node=>node.open),true);
  assert.equal(await page.getByLabel('Title',{exact:true}).inputValue(),'Over budget');
  assert.equal(await submit.isDisabled(),false);
  await page.keyboard.press('Escape');await dialogClosed(page);
  assert.deepEqual(errors,[]);
});

test('finding 4: inside a sandboxed host the app asks in the page, requests fullscreen officially and refreshes on return',{skip,timeout:60000},async t=>{
  const f=fixture();
  const server=await serverFixture(f,{sandbox:'allow-scripts allow-same-origin',context:{theme:'light',displayMode:'inline',availableDisplayModes:['inline','fullscreen']}});
  t.after(server.close);
  const {page,errors}=await open(t,server,{route:'/host',viewport:{width:1400,height:1100}});
  const frame=page.frameLocator('#app');
  await frame.getByRole('heading',{name:'Workflow One',exact:true}).waitFor();
  const inner=page.frames().find(item=>item.url().endsWith('/iframe'));
  // The premise of the finding: this frame cannot show a browser confirmation at all.
  assert.equal(await inner.evaluate(()=>window.confirm('blocked by the sandbox')),false);
  assert.deepEqual(errors,[],'no browser dialog was shown');
  // Fullscreen is requested through ui/request-display-mode because the host offers it; inline keeps working and reports its size.
  await page.waitForFunction(()=>window.displayRequests.length===1);
  assert.deepEqual(await page.evaluate(()=>displayRequests[0]),{mode:'fullscreen'});
  const display=frame.getByRole('button',{name:'Exit full screen',exact:true});
  await display.waitFor();
  const sizes=()=>page.evaluate(()=>received.filter(message=>message.method==='ui/notifications/size-changed').length);
  await delay(300);const whileFullscreen=await sizes();
  await display.click();
  await frame.getByRole('button',{name:'Full screen',exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>displayRequests.map(item=>item.mode)),['fullscreen','inline']);
  assert.equal(await inner.evaluate(()=>document.documentElement.dataset.display),'inline');
  await until(async()=>await sizes()>whileFullscreen,'the inline frame to report its content size');
  const reported=await page.evaluate(()=>received.filter(message=>message.method==='ui/notifications/size-changed').at(-1).params);
  assert(reported.height>300&&reported.width>300,'a real content size is reported: '+JSON.stringify(reported));
  mkdirSync('tmp/workbench-validation',{recursive:true});
  await page.screenshot({path:'tmp/workbench-validation/embedded-inline.png'});
  // Enter submits a dialog here too, although the sandbox blocks real form submission.
  await frame.getByRole('button',{name:'Add reference',exact:true}).click();
  await frame.getByLabel('Resource URI').fill('devmate://task/example');
  await frame.getByLabel('Resource URI').press('Enter');
  await until(()=>f.count('reference.add')===1,'the reference');
  await frame.locator('#reference-count').filter({hasText:'1'}).waitFor();
  // A refusal that needs a second decision keeps its error code across the host, and both questions are asked in the page.
  f.files.push({name:'assets',path:'assets',type:'directory'});
  await frame.getByRole('tab',{name:'Files',exact:true}).click();
  await frame.getByRole('button',{name:'▸ assets',exact:true}).click();
  f.failNext('workspace.delete','This directory holds 5000 files (900 MiB), more than DevMate keeps for undo.','too_large_to_keep');
  await frame.getByRole('button',{name:'Delete this folder'}).click();
  await frame.getByRole('alertdialog',{name:'Delete assets?'}).getByRole('button',{name:'Delete',exact:true}).click();
  await frame.getByRole('alertdialog',{name:'Delete without a way back?'}).getByRole('button',{name:'Delete for good',exact:true}).click();
  const deletions=()=>f.calls.filter(item=>item.operation==='workspace.delete').map(item=>[item.input.path,item.input.recursive,item.input.force]);
  await until(()=>deletions().length===2,'the deletion that was confirmed twice');
  assert.deepEqual(deletions(),[['assets',true,undefined],['assets',true,true]]);
  // A file with unsaved edits no longer traps navigation: the question is asked in the page.
  await frame.getByRole('button',{name:'note.md',exact:true}).click();
  const editor=frame.getByRole('textbox',{name:'File contents'});
  await editor.fill('unsaved inside the sandbox');
  await frame.locator('#project').selectOption('p-two');
  const question=frame.getByRole('alertdialog',{name:'Discard unsaved changes?'});
  await question.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await frame.locator('#project').inputValue(),'p-one');
  assert.equal(await editor.inputValue(),'unsaved inside the sandbox');
  await frame.locator('#project').selectOption('p-two');
  await question.getByRole('button',{name:'Discard changes',exact:true}).click();
  await until(()=>f.calls.some(item=>item.operation==='workbench.snapshot'&&item.input.projectId==='p-two'),'the other project');
  assert.equal(await frame.locator('#project').inputValue(),'p-two');
  // Removing a project is possible again.
  await frame.getByRole('tab',{name:'Overview',exact:true}).click();
  await frame.getByRole('button',{name:'Remove project',exact:true}).click();
  const removal=frame.getByRole('alertdialog',{name:'Remove Project Two?'});
  assert.equal((await inner.evaluate(()=>document.activeElement.textContent)),'Cancel','the safe answer has the focus');
  await removal.getByRole('button',{name:'Remove project',exact:true}).click();
  await until(()=>f.count('project.remove')===1,'the removal');
  assert.equal(f.calls.find(item=>item.operation==='project.remove').input.id,'p-two');
  await frame.getByRole('heading',{name:'Your projects, together'}).waitFor();
  // Without an event stream the page refreshes when it is looked at again, and on request, and says when it last did.
  const snapshots=()=>f.count('workbench.snapshot');let seen=snapshots();
  await inner.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await until(()=>snapshots()>seen,'a refresh when the page becomes visible');
  await delay(2100);seen=snapshots();
  await inner.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await until(()=>snapshots()>seen,'a refresh when the frame gets the focus');
  seen=snapshots();
  await frame.getByRole('button',{name:'Refresh',exact:true}).click();
  await until(()=>snapshots()>seen,'a manual refresh');
  assert.match(await frame.locator('#updated').textContent(),/^Updated \d/);
  assert.equal(server.streams.size,0,'an embedded app opens no event stream');
  assert.deepEqual(errors,[]);
});

test('the local page signs in per tab: the code leaves the address bar and the session travels in a header only',{skip,timeout:60000},async t=>{
  const f=fixture(),server=await serverFixture(f,{requireSession:true});t.after(server.close);
  const {page,errors}=await open(t,server);
  await selectScope(page);
  await until(()=>server.streams.size===1,'the event stream');
  assert.equal(new URL(page.url()).search,'','the single-use code does not stay in the address bar');
  const carried=()=>server.seen.filter(item=>item.url==='/api/call'||item.url==='/events');
  assert.ok(carried().length>1&&carried().every(item=>/^Bearer tab-/.test(item.authorization)&&item.cookie===undefined),JSON.stringify(carried().slice(0,3)));
  assert.equal(await page.evaluate(()=>document.cookie),'');
  // A reload keeps the tab signed in: the session lives in the tab, not in the link.
  await page.reload();await selectScope(page);
  await until(()=>server.streams.size===1,'the event stream after reloading');
  // Another tab of the same browser, opened without a link, is given nothing and told how to get in.
  const other=await page.context().newPage();await other.goto(server.url+'/');
  const told=other.getByRole('alert').filter({hasText:'This tab is not signed in to DevMate'});
  await told.waitFor();
  assert.match(await told.textContent(),/devmate ui/);assert.match(await told.textContent(),/工作台需要从本机入口打开/);
  assert.equal(await other.locator('#connection').textContent(),'Signed out');
  // A link that was used once signs nobody in a second time.
  const used=server.link(),first=await page.context().newPage(),second=await page.context().newPage();
  await first.goto(server.url+used);await first.getByRole('heading',{name:'Your projects, together'}).waitFor();
  await second.goto(server.url+used);await second.getByRole('alert').filter({hasText:'This tab is not signed in to DevMate'}).waitFor();
  assert.deepEqual(errors,[]);
});
test('finding 4: after a restart the page says so and offers Reload instead of failing silently',{skip,timeout:60000},async t=>{
  const f=fixture(),server=await serverFixture(f);t.after(server.close);
  const {page,errors}=await open(t,server);
  await selectScope(page);
  await until(()=>server.streams.size===1,'the event stream');
  // The runtime goes away and comes back with a new credential: the stream is refused, with no action by the person.
  server.signOut();
  const banner=page.getByRole('alert').filter({hasText:'DevMate was restarted or this page was signed out'});
  await banner.waitFor();
  // The way back is to open the workbench again; the page says so, and that what was typed is still there to copy.
  assert.match(await banner.textContent(),/Open the workbench again from your editor .* or by running “devmate ui”/);
  assert.match(await banner.textContent(),/What you typed is still here to copy/);
  const reload=page.getByRole('button',{name:'Reload anyway',exact:true});
  assert.equal(await reload.isVisible(),true);
  assert.equal(await page.locator('#connection').textContent(),'Signed out');
  assert.equal((await focused(page)).id,'session-reload');
  const refused=f.count('workbench.snapshot');
  await page.getByRole('button',{name:'Refresh',exact:true}).click();await delay(300);
  assert.equal(f.count('workbench.snapshot'),refused,'nothing is retried behind the banner');
  server.signIn();
  await reload.click();
  await page.getByRole('heading',{name:'Your projects, together'}).waitFor();
  assert.equal(await page.locator('#session').isVisible(),false);
  // The same when a call is the first thing to notice it, here from an open dialog.
  await until(()=>server.streams.size===1,'the event stream after reloading');
  await page.getByRole('button',{name:'Add project',exact:true}).first().click();
  await page.getByLabel('Name',{exact:true}).fill('Any');await page.getByLabel('Folder on this DevMate computer').fill('C:/any');
  server.signOut({dropStreams:false});
  await page.locator('#dialog').getByRole('button',{name:'Add project',exact:true}).click();
  await banner.waitFor();
  await dialogClosed(page);
  await until(async()=>(await focused(page)).id==='session-reload','the focus on Reload');
  assert.deepEqual(errors,[]);
});

test('finding 5: tabs, dialogs and errors are operable by keyboard and exposed to assistive technology',{skip,timeout:60000},async t=>{
  const f=fixture(),server=await serverFixture(f);t.after(server.close);
  const {page,errors}=await open(t,server);
  await selectScope(page);
  const tablist=page.getByRole('tablist',{name:'Workspace sections'});
  assert.deepEqual(await tablist.getByRole('tab').allTextContents(),['Overview','Approvals','Agents','Activity','Messages','Tasks','Files','Changes','Commands','Problems','Artifacts']);
  const tabState=()=>page.evaluate(()=>({selected:[...document.querySelectorAll('[role=tab][aria-selected=true]')].map(node=>node.textContent),
    reachable:[...document.querySelectorAll('[role=tab]')].filter(node=>node.tabIndex===0).map(node=>node.textContent),
    controls:[...new Set([...document.querySelectorAll('[role=tab]')].map(node=>node.getAttribute('aria-controls')))],
    panel:{role:document.getElementById('panel').getAttribute('role'),labelledby:document.getElementById('panel').getAttribute('aria-labelledby')}}));
  assert.deepEqual(await tabState(),{selected:['Overview'],reachable:['Overview'],controls:['panel'],panel:{role:'tabpanel',labelledby:'tab-overview'}});
  assert.equal(await page.getByRole('tabpanel',{name:'Overview'}).count(),1);
  // Arrow keys move through the tabs, Home and End jump, Enter opens the focused one.
  await page.getByRole('tab',{name:'Overview',exact:true}).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal((await focused(page)).text,'Approvals');
  assert.deepEqual((await tabState()).selected,['Overview'],'moving the focus does not load another view');
  const ring=await page.evaluate(()=>{const style=getComputedStyle(document.activeElement);return{style:style.outlineStyle,width:style.outlineWidth,visible:document.activeElement.matches(':focus-visible')};});
  assert.deepEqual(ring,{style:'solid',width:'3px',visible:true});
  await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowLeft');
  assert.equal((await focused(page)).text,'Artifacts');
  await page.keyboard.press('Home');assert.equal((await focused(page)).text,'Overview');
  await page.keyboard.press('End');assert.equal((await focused(page)).text,'Artifacts');
  await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');
  assert.equal((await focused(page)).text,'Tasks');
  await page.keyboard.press('Enter');
  await page.getByRole('heading',{name:'Tasks',exact:true}).waitFor();
  assert.deepEqual(await tabState(),{selected:['Tasks'],reachable:['Tasks'],controls:['panel'],panel:{role:'tabpanel',labelledby:'tab-tasks'}});
  assert.equal((await focused(page)).text,'Tasks','the focus stays on the tab that was opened');
  // A dialog has a name, takes the focus, closes on Escape and gives the focus back.
  await page.getByRole('button',{name:'Create task',exact:true}).focus();await page.keyboard.press('Enter');
  const dialog=page.getByRole('dialog',{name:'Create task'});
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('button',{name:'Close dialog'}).count(),1);
  assert.equal(await page.evaluate(()=>document.getElementById('dialog').contains(document.activeElement)),true);
  await page.keyboard.press('Escape');await dialogClosed(page);
  assert.equal((await focused(page)).text,'Create task');
  // A confirmation is an alertdialog with a name and a description.
  await page.getByRole('tab',{name:'Overview',exact:true}).click();
  await page.getByRole('button',{name:'Remove project',exact:true}).click();
  const confirm=page.getByRole('alertdialog',{name:'Remove Project One?'});
  await confirm.waitFor();
  assert.match(await page.evaluate(()=>document.getElementById(document.getElementById('confirm').getAttribute('aria-describedby')).textContent),/files on disk are not touched/);
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.getElementById('confirm').open);
  assert.equal(f.count('project.remove'),0);
  assert.equal((await focused(page)).text,'Remove project');
  // A failure is announced as an alert, a success as a status.
  f.failNext('project.update','The project changed; refresh before editing.','conflict');
  await page.getByLabel('Project name').fill('Renamed');
  await page.getByRole('button',{name:'Save settings',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'The project changed'}).waitFor();
  assert.equal(await page.getByRole('status').filter({hasText:'The project changed'}).count(),0);
  assert.equal(await page.getByLabel('Project name').inputValue(),'Renamed','the failed change keeps what was typed');
  await page.getByRole('button',{name:'Dismiss',exact:true}).click();
  assert.equal(await page.locator('#alert').isVisible(),false);
  await page.getByRole('button',{name:'Save settings',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Project settings saved.'}).waitFor();
  // Every form control has an accessible name in every view.
  for(const tab of await tablist.getByRole('tab').allTextContents()) {
    await page.getByRole('tab',{name:tab,exact:true}).click();
    await page.locator('#panel h2').first().waitFor();
    const unnamed=await page.evaluate(()=>[...document.querySelectorAll('#app input,#app select,#app textarea,#app button')]
      .filter(node=>!(node.labels?.length||node.getAttribute('aria-label')||node.textContent.trim())).map(node=>node.outerHTML.slice(0,80)));
    assert.deepEqual(unnamed,[],'unnamed controls in '+tab);
  }
  assert.deepEqual(errors,[]);
});

test('finding 7: lists page newest first, pending requests are always complete and one failing panel does not blank the others',{skip,timeout:60000},async t=>{
  const f=fixture(),server=await serverFixture(f);t.after(server.close);
  for(let i=1;i<=120;i++)f.tasks.push({id:'task-'+String(i).padStart(4,'0'),projectId:'p-one',title:'Task number '+i,instruction:'Do '+i,status:'completed',revision:1});
  for(let i=2;i<=231;i++)f.approvals.push({id:'approval-'+String(i).padStart(3,'0'),projectId:'p-one',agentId:'a-one',summary:'Request '+i,status:i%2?'resolved':'pending',revision:1,options:[{optionId:'ok',name:'Allow '+i}]});
  for(let i=2;i<=205;i++)f.inputs.push({id:'input-'+String(i).padStart(3,'0'),projectId:'p-one',status:'pending',prompt:'Question '+i,details:{questions:[{id:'q',question:'Answer '+i}]}});
  f.history.push({sequence:7,at:new Date().toISOString(),action:'written',path:'note.md',sha256:'b'.repeat(64),previousSha256:'a'.repeat(64),previousRestorable:true});
  const {page,errors}=await open(t,server);
  await selectScope(page);
  const last=operation=>f.calls.filter(item=>item.operation===operation).at(-1).input;
  // Tasks: newest first, one page at a time, and a refresh keeps the pages that were loaded.
  await page.getByRole('tab',{name:'Tasks',exact:true}).click();
  await page.getByRole('heading',{name:'Task number 120',exact:true}).waitFor();
  assert.equal(await page.locator('#panel .item').count(),50);
  assert.deepEqual([last('task.list').newestFirst,last('task.list').limit,last('task.list').cursor],[true,50,undefined]);
  await page.getByRole('button',{name:'Load more',exact:true}).click();
  await page.getByRole('heading',{name:'Task number 21',exact:true}).waitFor();
  assert.equal(await page.locator('#panel .item').count(),100);
  assert.deepEqual([last('task.list').newestFirst,last('task.list').cursor],[true,'task-0071']);
  await until(()=>server.streams.size===1,'the event stream');
  f.tasks.push({id:'task-0121',projectId:'p-one',title:'Task number 121',instruction:'Newest',status:'pending',revision:1});
  server.push({type:'task.created',projectId:'p-one'});
  await page.getByRole('heading',{name:'Task number 121',exact:true}).waitFor();
  assert.equal(await page.locator('#panel .item').count(),100,'the refresh asked again for as many rows as were on screen');
  assert.equal(await page.locator('#panel .item h3').first().textContent(),'Task number 121');
  assert.equal(last('task.list').limit,100);
  await page.getByRole('button',{name:'Load more',exact:true}).click();
  await page.getByRole('heading',{name:'Task number 1',exact:true}).waitFor();
  assert.equal(await page.locator('#panel .item').count(),121);
  assert.equal(await page.getByRole('button',{name:'Load more',exact:true}).count(),0);
  // Approvals: every pending approval and question is fetched, however many pages that takes, and shown before anything answered.
  await page.getByRole('tab',{name:'Approvals',exact:true}).click();
  await page.getByRole('heading',{name:'Question 205',exact:true}).waitFor();
  assert.equal(await page.locator('#panel .item.waiting').count(),116+205);
  const pendingCalls=f.calls.filter(item=>item.operation==='approval.list'&&item.input.status==='pending');
  assert(pendingCalls.length>=1&&pendingCalls.every(item=>item.input.newestFirst===true&&item.input.projectId==='p-one'&&item.input.workflowId===undefined));
  const inputCalls=f.calls.filter(item=>item.operation==='input.list'&&item.input.status==='pending');
  assert(inputCalls.some(item=>item.input.cursor),'the second page of pending questions was fetched');
  assert.equal(await page.evaluate(()=>{const panel=document.getElementById('panel'),waiting=[...panel.querySelectorAll('.item.waiting')],answered=panel.querySelector('section.panel');
    return waiting.every(node=>node.compareDocumentPosition(answered)&Node.DOCUMENT_POSITION_FOLLOWING);}),true,'pending requests come before answered ones');
  assert.equal(await page.locator('#panel .item.waiting h3').first().textContent(),'Request 230','newest pending request first');
  assert.equal(await page.locator('#panel .item.waiting .badge').evaluateAll(nodes=>nodes.every(node=>node.textContent==='pending')),true);
  // Changes: Git is unavailable, the DevMate history beside it still loads and can be used.
  f.failNext('git.status','The workspace command did not finish successfully. fatal: not a git repository','command_failed');
  await page.getByRole('tab',{name:'Changes',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'not a git repository'}).waitFor();
  await page.getByRole('button',{name:'Restore previous version of note.md'}).waitFor();
  assert.equal(await page.locator('#alert').isVisible(),false,'a panel reports its own failure in place');
  await page.getByRole('button',{name:'Try again',exact:true}).click();
  await page.getByText('The working tree is clean.').waitFor();
  assert.deepEqual(errors,[]);
});

test('late reads cannot change a newly selected project and in-flight saves preserve newer editor text',{skip,timeout:60000},async t=>{
  const f=fixture(),read=gate(f,'workspace.read'),server=await serverFixture(f);
  t.after(async()=>{read.release();await server.close();});
  const {page,errors}=await open(t,server);
  await page.getByRole('heading',{name:'Your projects, together'}).waitFor();
  await page.selectOption('#project','p-one');await page.getByRole('tab',{name:'Files',exact:true}).click();
  await page.getByRole('button',{name:'note.md',exact:true}).click();await read.started;
  await page.selectOption('#project','p-two');read.release();await page.waitForTimeout(100);
  assert.equal(await page.locator('#project').inputValue(),'p-two');
  assert.equal(await page.getByRole('textbox',{name:'File contents'}).count(),0);
  await page.selectOption('#project','p-one');await page.getByRole('button',{name:'note.md',exact:true}).click();
  const editor=page.getByRole('textbox',{name:'File contents'});await editor.fill('submitted version');
  const write=gate(f,'workspace.write');
  await page.getByRole('button',{name:'Save',exact:true}).click();await write.started;
  await editor.fill('newer unsaved version');write.release();
  await page.waitForFunction(()=>document.getElementById('notice').textContent==='Saved.');
  assert.equal(await editor.inputValue(),'newer unsaved version');
  await page.waitForFunction(()=>document.getElementById('file-status').textContent==='Unsaved changes');
  assert.equal(f.calls.find(x=>x.operation==='workspace.write').input.text,'submitted version');
  assert.deepEqual(errors,[]);
});

function realService(t,{git=false}={}) {
  const directory=mkdtempSync(path.join(os.tmpdir(),'devmate-workbench-')),root=path.join(directory,'project');
  mkdirSync(root);writeFileSync(path.join(root,'note.md'),'real initial text\n');
  if(git) {
    const run=(...args)=>spawnSync('git',['-c','user.name=DevMate Test','-c','user.email=test@devmate.invalid','-c','commit.gpgsign=false',...args],{cwd:root,windowsHide:true});
    run('init','-q');run('add','-A');run('commit','-q','-m','initial');
  }
  const service=new DevMateService({instanceRoot:path.join(directory,'instance'),endpoint:'http://127.0.0.1/isolated-agent',adapterFactory:()=>({
    capabilities:{resume:true,steer:false},start:async()=>({sessionId:'isolated-native',capabilities:{resume:true,steer:false}}),
    send:async({text})=>({status:'completed',text:'Received '+text}),close:async()=>{},cancel:async()=>({requested:false})
  })});
  const seen=[],f={call:async(operation,input)=>{seen.push({operation,input});return ownerCall(service,operation,input);}};
  t.after(async()=>{await service.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,root,service,seen,f};
}

test('browser controls use the real new service, strict schemas and isolated SQLite/project state',{skip,timeout:90000},async t=>{
  const {root,service,seen,f}=realService(t);
  const project=await ownerCall(service,'project.create',{root,name:'Real service project'});
  const workflow=await ownerCall(service,'workflow.create',{projectId:project.id,title:'Real service workflow'});
  const agent=await ownerCall(service,'agents.start',{projectId:project.id,workflowId:workflow.id,provider:'codex',title:'Isolated provider'});
  await until(()=>service.store.get('agent',agent.id).status==='ready','the agent session');
  const server=await serverFixture(f);t.after(server.close);
  service.store.on('event',event=>server.push(event));
  const {page,errors}=await open(t,server,{viewport:{width:1380,height:1000}});
  await page.getByRole('heading',{name:'Your projects, together'}).waitFor();
  await page.selectOption('#project',project.id);await page.selectOption('#workflow',workflow.id);
  await page.getByLabel('Project name').fill('Renamed project');
  await page.getByRole('button',{name:'Save settings',exact:true}).click();
  await until(()=>service.store.get('project',project.id).name==='Renamed project','the project name');
  await page.getByRole('button',{name:'Edit workflow',exact:true}).click();
  await page.getByLabel('Agent turn budget',{exact:true}).fill('75');
  await page.locator('#dialog').getByRole('button',{name:'Save',exact:true}).click();await dialogClosed(page);
  assert.equal(service.store.get('workflow',workflow.id).turnBudget,75);
  await page.getByRole('tab',{name:'Tasks',exact:true}).click();await page.getByRole('button',{name:'Create task',exact:true}).click();
  await page.getByLabel('Title',{exact:true}).fill('First task');await page.getByLabel('Instruction',{exact:true}).fill('Inspect this isolated project');
  await page.locator('#dialog').getByRole('button',{name:'Create',exact:true}).click();await dialogClosed(page);
  await page.getByRole('button',{name:'Edit',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('Edited task');
  await page.locator('#dialog').getByRole('button',{name:'Save',exact:true}).click();await dialogClosed(page);
  assert.equal(service.store.list('task',{workflowId:workflow.id})[0].title,'Edited task');
  await page.getByRole('tab',{name:'Files',exact:true}).click();await page.getByRole('button',{name:'note.md',exact:true}).click();
  await page.getByRole('textbox',{name:'File contents'}).fill('saved through the actual service');
  await page.getByRole('button',{name:'Save',exact:true}).click();await page.waitForFunction(()=>document.getElementById('file-status')?.textContent==='Saved');
  assert.equal(readFileSync(path.join(root,'note.md'),'utf8'),'saved through the actual service');
  await page.getByRole('tab',{name:'Artifacts',exact:true}).click();await page.getByRole('button',{name:'Create artifact',exact:true}).click();
  await page.getByLabel('Name',{exact:true}).fill('Verified file');await page.getByLabel('Existing project file path').fill('note.md');
  await page.locator('#dialog').getByRole('button',{name:'Register',exact:true}).click();await dialogClosed(page);
  assert.equal(service.store.list('artifact',{workflowId:workflow.id}).length,1);
  await page.getByRole('button',{name:'Reference',exact:true}).click();await page.waitForFunction(()=>document.getElementById('reference-count').textContent==='1');
  assert.equal(service.store.list('reference',{workflowId:workflow.id}).length,1);
  await page.getByRole('tab',{name:'Agents',exact:true}).click();await page.getByRole('button',{name:'Send',exact:true}).click();
  await page.getByLabel('Message',{exact:true}).fill('real delivery');
  await page.locator('#dialog').getByRole('button',{name:'Send',exact:true}).click();
  await dialogClosed(page);
  assert(seen.some(x=>x.operation==='agents.send'&&x.input.body==='real delivery'&&!Object.hasOwn(x.input,'prompt')));
  assert(service.store.list('message',{workflowId:workflow.id}).some(x=>x.body==='real delivery'));
  assert.equal(service.store.get('agent',agent.id).nativeSessionId,'isolated-native');
  // Every list the page asked for was accepted by the strict schemas, newest first where recency matters.
  for(const operation of ['task.list','message.list','artifact.list','agents.list'])
    assert(seen.filter(x=>x.operation===operation).every(x=>x.operation==='agents.list'&&!x.input.newestFirst?x.input.limit===200:x.input.newestFirst===true),operation+' is asked newest first');
  assert.deepEqual(errors,[]);
  await page.setViewportSize({width:390,height:844});
  mkdirSync('tmp/workbench-validation',{recursive:true});await page.screenshot({path:'tmp/workbench-validation/mobile-real-service.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true,'no horizontal scrolling on a phone-sized screen');
});

test('finding 6: commands, changes, files, problems, delegation, activity, connection and project settings against the real service',{skip,timeout:180000},async t=>{
  const git=hasTool('git'),ripgrep=hasTool('rg');
  const {root,service,seen,f}=realService(t,{git});
  writeFileSync(path.join(root,'big.txt'),Array.from({length:3000},(_,i)=>'line '+(i+1)+' '+'x'.repeat(110)).join('\n')+'\n');
  const project=await ownerCall(service,'project.create',{root,name:'Supervised project'});
  const workflow=await ownerCall(service,'workflow.create',{projectId:project.id,title:'Supervised workflow'});
  const agent=await ownerCall(service,'agents.start',{projectId:project.id,workflowId:workflow.id,provider:'codex',title:'Isolated provider'});
  await until(()=>service.store.get('agent',agent.id).status==='ready','the agent session');
  const windowId=randomUUID();
  await ownerCall(service,'window.attach',{windowId,title:'Test editor',roots:[{root:project.root,name:'project'}]});
  await ownerCall(service,'window.context',{windowId,context:{diagnostics:[
    {file:path.join(project.root,'note.md'),severity:'error',line:0,character:4,message:'Unexpected token in the note',source:'ts',code:'1005'},
    {file:path.join(project.root,'note.md'),severity:'warning',line:2,character:0,message:'Line is too long',source:'lint'}]}});
  const server=await serverFixture(f);t.after(server.close);
  service.store.on('event',event=>server.push(event));
  const {page,errors}=await open(t,server,{viewport:{width:1380,height:1000}});
  await page.getByRole('heading',{name:'Your projects, together'}).waitFor();
  await page.selectOption('#project',project.id);await page.selectOption('#workflow',workflow.id);
  const tab=name=>page.getByRole('tab',{name:new RegExp('^'+name)}).click();
  const confirm=(title,action)=>page.getByRole('alertdialog',{name:title}).getByRole('button',{name:action,exact:true}).click();
  const disk=file=>path.join(root,file);

  // Overview: connection state, the doctor (local only), problem counts.
  const connection=page.locator('section.panel').filter({has:page.getByRole('heading',{name:'Connection',exact:true})});
  await connection.getByText('Only apps on this computer can connect').waitFor();
  assert.match(await connection.locator('dl').textContent(),/Kind\s*local/);
  await connection.getByRole('button',{name:'Run doctor',exact:true}).click();
  await connection.getByRole('heading',{name:/^Doctor:/}).waitFor({timeout:30000});
  const checks=await connection.locator('.entry strong').allTextContents();
  assert(checks.includes('node')&&checks.includes('git')&&checks.includes('connection'),'the doctor lists its checks: '+checks.join(', '));
  if(!ripgrep)await connection.getByText('What to do: Install ripgrep').waitFor();
  const errorsCard=page.getByRole('button',{name:/^Editor errors/});
  await errorsCard.filter({hasText:'1 warning'}).waitFor();
  assert.match(await errorsCard.textContent(),/Editor errors1/);

  // Problems: what the editor reports, with counts, and a way into the file.
  await tab('Problems');
  await page.getByText('Unexpected token in the note').waitFor();
  assert.deepEqual(await page.locator('#panel .actions .badge').allTextContents(),['1 error','1 warning','0 info','0 hints']);
  assert.equal(await page.locator('#panel .item').count(),2);
  await page.getByRole('combobox',{name:'Show',exact:true}).selectOption('error');
  await page.waitForFunction(()=>document.querySelectorAll('#panel .item').length===1);
  await page.getByRole('button',{name:'Open note.md'}).click();
  await page.getByRole('textbox',{name:'File contents'}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'File contents'}).inputValue(),'real initial text\n');

  // Files: folder, file, rename, find, delete; a file too large to edit is read only and paged.
  await page.getByRole('button',{name:'New folder',exact:true}).click();
  await page.getByLabel('Folder path in the project').fill('docs');await page.getByLabel('Folder path in the project').press('Enter');await dialogClosed(page);
  await page.getByRole('button',{name:'▸ docs',exact:true}).click();
  await page.getByText('In docs',{exact:true}).waitFor();
  await page.getByRole('button',{name:'New file',exact:true}).click();
  assert.equal(await page.getByLabel('File path in the project').inputValue(),'docs/');
  await page.getByLabel('File path in the project').fill('docs/guide.md');
  await page.locator('#dialog').getByRole('button',{name:'Create draft',exact:true}).click();await dialogClosed(page);
  await page.getByRole('textbox',{name:'File contents'}).fill('# Guide\n');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('file-status')?.textContent==='Saved');
  assert.equal(readFileSync(disk('docs/guide.md'),'utf8'),'# Guide\n');
  await page.getByRole('button',{name:'Rename or move',exact:true}).click();
  await page.getByLabel('New path in the project').fill('docs/manual.md');await page.getByLabel('New path in the project').press('Enter');await dialogClosed(page);
  await until(()=>existsSync(disk('docs/manual.md'))&&!existsSync(disk('docs/guide.md')),'the move');
  await page.getByRole('heading',{name:'docs/manual.md',exact:true}).waitFor();
  if(ripgrep) {
    await page.getByRole('textbox',{name:'Search text or file pattern'}).fill('*.md');
    await page.getByRole('button',{name:'Find files',exact:true}).click();
    await page.locator('.hit').getByRole('button',{name:'docs/manual.md',exact:true}).waitFor();
    await page.getByRole('textbox',{name:'Search text or file pattern'}).fill('Guide');
    await page.getByRole('textbox',{name:'Search text or file pattern'}).press('Enter');
    await page.locator('.hit').getByRole('button',{name:'docs/manual.md:1',exact:true}).waitFor();
    await page.getByRole('button',{name:'Clear results',exact:true}).click();
  }
  await page.getByRole('button',{name:'Delete',exact:true}).last().click();
  await confirm('Delete docs/manual.md?','Delete');
  await until(()=>!existsSync(disk('docs/manual.md')),'the deletion');
  await page.getByRole('button',{name:'Up',exact:true}).click();
  await page.getByRole('button',{name:'big.txt',exact:true}).click();
  await page.getByText('Showing lines 1–2000 of 3000. This file is too large to edit here, so it is shown read only.').waitFor();
  assert.equal(await page.getByRole('textbox',{name:'File contents'}).count(),0,'no editor is offered for a partial file');
  assert.equal(await page.getByRole('button',{name:'Save',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Previous lines',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Next lines',exact:true}).click();
  await page.getByText('Showing lines 2001–3000 of 3000.').waitFor();
  assert.match(await page.locator('pre.file-view').textContent(),/^line 2001 x+\n[\s\S]*line 3000 x+$/);
  assert.equal(await page.getByRole('button',{name:'Next lines',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Previous lines',exact:true}).click();
  await page.getByText('Showing lines 1–2000 of 3000.').waitFor();
  // Per-file history with one-click restore.
  await page.getByRole('button',{name:'note.md',exact:true}).click();
  const editor=page.getByRole('textbox',{name:'File contents'});
  await editor.fill('second version\n');await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('file-status')?.textContent==='Saved');
  await page.getByRole('button',{name:'History',exact:true}).click();
  await page.getByRole('button',{name:'Restore previous version of note.md'}).click();
  await until(()=>readFileSync(disk('note.md'),'utf8')==='real initial text\n','the restore');
  await page.waitForFunction(()=>document.querySelector('textarea.file-editor').value==='real initial text\n');
  // An open file without unsaved edits follows the disk when something else changes it through DevMate.
  await ownerCall(service,'workspace.edit',{projectId:project.id,path:'note.md',edits:[{oldText:'initial',newText:'agent-edited'}]});
  await page.waitForFunction(()=>document.querySelector('textarea.file-editor').value==='real agent-edited text\n');

  // Changes: Git status and diff, and what DevMate changed with one-click restore.
  await tab('Changes');
  const devmate=page.locator('section.panel').filter({has:page.getByRole('heading',{name:'Changed through DevMate',exact:true})});
  await devmate.getByText('docs/manual.md · removed').waitFor();
  if(git) {
    await page.locator('.hit').filter({hasText:'modified'}).getByRole('button',{name:'Show diff of note.md'}).click();
    await page.getByRole('heading',{name:'Diff of note.md',exact:true}).waitFor();
    await page.waitForFunction(()=>/\+real agent-edited text/.test(document.querySelector('pre.diff')?.textContent||''));
    assert.match(await page.locator('pre.diff').textContent(),/-real initial text/);
    assert.equal(await page.locator('.hit').filter({hasText:'new, not tracked'}).getByRole('button',{name:'Show diff of big.txt'}).count(),1);
  } else await page.getByRole('alert').filter({hasText:'Git status is not available'}).waitFor();
  await devmate.getByRole('button',{name:'Restore previous version of docs/manual.md'}).click();
  await until(()=>existsSync(disk('docs/manual.md'))&&readFileSync(disk('docs/manual.md'),'utf8')==='# Guide\n','the deleted file to come back');

  // Commands: run, read the output, see it listed, stop a running one, page through output.
  await tab('Commands');
  const command=page.getByLabel('Command',{exact:true});
  await command.fill('node -e "console.log(\'workbench-command-ok\')"');await command.press('Enter');
  await page.waitForFunction(()=>/workbench-command-ok/.test(document.getElementById('command-output')?.textContent||''),null,{timeout:30000});
  assert.equal(await command.inputValue(),'','the command line is cleared after it was sent');
  await page.locator('#panel .item').filter({hasText:'workbench-command-ok'}).getByText('exited 0').waitFor({timeout:30000});
  await command.fill('node -e "console.log(\'a\'.repeat(200000));setInterval(()=>{},1000)"');await command.press('Enter');
  const running=page.locator('#panel .item').filter({hasText:'setInterval'});
  await running.getByText('running',{exact:true}).waitFor({timeout:30000});
  await page.waitForFunction(()=>/of 20000\d bytes/.test(document.getElementById('panel').textContent),null,{timeout:30000});
  await page.getByRole('button',{name:'Earlier',exact:true}).click();
  await page.waitForFunction(()=>/^Showing \d+ to \d+ of 20000\d bytes$/.test([...document.querySelectorAll('#panel .caption')].find(node=>node.textContent.startsWith('Showing'))?.textContent||''));
  assert(seen.some(x=>x.operation==='process.read'&&Number.isInteger(x.input.cursor)),'earlier output is read by cursor');
  await page.getByRole('button',{name:'Newest',exact:true}).click();
  await page.getByText('following the newest output').waitFor();
  await running.getByRole('button',{name:'Stop',exact:true}).click();
  await running.getByText('stopped',{exact:true}).waitFor({timeout:30000});
  assert.equal(await running.getByRole('button',{name:'Stop',exact:true}).isDisabled(),true);

  // Delegate: hand a task to an agent in one step and read its result.
  await tab('Agents');
  await page.getByLabel('Who should do it').selectOption('agent:'+agent.id);
  await page.getByLabel('Task',{exact:true}).fill('Summarise the project');
  await page.getByRole('button',{name:'Delegate',exact:true}).click();
  const result=page.locator('section.panel').filter({has:page.getByRole('heading',{name:'Result of Isolated provider',exact:true})});
  await result.getByText('Received Summarise the project').waitFor({timeout:30000});
  assert.equal(seen.find(x=>x.operation==='agents.delegate').input.agentId,agent.id);
  assert.equal(await page.getByLabel('Task',{exact:true}).inputValue(),'');

  // Activity: the agent's turns, their output and the journal of what happened.
  await page.getByRole('button',{name:'Transcript',exact:true}).click();
  await page.getByRole('heading',{name:'Activity',exact:true}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'Agent',exact:true}).inputValue(),agent.id);
  await page.locator('section.panel').filter({has:page.getByRole('heading',{name:'Latest result of Isolated provider'})}).getByText('Received Summarise the project').waitFor();
  const turn=page.locator('#panel .item').filter({hasText:'Turn of Isolated provider'}).first();
  await turn.getByRole('button',{name:'Show output',exact:true}).click();
  await turn.locator('pre').filter({hasText:'Received Summarise the project'}).waitFor();
  assert(seen.some(x=>x.operation==='job.read'));
  await page.getByRole('region',{name:'Events, oldest first'}).getByText(/job updated/).first().waitFor();
  assert(seen.some(x=>x.operation==='event.list'&&x.input.projectId===project.id));

  // Project settings: credential-file protection and access, each explained and confirmed.
  await tab('Overview');
  await page.getByText('do not appear in the file list or in search').waitFor();
  await page.getByLabel('Protect credential files').uncheck();
  await page.getByRole('button',{name:'Save settings',exact:true}).click();
  await confirm('Stop protecting credential files?','Stop protecting');
  await until(()=>service.store.get('project',project.id).protectSecrets===false,'protection to be switched off');
  await page.getByRole('status').filter({hasText:'Project settings saved.'}).waitFor();
  await ownerCall(service,'agents.stop',{id:agent.id});
  await page.getByLabel('What assistants and agents may do').selectOption('read');
  await page.getByRole('button',{name:'Save settings',exact:true}).click();
  await confirm('Make this project read only?','Make read only');
  await until(()=>service.store.get('project',project.id).access==='read','read-only access',30000);
  await tab('Commands');
  await page.getByText('This project is read only, so commands cannot be run in it.').waitFor();
  assert.equal(await page.getByRole('button',{name:'Run',exact:true}).isDisabled(),true);
  await tab('Files');
  await page.waitForFunction(()=>[...document.querySelectorAll('#panel button')].find(node=>node.textContent==='New file')?.disabled===true);
  assert.deepEqual(errors,[]);
  mkdirSync('tmp/workbench-validation',{recursive:true});
  for(const name of ['Overview','Changes','Commands','Activity']){await tab(name);await page.locator('#panel h2').first().waitFor();await delay(400);await page.screenshot({path:'tmp/workbench-validation/view-'+name.toLowerCase()+'.png',fullPage:true});}
});
});
