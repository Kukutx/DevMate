import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-browser-harness-'));
process.env.DEVMATE_CONFIG = path.join(root, 'devmate-config.json');
await fsp.writeFile(process.env.DEVMATE_CONFIG, '{}\n', 'utf8');
await fsp.writeFile(path.join(root, 'package.json'), '{"type":"module"}', 'utf8');
await fsp.writeFile(path.join(root, 'upload.txt'), 'upload fixture', 'utf8');
const modulePath = path.join(root, 'fake-playwright.mjs');
await fsp.writeFile(modulePath, `
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
class FakeDownload { suggestedFilename(){ return 'report.txt'; } async saveAs(target){ await fsp.writeFile(target, 'downloaded'); } }
class FakeLocator {
  constructor(selector, context){ this.selector=selector; this.context=context; }
  async click(){} async dblclick(){} async fill(){} async press(){} async focus(){} async hover(){}
  async scrollIntoViewIfNeeded(){} async selectOption(values){ return values; }
  async check(){} async uncheck(){} async waitFor(){} async dragTo(target){ this.context.lastDrag=[this.selector,target.selector]; }
  async setInputFiles(paths){ this.context.lastUpload=paths; }
  async boundingBox(){ return { x:10, y:10, width:100, height:30 }; }
  async ariaSnapshot(){ return '- button "Fake action"'; }
}
class FakePage extends EventEmitter {
  constructor(context){
    super(); this.context=context; this.currentUrl='about:blank'; this.closed=false;
    this.keyboard={ press:async()=>{} };
    this.mouse={ click:async()=>{}, dblclick:async()=>{}, wheel:async()=>{}, move:async()=>{}, down:async()=>{}, up:async()=>{} };
  }
  url(){ return this.currentUrl; }
  async title(){ return 'Harness Browser'; }
  async goto(url){ this.currentUrl=String(url); return { status:()=>200 }; }
  async goBack(){ return { status:()=>200 }; } async goForward(){ return { status:()=>200 }; } async reload(){ return { status:()=>200 }; }
  async waitForTimeout(){}
  locator(selector){ return new FakeLocator(selector, this.context); }
  getByRole(role){ return new FakeLocator('role:'+role, this.context); }
  getByText(text){ return new FakeLocator('text:'+text, this.context); }
  async bringToFront(){}
  frames(){ return [{ name:()=>'', url:()=>this.currentUrl }]; }
  isClosed(){ return this.closed; }
  async waitForEvent(name){ if(name!=='download') throw new Error('unexpected event'); return new FakeDownload(); }
  async screenshot(options={}){ if(options.path){ await fsp.writeFile(options.path, 'artifact-image'); return; } return Buffer.from('inline-image'); }
  async evaluate(){ return { title:'Harness Browser', readyState:'complete', bodyText:'Harness body', elements:[
    { ref:'e1', selector:'#action', tag:'button', role:'button', name:'Action', text:'Action', href:null, type:null, disabled:false, checked:null, box:{x:10,y:10,width:100,height:30} },
    { ref:'e2', selector:'#file', tag:'input', role:'textbox', name:'File', text:'', href:null, type:'file', disabled:false, checked:null, box:{x:10,y:50,width:100,height:30} }
  ]}; }
  async close(){ if(this.closed) return; this.closed=true; this.emit('close'); }
}
class FakeContext extends EventEmitter {
  constructor(browser, options={}){ super(); this._browser=browser; this.options=options; this.items=[]; this.lastUpload=null; this.lastDrag=null; this.websocketRoute=null; }
  browser(){ return this._browser; } pages(){ return this.items.filter(page=>!page.closed); }
  async route(){}
  async routeWebSocket(pattern, handler){ this.websocketRoute={pattern,handler}; }
  async newPage(){ const page=new FakePage(this); this.items.push(page); this.emit('page',page); return page; }
  async close(){ for(const page of [...this.items]) await page.close(); this.emit('close'); }
}
class FakeBrowser extends EventEmitter {
  constructor(){ super(); this.connected=true; this.context=null; }
  isConnected(){ return this.connected; }
  async newContext(options={}){ this.context=new FakeContext(this, options); return this.context; }
  async close(){ if(!this.connected) return; this.connected=false; if(this.context) await this.context.close(); this.emit('disconnected'); }
}
export const chromium = {
  async launch(){ return new FakeBrowser(); },
  async launchPersistentContext(_directory, options={}){ const browser=new FakeBrowser(); const context=new FakeContext(browser, options); browser.context=context; await new Promise(resolve=>setTimeout(resolve,5)); return context; }
};
`, 'utf8');

const runtime = await import('../gateway/plugins/browser-control-runtime.mjs');
const settings = { playwrightModulePath: 'fake-playwright.mjs', allowRemoteUrls: false, defaultHeadless: false };

test.after(async () => {
  await runtime.shutdownBrowserControl();
  await fsp.rm(root, { recursive: true, force: true });
});

test('combines semantic and visual snapshots and coordinates human takeover', async () => {
  const started = await runtime.startBrowserControl({ workspaceId: 'workspace-harness', workspaceRoot: root, settings, headless: false });
  const sessionId = started.session.id;
  const snapshot = await runtime.snapshotBrowserControl({ workspaceId: 'workspace-harness', sessionId, includeScreenshot: true });
  assert.equal(snapshot.screenshot.mimeType, 'image/png');
  assert.equal(Buffer.from(snapshot.screenshot.data, 'base64').toString(), 'inline-image');

  const takeover = await runtime.takeoverBrowserControl({ workspaceId: 'workspace-harness', sessionId });
  assert.equal(takeover.session.controlMode, 'human');
  await assert.rejects(() => runtime.actBrowserControl({ workspaceId: 'workspace-harness', sessionId, action: { type: 'click', selector: '#action' } }), /human takeover/);

  const resumed = await runtime.resumeBrowserControl({ workspaceId: 'workspace-harness', sessionId });
  assert.equal(resumed.session.controlMode, 'agent');
  const fresh = await runtime.snapshotBrowserControl({ workspaceId: 'workspace-harness', sessionId });
  assert.notEqual(fresh.snapshotId, snapshot.snapshotId);
  const acted = await runtime.actBrowserControl({ workspaceId: 'workspace-harness', sessionId, action: { type: 'double_click', selector: '#action' } });
  assert.equal(acted.result.type, 'double_click');
  await runtime.stopBrowserControl({ workspaceId: 'workspace-harness', sessionId });
});

test('supports workspace-safe upload, download capture, drag, and persistent profiles without exposing profile paths', async () => {
  const started = await runtime.startBrowserControl({ workspaceId: 'workspace-files', workspaceRoot: root, settings, headless: true, profileMode: 'workspace' });
  const sessionId = started.session.id;
  assert.equal(started.session.profileMode, 'workspace');
  assert.equal(Object.hasOwn(started.session, 'profileKey'), false);
  await assert.rejects(() => runtime.startBrowserControl({ workspaceId: 'workspace-files', workspaceRoot: root, settings, headless: true, profileMode: 'workspace' }), /already owns/);

  const upload = await runtime.actBrowserControl({ workspaceId: 'workspace-files', sessionId, action: { type: 'upload', selector: '#file', paths: ['upload.txt'] } });
  assert.deepEqual(upload.result.paths, ['upload.txt']);
  await assert.rejects(() => runtime.actBrowserControl({ workspaceId: 'workspace-files', sessionId, action: { type: 'upload', selector: '#file', paths: ['../outside.txt'] } }), /escapes workspace root/);

  const drag = await runtime.actBrowserControl({ workspaceId: 'workspace-files', sessionId, action: { type: 'drag', selector: '#source', targetSelector: '#target' } });
  assert.equal(drag.result.type, 'drag');

  const download = await runtime.actBrowserControl({ workspaceId: 'workspace-files', sessionId, action: { type: 'download', selector: '#download', path: 'artifacts/browser-control/report.txt' } });
  assert.equal(download.result.path, 'artifacts/browser-control/report.txt');
  assert.equal(await fsp.readFile(path.join(root, 'artifacts/browser-control/report.txt'), 'utf8'), 'downloaded');

  if (process.platform !== 'win32') {
    const profileRoot = path.join(root, 'state', 'plugins', 'browser-control', 'profiles');
    const entries = await fsp.readdir(profileRoot);
    assert.ok(entries.length >= 1);
    const mode = (await fsp.stat(path.join(profileRoot, entries[0]))).mode & 0o777;
    assert.equal(mode, 0o700);
  }

  await runtime.stopBrowserControl({ workspaceId: 'workspace-files', sessionId });
  const restarted = await runtime.startBrowserControl({ workspaceId: 'workspace-files', workspaceRoot: root, settings, headless: true, profileMode: 'workspace' });
  assert.equal(restarted.session.profileMode, 'workspace');
  await runtime.stopBrowserControl({ workspaceId: 'workspace-files', sessionId: restarted.session.id });
});

test('reserves persistent profiles and the global session budget before asynchronous browser startup', async () => {
  const persistent = await Promise.allSettled([
    runtime.startBrowserControl({ workspaceId: 'workspace-race', workspaceRoot: root, settings, headless: true, profileMode: 'workspace' }),
    runtime.startBrowserControl({ workspaceId: 'workspace-race', workspaceRoot: root, settings, headless: true, profileMode: 'workspace' })
  ]);
  const persistentStarted = persistent.filter(result => result.status === 'fulfilled');
  const persistentRejected = persistent.filter(result => result.status === 'rejected');
  assert.equal(persistentStarted.length, 1);
  assert.equal(persistentRejected.length, 1);
  assert.match(String(persistentRejected[0].reason?.message || persistentRejected[0].reason), /already owns/);
  await runtime.stopBrowserControl({ workspaceId: 'workspace-race', sessionId: persistentStarted[0].value.session.id });

  const attempts = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => runtime.startBrowserControl({
    workspaceId: `workspace-budget-${index}`,
    workspaceRoot: root,
    settings,
    headless: true
  })));
  const started = attempts.filter(result => result.status === 'fulfilled');
  const rejected = attempts.filter(result => result.status === 'rejected');
  assert.equal(started.length, 4);
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0].reason?.message || rejected[0].reason), /session limit reached/);
  const status = runtime.browserControlStatus(root, settings);
  assert.equal(status.activeSessions, 4);
  assert.equal(status.startingSessions, 0);
  await Promise.all(started.map(result => runtime.stopBrowserControl({
    workspaceId: result.value.session.workspaceId,
    sessionId: result.value.session.id
  })));
});

test('loopback-only Browser Control fences websocket destinations with the same host policy', () => {
  assert.equal(runtime.__test.webSocketUrlAllowed('ws://127.0.0.1:8787/socket', false), true);
  assert.equal(runtime.__test.webSocketUrlAllowed('wss://localhost/socket', false), true);
  assert.equal(runtime.__test.webSocketUrlAllowed('wss://example.com/socket', false), false);
  assert.equal(runtime.__test.webSocketUrlAllowed('https://localhost/socket', false), false);
  assert.equal(runtime.__test.webSocketUrlAllowed('wss://example.com/socket', true), true);
});
