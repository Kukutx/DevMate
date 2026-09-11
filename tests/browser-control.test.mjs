import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  __test,
  actBrowserControl,
  browserControlSessions,
  browserControlStatus,
  listBrowserTabs,
  shutdownBrowserControl,
  snapshotBrowserControl,
  startBrowserControl,
  stopBrowserControl
} from '../gateway/plugins/browser-control-runtime.mjs';
import { __test as pluginTest, browserControlActionSchema, browserControlPlugin } from '../gateway/plugins/browser-control.mjs';
import { builtinPlugins } from '../gateway/plugins/builtins.mjs';
import { ownerOnlyTool, requiredCapabilityForTool, validateToolRegistration } from '../gateway/tool-policy.mjs';

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
  for (const name of [
    'browser_control_status', 'browser_control_start', 'browser_control_tabs',
    'browser_control_snapshot', 'browser_control_act', 'browser_control_takeover',
    'browser_control_resume', 'browser_control_stop'
  ]) {
    assert.equal(ownerOnlyTool(name), true, name);
    assert.equal(requiredCapabilityForTool(name, { readOnlyHint: name.includes('status') || name.includes('tabs') || name.includes('snapshot') }), 'admin', name);
  }
});

test('registers Browser Control as an optional owner-only plugin with valid tool policy', () => {
  assert.equal(browserControlPlugin.manifest.defaultEnabled, false);
  assert.equal(builtinPlugins.some(plugin => plugin.manifest.id === 'devmate.browser-control'), true);
  assert.deepEqual(browserControlPlugin.manifest.toolPrefixes, ['browser_control_']);
  const tools = new Map();
  browserControlPlugin.activate({ server: { registerTool(name, config, handler) { tools.set(name, { config, handler }); } } });
  assert.deepEqual([...tools.keys()], [
    'browser_control_status', 'browser_control_start', 'browser_control_tabs',
    'browser_control_snapshot', 'browser_control_act', 'browser_control_takeover',
    'browser_control_resume', 'browser_control_stop'
  ]);
  for (const [name, entry] of tools) {
    const policy = validateToolRegistration(name, entry.config);
    assert.equal(policy.ok, true, `${name}: ${policy.errors.join('; ')}`);
    assert.equal(policy.ownerOnly, true, name);
    assert.equal(policy.capability, 'admin', name);
  }
});

test('keeps managed browser sessions workspace-bound and rejects stale element refs', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-browser-control-'));
  t.after(async () => {
    await shutdownBrowserControl();
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
  const status = browserControlStatus(root, settings);
  assert.equal(status.available, true);
  assert.equal(status.defaultHeadless, true);
  await assert.rejects(() => startBrowserControl({ workspaceId: 'workspace-a', workspaceRoot: root, settings, url: 'https://example.com/' }), /Remote browser URLs are disabled/);

  const started = await startBrowserControl({ workspaceId: 'workspace-a', workspaceRoot: root, settings, url: 'http://127.0.0.1:4173/' });
  const sessionId = started.session.id;
  assert.equal(started.session.workspaceId, 'workspace-a');
  assert.equal(started.session.profileMode, 'ephemeral');
  assert.equal(started.session.controlMode, 'agent');
  assert.equal(started.session.tabCount, 1);

  const listed = await listBrowserTabs({ workspaceId: 'workspace-a', sessionId });
  assert.equal(listed.tabs[0].url, 'http://127.0.0.1:4173/');
  await assert.rejects(() => listBrowserTabs({ workspaceId: 'workspace-b', sessionId }), /belongs to workspace/);

  const snapshot = await snapshotBrowserControl({ workspaceId: 'workspace-a', sessionId });
  assert.equal(snapshot.elements[0].ref, 'e1');
  assert.match(snapshot.snapshotId, /^tab-1-snapshot-1$/);
  await assert.rejects(() => actBrowserControl({ workspaceId: 'workspace-a', sessionId, action: { type: 'click', ref: 'e1' } }), /stale or missing snapshotId/);

  const acted = await actBrowserControl({ workspaceId: 'workspace-a', sessionId, action: { type: 'click', ref: 'e1', snapshotId: snapshot.snapshotId } });
  assert.equal(acted.result.type, 'click');
  assert.equal(acted.snapshotInvalidated, true);
  await assert.rejects(() => actBrowserControl({ workspaceId: 'workspace-a', sessionId, action: { type: 'click', ref: 'e1', snapshotId: snapshot.snapshotId } }), /stale or missing snapshotId/);

  const screenshot = await actBrowserControl({ workspaceId: 'workspace-a', sessionId, action: { type: 'screenshot', path: 'artifacts/browser-control/test.png' } });
  assert.equal(screenshot.result.path, 'artifacts/browser-control/test.png');
  assert.equal((await fsp.stat(path.join(root, 'artifacts/browser-control/test.png'))).isFile(), true);
  assert.equal((await browserControlSessions('workspace-a')).length, 1);

  const stopped = await stopBrowserControl({ workspaceId: 'workspace-a', sessionId });
  assert.equal(stopped.stopped, true);
  assert.equal((await browserControlSessions('workspace-a')).length, 0);
});
