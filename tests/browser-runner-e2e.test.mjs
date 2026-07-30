import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runBrowserScenario } from '../gateway/plugins/browser-runner.mjs';

test('runs a complete browser scenario against a fake Playwright adapter', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-browser-e2e-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, 'package.json'), '{"type":"module"}', 'utf8');
  const modulePath = path.join(root, 'fake-playwright.mjs');
  await fsp.writeFile(modulePath, `
import fsp from 'node:fs/promises';
const listeners = new Map();
const page = {
  keyboard: { press: async()=>{}, down: async()=>{}, up: async()=>{} },
  mouse: { click: async()=>{}, move: async()=>{} },
  locator: selector => ({ click: async()=>{}, fill: async()=>{}, focus: async()=>{}, waitFor: async()=>{}, textContent: async()=>selector==='body'?'Fake Game':'' }),
  waitForTimeout: async()=>{}, setDefaultTimeout: ()=>{}, on: (name, fn)=>listeners.set(name, fn),
  goto: async url => ({ status:()=>200, ok:()=>true, url:()=>url }),
  url: ()=>'http://127.0.0.1:4173/', viewportSize: async()=>({width:1280,height:720}),
  screenshot: async ({path})=>fsp.writeFile(path, 'fake-image'),
  evaluate: async fn => {
    const oldDocument = globalThis.document;
    const oldState = globalThis.__DEVMATE_QA_STATE__;
    globalThis.__DEVMATE_QA_STATE__ = JSON.stringify({player:{health:100},boss:{phase:2}});
    globalThis.document = {
      title:'Fake Game', readyState:'complete', body:{innerText:'Fake Game'}, activeElement:{tagName:'CANVAS'},
      querySelectorAll:()=>[{width:1280,height:720,getBoundingClientRect:()=>({width:1280,height:720})}]
    };
    try { return fn(); } finally { globalThis.document=oldDocument; globalThis.__DEVMATE_QA_STATE__=oldState; }
  }
};
export const chromium = { launch: async()=>({
  newContext: async()=>({route:async()=>{},newPage:async()=>page}),
  close: async()=>{}
}) };
`, 'utf8');

  const result = await runBrowserScenario({
    workspaceRoot: root,
    url: 'http://127.0.0.1:4173/',
    settings: { playwrightModulePath: 'fake-playwright.mjs' },
    actions: [
      { type: 'expect_text', selector: 'body', text: 'Fake' },
      { type: 'expect_state', statePath: 'boss.phase', operator: 'eq', value: 2 },
      { type: 'capture_state', statePath: 'player.health' }
    ],
    screenshotPath: 'artifacts/e2e.png',
    reportPath: 'artifacts/e2e.json'
  });
  assert.equal(result.ok, true);
  assert.equal(result.actions[1].actual, 2);
  assert.equal(result.actions[2].value, 100);
  assert.equal(result.pageState.canvases[0].visible, true);
  assert.equal((await fsp.stat(path.join(root, 'artifacts/e2e.png'))).isFile(), true);
  const saved = JSON.parse(await fsp.readFile(path.join(root, 'artifacts/e2e.json'), 'utf8'));
  assert.equal(saved.ok, true);
});
