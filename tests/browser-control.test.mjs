import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  __test,
  createBrowserControlState,
  actBrowserControl,
  browserControlSessions,
  browserControlStatus,
  listBrowserTabs,
  shutdownBrowserControl,
  snapshotBrowserControl,
  startBrowserControl,
  stopBrowserControl
} from '../runtime/engines/browser-control-runtime.mjs';
import { __test as pluginTest, browserControlActionSchema, browserControlPlugin } from '../runtime/engines/browser-control.mjs';
import { createCapabilities } from '../runtime/capabilities.mjs';

const state = createBrowserControlState();

test('Browser Control defaults to loopback-only URLs and bounded action schemas', () => {
  assert.equal(__test.assertAllowedUrl('http://127.0.0.1:4173/', false).hostname, '127.0.0.1');
  assert.equal(__test.assertAllowedUrl('https://example.com/', true).hostname, 'example.com');
  assert.throws(() => __test.assertAllowedUrl('https://example.com/', false), /Remote browser URLs are disabled/);
  assert.throws(() => __test.assertAllowedUrl('file:///etc/passwd', true), /Unsupported browser URL protocol/);
  assert.equal(__test.requestUrlAllowed('data:text/plain,ok', false), true);
  assert.equal(__test.requestUrlAllowed('https://example.com/', false), false);
  assert.equal(__test.requestUrlAllowed('https://example.com/', true), true);
  assert.equal(browserControlActionSchema.parse({ type: 'click', ref: 'e1', snapshotId: 'snap-1' }).type, 'click');
  assert.equal(browserControlActionSchema.parse({ type: 'double_click', x: 10, y: 20 }).type, 'double_click');
  assert.equal(browserControlActionSchema.parse({ type: 'upload', selector: 'input[type=file]', paths: ['fixture.txt'] }).type, 'upload');
  const drag = browserControlActionSchema.parse({ type: 'drag', selector: '#source', destinationSelector: '#target' });
  assert.equal(pluginTest.runtimeAction(drag).targetSelector, '#target');
  assert.throws(() => browserControlActionSchema.parse({ type: 'evaluate', script: 'alert(1)' }));
  assert.throws(() => browserControlActionSchema.parse({ type: 'click', unexpected: true }));

});

test('registers Browser Control with scoped schemas, for the owner only', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-browser-catalog-'));
  const project = { id: 'browser-fixture', root, access: 'write' };
  const settings = new Map();
  const service = {
    project(id) { assert.equal(id, project.id); return project; },
    store: { event() {}, setting(key, value) { if (value !== undefined) settings.set(key, value); return settings.get(key); } }
  };
  const capabilities = await createCapabilities({ service, instanceRoot: path.join(root, 'private'), engines: [browserControlPlugin] });
  t.after(async () => { await capabilities.close(); await fsp.rm(root, { recursive: true, force: true }); });
  const [engine] = (await capabilities.list({ projectId: project.id, engine: 'browser-control' }, { callerRole: 'owner' })).engines;
  assert.equal(engine.ownerOnly, true);
  const tools = engine.capabilities;
  assert.deepEqual(tools.map(tool => tool.name), [
    'browser-control.status', 'browser-control.start', 'browser-control.tabs',
    'browser-control.snapshot', 'browser-control.act', 'browser-control.takeover',
    'browser-control.resume', 'browser-control.stop', 'browser-control.diagnose'
  ]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.properties.workspaceId, undefined);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', tool.name);
    assert.equal(tool.ownerOnly, true, tool.name);
  }
  const status = await capabilities.call({ projectId: project.id, capability: 'browser-control.status' }, { callerRole: 'owner' });
  assert.equal(status.structuredContent.workspace.id, project.id);
  // A session is a browser on the owner's desktop, possibly with a signed-in persistent profile:
  // neither a write member nor a reader may start, drive or even read one.
  for (const callerRole of ['write', 'read']) {
    for (const [capability, input] of [['browser-control.start', { profileMode: 'workspace' }], ['browser-control.snapshot', { sessionId: 'any' }], ['browser-control.status', {}]]) {
      await assert.rejects(capabilities.call({ projectId: project.id, capability, input }, { callerRole }),
        error => error.code === 'forbidden' && /owner/.test(error.message), callerRole + ' ' + capability);
    }
    const listed = (await capabilities.list({ projectId: project.id, engine: 'browser-control' }, { callerRole })).engines[0];
    assert.deepEqual(listed.capabilities, [], 'owner-only capabilities are not offered to ' + callerRole);
    await assert.rejects(capabilities.list({ projectId: project.id, name: 'browser-control.start' }, { callerRole }), error => error.code === 'forbidden');
  }
  await assert.rejects(capabilities.call({ projectId: project.id, capability: 'browser-control.status', input: { workspaceId: 'other' } }, { callerRole: 'owner' }));
});

test('keeps managed browser sessions workspace-bound and rejects stale element refs', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-browser-control-'));
  t.after(async () => {
    await shutdownBrowserControl(state);
    await fsp.rm(root, { recursive: true, force: true });
  });
  await fsp.writeFile(path.join(root, 'package.json'), '{"type":"module"}', 'utf8');
  const modulePath = path.join(root, 'fake-playwright.mjs');
  await fsp.writeFile(modulePath, `
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
class FakeLocator {
  constructor(selector){ this.selector=selector; }
  async click(){} async fill(){} async press(){} async focus(){} async hover(){}
  async scrollIntoViewIfNeeded(){} async selectOption(values){ return values; }
  async check(){} async uncheck(){} async waitFor(){}
  async ariaSnapshot(){ return '- button "Fake action"'; }
}
class FakePage extends EventEmitter {
  constructor(context){
    super(); this.context=context; this.currentUrl='about:blank'; this.closed=false;
    this.keyboard={ press:async()=>{} }; this.mouse={ click:async()=>{}, wheel:async()=>{} };
  }
  url(){ return this.currentUrl; }
  async title(){ return 'Fake Browser'; }
  async goto(url){ this.currentUrl=String(url); return { status:()=>200 }; }
  async goBack(){ return { status:()=>200 }; }
  async goForward(){ return { status:()=>200 }; }
  async reload(){ return { status:()=>200 }; }
  async waitForTimeout(){}
  locator(selector){ return new FakeLocator(selector); }
  getByRole(role){ return new FakeLocator('role:'+role); }
  getByText(text){ return new FakeLocator('text:'+text); }
  async bringToFront(){}
  frames(){ return [{ name:()=>'', url:()=>this.currentUrl }]; }
  isClosed(){ return this.closed; }
  async screenshot({path}){ await fsp.writeFile(path, 'fake-image'); }
  async evaluate(){
    return {
      title:'Fake Browser', readyState:'complete', bodyText:'Fake page body',
      elements:[{ ref:'e1', selector:'#fake-action', tag:'button', role:'button', name:'Fake action', text:'Fake action', href:null, type:null, disabled:false, checked:null, box:{x:10,y:10,width:100,height:30} }]
    };
  }
  async close(){ if(this.closed) return; this.closed=true; this.emit('close'); }
}
class FakeContext extends EventEmitter {
  constructor(){ super(); this.items=[]; }
  async route(){}
  async routeWebSocket(){}
  async newPage(){ const page=new FakePage(this); this.items.push(page); this.emit('page', page); return page; }
  async close(){ for(const page of [...this.items]) await page.close(); }
}
class FakeBrowser extends EventEmitter {
  constructor(){ super(); this.connected=true; this.context=null; }
  isConnected(){ return this.connected; }
  async newContext(){ this.context=new FakeContext(); return this.context; }
  async close(){ if(!this.connected) return; this.connected=false; if(this.context) await this.context.close(); this.emit('disconnected'); }
}
export const chromium = { launch:async()=>new FakeBrowser() };
`, 'utf8');

  const settings = { playwrightModulePath: 'fake-playwright.mjs', allowRemoteUrls: false, defaultHeadless: true };
  const status = browserControlStatus(state, root, settings);
  assert.equal(status.available, true);
  assert.equal(status.defaultHeadless, true);
  await assert.rejects(() => startBrowserControl(state, { workspaceId: 'workspace-a', workspaceRoot: root, settings, url: 'https://example.com/' }), /Remote browser URLs are disabled/);

  const started = await startBrowserControl(state, { workspaceId: 'workspace-a', workspaceRoot: root, settings, url: 'http://127.0.0.1:4173/' });
  const sessionId = started.session.id;
  assert.equal(started.session.workspaceId, 'workspace-a');
  assert.equal(started.session.profileMode, 'ephemeral');
  assert.equal(started.session.controlMode, 'agent');
  assert.equal(started.session.tabCount, 1);

  const listed = await listBrowserTabs(state, { workspaceId: 'workspace-a', sessionId });
  assert.equal(listed.tabs[0].url, 'http://127.0.0.1:4173/');
  await assert.rejects(() => listBrowserTabs(state, { workspaceId: 'workspace-b', sessionId }), /belongs to workspace/);

  const snapshot = await snapshotBrowserControl(state, { workspaceId: 'workspace-a', sessionId });
  assert.equal(snapshot.elements[0].ref, 'e1');
  assert.match(snapshot.snapshotId, /^tab-1-snapshot-1$/);
  await assert.rejects(() => actBrowserControl(state, { workspaceId: 'workspace-a', sessionId, action: { type: 'click', ref: 'e1' } }), /stale or missing snapshotId/);

  const acted = await actBrowserControl(state, { workspaceId: 'workspace-a', sessionId, action: { type: 'click', ref: 'e1', snapshotId: snapshot.snapshotId } });
  assert.equal(acted.result.type, 'click');
  assert.equal(acted.snapshotInvalidated, true);
  await assert.rejects(() => actBrowserControl(state, { workspaceId: 'workspace-a', sessionId, action: { type: 'click', ref: 'e1', snapshotId: snapshot.snapshotId } }), /stale or missing snapshotId/);

  const screenshot = await actBrowserControl(state, { workspaceId: 'workspace-a', sessionId, action: { type: 'screenshot', path: 'artifacts/browser-control/test.png' } });
  assert.equal(screenshot.result.path, 'artifacts/browser-control/test.png');
  assert.equal((await fsp.stat(path.join(root, 'artifacts/browser-control/test.png'))).isFile(), true);
  assert.equal((await browserControlSessions(state, 'workspace-a')).length, 1);

  const stopped = await stopBrowserControl(state, { workspaceId: 'workspace-a', sessionId });
  assert.equal(stopped.stopped, true);
  assert.equal((await browserControlSessions(state, 'workspace-a')).length, 0);
});
