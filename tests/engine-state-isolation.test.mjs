import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createEngineState } from '../runtime/engine-state.mjs';
import { startPreview, shutdownPreviews, getPreview, stopPreview } from '../runtime/engines/preview-manager.mjs';
import { startBrowserControl, shutdownBrowserControl, browserControlSessions, listBrowserTabs } from '../runtime/engines/browser-control-runtime.mjs';
import { reverseSettingsSchema } from '../runtime/engines/reverse.mjs';
import { runNative, stopNativeHelpers } from '../runtime/engines/reverse-native.mjs';
import { stopReverseEngines, __test as engines } from '../runtime/engines/reverse-engines.mjs';
import { findExecutable } from '../runtime/engines/engine-io.mjs';
import { runBrowserScenario } from '../runtime/engines/browser-runner.mjs';

const chrome=[
  process.env.DEVMATE_TEST_BROWSER,
  path.join(process.env.PROGRAMFILES||'C:/Program Files','Google/Chrome/Application/chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe')
].filter(Boolean).find(file=>fs.existsSync(file));
const browserSettings={playwrightModulePath:'node_modules/playwright-core/index.mjs',chromiumExecutablePath:chrome,defaultHeadless:true};
const python=findExecutable(['python','python3']);
function reverseContext() {
  return {state:createEngineState('devmate.reverse'),settings:reverseSettingsSchema.parse({pythonPath:python||''}),
    assertActive(){},assertCanMutate(){},caller:()=> 'owner',assertOwner(){},audit:async()=>{},
    executables:{find:()=>python,assertAllowed(){}}};
}
async function waitFor(predicate,timeout=10000) {
  const until=Date.now()+timeout;
  while(!predicate()){if(Date.now()>until)throw new Error('Fixture condition timed out');await new Promise(resolve=>setTimeout(resolve,10));}
}
test('factories give every project/engine independent state and explicit private profile roots',()=>{
  const a=createEngineState('devmate.browser-control','C:/instance-a/browser'),b=createEngineState('devmate.browser-control','C:/instance-b/browser');
  assert.notEqual(a.sessions,b.sessions);assert.notEqual(a.persistentProfileOwners,b.persistentProfileOwners);assert.notEqual(a.stateRoot,b.stateRoot);
  const ra=reverseContext(),rb=reverseContext(),workspace={id:'same',root:os.tmpdir()};
  const session=ra.state.sessions.create(workspace,{pid:12345});
  assert.throws(()=>rb.state.sessions.get(workspace,session.id),/missing/);
  ra.state.sessions.clear();assert.equal(rb.state.sessions.generation,0);
});
test('two real preview servers are isolated even with the same workspace id',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'devmate-preview-isolation-'));
  await fsp.writeFile(path.join(root,'index.html'),'<title>isolated</title>');
  const a=createEngineState('devmate.browser-qa'),b=createEngineState('devmate.browser-qa');
  t.after(async()=>{await Promise.all([shutdownPreviews(a.previews),shutdownPreviews(b.previews)]);await fsp.rm(root,{recursive:true,force:true});});
  const pa=await startPreview(a.previews,{workspaceId:'same',root}),pb=await startPreview(b.previews,{workspaceId:'same',root});
  assert.throws(()=>getPreview(a.previews,pb.id),/not found/);
  assert.equal((await stopPreview(a.previews,pb.id)).stopped,false);
  await shutdownPreviews(a.previews);
  await assert.rejects(fetch(pa.url));assert.equal((await fetch(pb.url)).status,200);
  await assert.rejects(startPreview(a.previews,{workspaceId:'same',root}),/shutting down/);
});
test('real owned Chromium profiles survive closing a different engine instance',{skip:!chrome?'No installed Chromium':false,timeout:30000},async t=>{
  const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'devmate-browser-isolation-'));
  const a=createEngineState('devmate.browser-control',path.join(directory,'a')),b=createEngineState('devmate.browser-control',path.join(directory,'b'));
  t.after(async()=>{await Promise.all([shutdownBrowserControl(a),shutdownBrowserControl(b)]);await fsp.rm(directory,{recursive:true,force:true});});
  const options={workspaceId:'same',workspaceRoot:process.cwd(),settings:browserSettings,headless:true,profileMode:'workspace'};
  const one=await startBrowserControl(a,options),two=await startBrowserControl(b,options);
  assert.equal(a.persistentProfileOwners.size,1);assert.equal(b.persistentProfileOwners.size,1);
  await assert.rejects(listBrowserTabs(a,{workspaceId:'same',sessionId:two.session.id}),/Unknown/);
  const surviving=b.sessions.get(two.session.id).browser;
  await shutdownBrowserControl(a);
  assert.equal(a.resources.size,0);assert.equal(a.persistentProfileOwners.size,0);
  assert.equal(surviving.isConnected(),true);assert.equal((await browserControlSessions(b)).length,1);
  assert.equal((await listBrowserTabs(b,{workspaceId:'same',sessionId:two.session.id})).tabs.length,1);
  await assert.rejects(startBrowserControl(a,options),/closed/);
  assert.notEqual(one.session.id,two.session.id);
});
test('Browser QA cancellation closes only that run while a peer run completes',{skip:!chrome?'No installed Chromium':false,timeout:30000},async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'devmate-qa-isolation-'));
  await fsp.writeFile(path.join(root,'index.html'),'<title>QA isolation</title><p>ready</p>');
  const previewState=createEngineState('devmate.browser-qa').previews;
  const preview=await startPreview(previewState,{workspaceId:'same',root});
  const state=createEngineState('devmate.browser-qa'),a=new AbortController(),b=new AbortController();
  t.after(async()=>{state.abort.abort();await Promise.all([...state.browsers].map(browser=>browser.close()));await shutdownPreviews(previewState);await fsp.rm(root,{recursive:true,force:true});});
  const options={workspaceRoot:process.cwd(),url:preview.url,settings:browserSettings,actions:[{type:'wait',ms:500}]};
  const settled=Promise.allSettled([runBrowserScenario(state,{...options,signal:a.signal}),runBrowserScenario(state,{...options,signal:b.signal})]);
  await waitFor(()=>state.browsers.size===2);a.abort(new Error('Cancel only first run'));
  const results=await settled;
  assert.equal(results[1].status,'fulfilled');assert.equal(results[1].value.ok,true);
  assert.equal(state.browsers.size,0);assert.equal(state.abort.signal.aborted,false);assert.equal(b.signal.aborted,false);
});
test('native helper capacity and shutdown belong to one instance, with real Python in the other',{skip:!python?'Python not installed':false,timeout:30000},async()=>{
  const a=reverseContext(),b=reverseContext();let release;const gate=new Promise(resolve=>{release=resolve;});a.audit=()=>gate;
  const first=runNative(a,'status'),second=runNative(a,'status'),pending=Promise.allSettled([first,second]);
  await assert.rejects(runNative(a,'status'),/capacity/);
  const result=await runNative(b,'status');assert.equal(typeof result.pythonVersion,'string');
  const stopping=stopNativeHelpers(a.state.native);release();await stopping;
  assert((await pending).every(result=>result.status==='rejected'));
  assert.equal(a.state.native.children.size,0);
  assert.equal((await runNative(b,'status')).platform,result.platform);
  await stopNativeHelpers(b.state.native);
});
test('external engine shutdown confirms its own child exit without stopping a peer child',{timeout:30000},async t=>{
  const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'devmate-engine-process-isolation-'));
  const a=reverseContext(),b=reverseContext(),pa=path.join(directory,'a.pid'),pb=path.join(directory,'b.pid');
  t.after(async()=>{await Promise.all([stopReverseEngines(a.state.engines),stopReverseEngines(b.state.engines)]);await fsp.rm(directory,{recursive:true,force:true});});
  const launch=(context,file)=>engines.engineTask(context,'owned-fixture',({run})=>run(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setTimeout(()=>process.stdout.write('completed'),1200)",file],10000));
  const first=launch(a,pa),second=launch(b,pb),settled=Promise.allSettled([first,second]);
  await waitFor(()=>fs.existsSync(pa)&&fs.existsSync(pb));
  const pidA=Number(fs.readFileSync(pa,'utf8')),pidB=Number(fs.readFileSync(pb,'utf8'));
  await stopReverseEngines(a.state.engines);
  assert.throws(()=>process.kill(pidA,0),error=>error.code==='ESRCH');
  assert.doesNotThrow(()=>process.kill(pidB,0));
  const results=await settled;assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');
  assert.equal(results[1].value.stdout,'completed');assert.equal(a.state.engines.active.size,0);assert.equal(b.state.engines.active.size,0);
});
