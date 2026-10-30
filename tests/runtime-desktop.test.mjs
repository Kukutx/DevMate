import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, execFileSync } from 'node:child_process';
import { DESKTOP_CAPABILITIES, NEVER_ACTED_ON, createDesktop, desktopLines } from '../runtime/desktop.mjs';
import { DevMateService } from '../runtime/service.mjs';

// A stand-in for the PowerShell that reads the windows: it says it is ready, and answers each request as `answers`
// says (a value, a function of the params, or { error }). started counts how often it was started.
function host(answers = {}, { ready = true } = {}) {
  const made = [];
  const spawnHost = () => {
    const child = new EventEmitter(), stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr, killed: false, kill: () => { child.killed = true; } });
    let buffer = '';
    stdin.on('data', chunk => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const { id, method, params } = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
        child.asked.push({ method, params });
        const answer = typeof answers[method] === 'function' ? answers[method](params) : answers[method];
        if (answer === undefined) continue;
        stdout.write(JSON.stringify(answer?.error ? { id, ok: false, error: answer.error } : { id, ok: true, result: answer }) + '\n');
      }
    });
    child.asked = [];
    if (ready) setImmediate(() => stdout.write('{"ready":true}\r\n'));
    made.push(child);
    return child;
  };
  return { spawnHost, made };
}
// The owner has switched the windows on (see the test of the switch).
const on = () => ({ enabled: true });
const window = (more = {}) => ({ handle: 1001, title: 'Untitled - Notepad', className: 'Notepad', pid: 42, program: 'notepad', x: 10, y: 20, width: 800, height: 600, minimized: false, focused: true, ...more });

test('the windows are offered as reads of no project, each with its input checked before anything is started', async () => {
  assert.deepEqual(DESKTOP_CAPABILITIES.map(item => [item.name, item.readOnly]), [['desktop.windows', true], ['desktop.snapshot', true], ['desktop.screenshot', true], ['desktop.act', false]]);
  assert.ok(DESKTOP_CAPABILITIES.every(item => item.description.length > 8 && item.description.length < 400));
  const { spawnHost, made } = host();
  const desktop = createDesktop({ platform: 'win32', spawnHost, stored: on });
  for (const [capability, input] of [['desktop.snapshot', {}], ['desktop.snapshot', { handle: -1 }], ['desktop.snapshot', { handle: 1, maxNodes: 5 }], ['desktop.windows', { query: '' }], ['desktop.screenshot', { handle: 1, extra: true }]])
    await assert.rejects(desktop.call({ capability, input }), { code: 'invalid_input', notStarted: true }, capability);
  await assert.rejects(desktop.call({ capability: 'desktop.click' }), { code: 'unknown_capability' });
  assert.equal(made.length, 0, 'nothing was started for these');
  // Another system says that windows are read on Windows, and starts nothing either.
  await assert.rejects(createDesktop({ platform: 'darwin', spawnHost, stored: on }).call({ capability: 'desktop.windows' }), { code: 'not_supported', message: /Windows computer for now; this one runs darwin/ });
  assert.equal(made.length, 0);
  assert.equal(createDesktop({ platform: 'linux' }).list().status, 'not available on linux');
  assert.equal(createDesktop({ platform: 'win32', stored: on }).list().status.split(';')[0], 'on');
});

test('desktop.act acts on one control only once the owner switched acting on too, which full access does not do, and never where acting as the owner runs commands', async () => {
  const { spawnHost, made } = host({ act: params => params.ref === 9 ? { control: 'button', name: 'Save', waiting: true } : { control: 'edit', name: 'Name', waiting: false } });
  let kept = { enabled: true }, full = true;
  const desktop = createDesktop({ platform: 'win32', spawnHost, stored: value => value === undefined ? kept : (kept = value), fullAccess: () => full });
  const act = (input, options) => desktop.call({ capability: 'desktop.act', input }, options);
  // Reading on and full access chosen: acting is still off until the owner switches it on.
  await assert.rejects(act({ handle: 5, ref: 2, action: 'invoke' }), { code: 'forbidden', notStarted: true, message: /^The owner has not let DevMate act in the windows of this computer.*"input":true.*Full access does not switch it on/ });
  assert.match(desktop.list().status, /; acting on controls: off, the owner switches it on at their computer/);
  kept = { enabled: true, input: true }; full = false;
  assert.match(desktop.list().status, /; acting on controls: on$/);
  assert.deepEqual(await act({ handle: 5, ref: 2, action: 'setValue', value: 'Ada' }), { handle: 5, ref: 2, action: 'setValue', control: 'edit', name: 'Name', untrusted: true });
  // The programs where acting as the owner runs commands or answers DevMate's questions go with every action.
  assert.deepEqual(made[0].asked.at(-1), { method: 'act', params: { handle: 5, ref: 2, action: 'setValue', value: 'Ada', never: [...NEVER_ACTED_ON] } });
  for (const program of ['windowsterminal', 'cmd', 'powershell', 'pwsh', 'code', 'obsidian', 'chrome', 'msedge', 'claude', 'chatgpt', 'codex', 'explorer', 'regedit', 'mmc', 'taskmgr']) assert.ok(NEVER_ACTED_ON.includes(program), program);
  // A press the program has not finished (it opened a dialog of its own) says so.
  assert.match((await act({ handle: 5, ref: 9, action: 'invoke' })).note, /^The program has not finished it after three seconds/);
  // value goes with setValue alone; an action is one of those named; a read asks for none of it.
  const asked = made[0].asked.length;
  for (const input of [{ handle: 5, ref: 2, action: 'setValue' }, { handle: 5, ref: 2, action: 'invoke', value: 'x' }, { handle: 5, ref: 0, action: 'invoke' }, { handle: 5, ref: 2, action: 'click' }])
    await assert.rejects(act(input), { code: 'invalid_input', notStarted: true }, JSON.stringify(input));
  await assert.rejects(act({ handle: 5, ref: 2, action: 'invoke' }, { readOnly: true }), { code: 'forbidden', message: /acts in a window: call it with capability_call/ });
  assert.equal(made[0].asked.length, asked);
  // Reading switched off switches acting off with it.
  kept = { enabled: false, input: true };
  await assert.rejects(act({ handle: 5, ref: 2, action: 'invoke' }), { code: 'forbidden' });
  desktop.close();
});

test('the windows are read only once the owner has switched that on at the computer, or chosen full access, and a connected client can only switch it off', async t => {
  const { spawnHost, made } = host({ windows: { items: [] } });
  let kept, full = false;
  const desktop = createDesktop({ platform: 'win32', spawnHost, stored: value => value === undefined ? kept : (kept = value), fullAccess: () => full });
  await assert.rejects(desktop.call({ capability: 'desktop.windows' }), { code: 'forbidden', notStarted: true, message: /^The owner has not let DevMate read the windows of this computer\..*capability\.configure.*"enabled":true/ });
  assert.equal(made.length, 0, 'nothing was started');
  assert.match(desktop.list().status, /^off: the owner switches it on at their computer, devmate capability\.configure/);
  assert.deepEqual(desktop.settings().items, [{ engine: 'desktop', settings: { enabled: false, input: false } }]);
  // Full access shares everything, the windows too, without the switch.
  full = true;
  assert.deepEqual(await desktop.call({ capability: 'desktop.windows' }), { items: [], untrusted: true });
  assert.match(desktop.list().status, /^on: the full access profile/);
  full = false;
  await assert.rejects(desktop.call({ capability: 'desktop.windows' }), { code: 'forbidden' });
  // The switch: on, then off again, which ends the program that reads them.
  assert.deepEqual(desktop.configure({ enabled: true }), { engine: 'desktop', settings: { enabled: true, input: false }, scope: 'instance' });
  await desktop.call({ capability: 'desktop.windows' });
  const running = made.at(-1);
  desktop.configure({ enabled: false });
  assert.equal(running.killed, true);
  desktop.configure({ enabled: null });
  assert.deepEqual(kept, {});
  for (const wrong of [{ enabled: 'yes' }, { input: 'on' }, { enabled: true, more: 1 }]) assert.throws(() => desktop.configure(wrong), { code: 'invalid_input' });
  desktop.close();
  // Through the runtime: the owner at the computer switches it on; a connected client only off, with full access too.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-desktop-switch-'));
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: '' });
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await service.ready;
  const local = { id: 'owner', surface: 'local' }, connected = { id: 'owner' };
  await assert.rejects(service.call('capability.configure', { engine: 'desktop', settings: { enabled: true } }, connected), { code: 'forbidden', message: /A connected client can only switch (one|it) off/ });
  service.accessProfile = 'full';
  await assert.rejects(service.call('capability.configure', { engine: 'desktop', settings: { enabled: true } }, connected), { code: 'forbidden', message: /^Reading the owner's windows, and acting in them, is switched on by the owner on their own computer/ });
  service.accessProfile = 'guarded';
  assert.deepEqual((await service.call('capability.configure', { engine: 'desktop', settings: { enabled: true } }, local)).settings, { enabled: true, input: false });
  assert.deepEqual((await service.call('capability.settings', { engine: 'desktop' }, connected)).items[0].settings, { enabled: true, input: false });
  assert.deepEqual((await service.call('capability.configure', { engine: 'desktop', settings: { enabled: false } }, connected)).settings, { enabled: false, input: false });
  assert.equal(service.store.setting('engine-settings.desktop').enabled, false, 'kept with the runtime');
});

test('desktop.windows lists the windows the program read, kept by words of their title or program, as what programs say', async () => {
  const items = [window(), window({ handle: 1002, title: '报告.docx - Word', program: 'WINWORD', focused: false })];
  const { spawnHost, made } = host({ windows: { items } });
  const desktop = createDesktop({ platform: 'win32', spawnHost, stored: on });
  assert.deepEqual(await desktop.call({ capability: 'desktop.windows' }), { items, untrusted: true });
  assert.deepEqual((await desktop.call({ capability: 'desktop.windows', input: { query: 'word' } })).items.map(item => item.handle), [1002]);
  assert.deepEqual((await desktop.call({ capability: 'desktop.windows', input: { query: '报告' } })).items.map(item => item.handle), [1002]);
  assert.equal(made.length, 1, 'one program for all of them');
  desktop.close();
  assert.equal(made[0].killed, true, 'and it ends with the runtime');
});

test('desktop.snapshot reads a window\'s controls as indented lines, never a password, kept by words and cut at maxNodes', async () => {
  const nodes = [{ d: 0, t: 'Window', n: 'Settings', b: [0, 0, 800, 600] }, { d: 1, t: 'Edit', n: 'Name', v: 'Ada', a: 'name', s: ['focused'], b: [10, 10, 200, 20] },
    { d: 1, t: 'Edit', n: 'Password', p: true }, { d: 1, t: 'CheckBox', n: 'Remember me', s: ['toggled=on'] }, { d: 2, t: 'Button', n: 'Save', s: ['disabled'] }];
  assert.deepEqual(desktopLines(nodes), ['[1] window "Settings" @0,0,800,600', '  [2] edit "Name" value="Ada" #name (focused) @10,10,200,20', '  [3] edit "Password" (password field)', '  [4] checkbox "Remember me" (toggled=on)', '    [5] button "Save" (disabled)']);
  const { spawnHost, made } = host({ snapshot: params => ({ nodes: nodes.slice(0, params.most), more: params.most < nodes.length }) });
  const desktop = createDesktop({ platform: 'win32', spawnHost, stored: on });
  assert.deepEqual(await desktop.call({ capability: 'desktop.snapshot', input: { handle: 7 } }), { handle: 7, text: desktopLines(nodes).join('\n'), nodes: 5, untrusted: true });
  assert.deepEqual(made[0].asked.at(-1), { method: 'snapshot', params: { handle: 7, most: 300, budget: 15000 } });
  // With words, the whole window is read and the lines that have them kept, whatever their case.
  assert.deepEqual(await desktop.call({ capability: 'desktop.snapshot', input: { handle: 7, query: 'SAVE', maxNodes: 10 } }), { handle: 7, text: '    [5] button "Save" (disabled)', nodes: 1, query: 'SAVE', matched: 1, untrusted: true });
  assert.deepEqual(made[0].asked.at(-1).params, { handle: 7, most: 1500, budget: 15000 });
  const cut = await desktop.call({ capability: 'desktop.snapshot', input: { handle: 7, maxNodes: 10 } });
  assert.equal(cut.nodes, 5); assert.equal(cut.truncated, undefined);
  desktop.close();
  const many = Array.from({ length: 12 }, (_, at) => ({ d: 0, t: 'Text', n: 'line ' + at }));
  const long = createDesktop({ platform: 'win32', spawnHost: host({ snapshot: params => ({ nodes: many.slice(0, params.most), more: params.most < many.length }) }).spawnHost, stored: on });
  assert.deepEqual(await long.call({ capability: 'desktop.snapshot', input: { handle: 7, maxNodes: 10 } }), { handle: 7, text: desktopLines(many.slice(0, 10)).join('\n'), nodes: 10, truncated: true, untrusted: true });
  long.close();
});

test('desktop.screenshot is handed on as a picture, of a window or of the whole screen, with where it is and how it was scaled', async () => {
  const { spawnHost, made } = host({ screenshot: params => params.handle === null ? { base64: 'U0NSRUVO', width: 3840, height: 1234, x: -2560, y: -355, scale: 0.857 } : { base64: 'V0lORE9X', width: 800, height: 600, x: 10, y: 20, scale: 1 } });
  const desktop = createDesktop({ platform: 'win32', spawnHost, stored: on });
  assert.deepEqual(await desktop.call({ capability: 'desktop.screenshot', input: { handle: 1001 } }), { content: [{ type: 'image', data: 'V0lORE9X', mimeType: 'image/png' }, { type: 'text', text: '{"handle":1001,"x":10,"y":20,"width":800,"height":600}' }] });
  assert.deepEqual(await desktop.call({ capability: 'desktop.screenshot' }), { content: [{ type: 'image', data: 'U0NSRUVO', mimeType: 'image/png' }, { type: 'text', text: '{"screen":true,"x":-2560,"y":-355,"width":3840,"height":1234,"scale":0.857}' }] });
  assert.deepEqual(made[0].asked.map(asked => asked.params), [{ handle: 1001 }, { handle: null }]);
  desktop.close();
});

test('what the program says it cannot do is passed on with its code, and a program that hangs, ends or does not start is replaced at the next call', async () => {
  let gone = { error: { code: 'not_found', message: 'No window has the handle 5 any more.' } };
  const { spawnHost, made } = host({ snapshot: () => gone, windows: { items: [] } });
  const desktop = createDesktop({ platform: 'win32', spawnHost, callMs: 200, stored: on });
  await assert.rejects(desktop.call({ capability: 'desktop.snapshot', input: { handle: 5 } }), { code: 'not_found', message: 'No window has the handle 5 any more.' });
  gone = { error: { code: 'made_up', message: 'x'.repeat(600) } };
  await assert.rejects(desktop.call({ capability: 'desktop.snapshot', input: { handle: 5 } }), error => error.code === 'desktop_error' && error.message.length === 500);
  // No answer: the call ends after its time, the program with it, and the next call starts another.
  gone = undefined;
  await assert.rejects(desktop.call({ capability: 'desktop.snapshot', input: { handle: 5 } }), { code: 'desktop_timeout' });
  assert.equal(made[0].killed, true);
  assert.deepEqual(await desktop.call({ capability: 'desktop.windows' }), { items: [], untrusted: true });
  assert.equal(made.length, 2);
  // A program that ends while a call waits fails that call, and the next one starts anew.
  gone = undefined;
  const waiting = desktop.call({ capability: 'desktop.snapshot', input: { handle: 5 } });
  await new Promise(resolve => setImmediate(resolve));
  made[1].emit('exit', 1);
  await assert.rejects(waiting, { code: 'desktop_unavailable', message: /ended/ });
  await desktop.call({ capability: 'desktop.windows' });
  assert.equal(made.length, 3);
  desktop.close();
  // One that never says it is ready, and one that cannot be started.
  const silent = createDesktop({ platform: 'win32', spawnHost: host({}, { ready: false }).spawnHost, startMs: 100, stored: on });
  await assert.rejects(silent.call({ capability: 'desktop.windows' }), { code: 'desktop_unavailable', message: /did not start within/ });
  const missing = createDesktop({ platform: 'win32', spawnHost: () => { const child = host({}, { ready: false }).spawnHost(); setImmediate(() => child.emit('error', new Error('spawn ENOENT'))); return child; }, stored: on });
  await assert.rejects(missing.call({ capability: 'desktop.windows' }), { code: 'desktop_unavailable', message: /could not be started: spawn ENOENT/ });
});

test('the program that reads the windows ends after a while without a call', async () => {
  const { spawnHost, made } = host({ windows: { items: [] } });
  const desktop = createDesktop({ platform: 'win32', spawnHost, idleMs: 50, stored: on });
  await desktop.call({ capability: 'desktop.windows' });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(made[0].killed, true);
  await desktop.call({ capability: 'desktop.windows' });
  assert.equal(made.length, 2);
  desktop.close();
});

test('the windows are listed beside the browser, and a call for them needs no project', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-desktop-'));
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: '' });
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await service.ready;
  const owner = { id: 'owner', surface: 'local' }, connected = { id: 'owner' };
  const listed = await service.call('capability.list', { engine: 'desktop' }, connected);
  assert.deepEqual(listed.engines.map(engine => [engine.id, engine.capabilities.map(item => item.name)]), [['desktop', ['desktop.windows', 'desktop.snapshot', 'desktop.screenshot', 'desktop.act']]]);
  assert.equal((await service.call('capability.list', { name: 'desktop.act' }, owner)).hint.startsWith('Invoke with capability_call'), true);
  await assert.rejects(service.call('capability.query', { capability: 'desktop.act', input: { handle: 1, ref: 1, action: 'invoke' } }, connected), { code: 'forbidden' });
  assert.equal((await service.call('capability.list', { name: 'desktop.snapshot' }, owner)).capability.inputSchema.required[0], 'handle');
  // A call goes to the engine without a project: here one that refuses before anything is started.
  await assert.rejects(service.call('capability.query', { capability: 'desktop.snapshot', input: {} }, connected), { code: 'invalid_input' });
  await assert.rejects(service.call('capability.call', { capability: 'desktop.windows', input: { query: '' } }, connected), { code: 'invalid_input' });
});

test('on Windows the windows are read by the system\'s own PowerShell', { skip: process.platform !== 'win32' && 'the windows are read on Windows', timeout: 90000 }, async () => {
  const desktop = createDesktop({ stored: on });
  try {
    const { items } = await desktop.call({ capability: 'desktop.windows' });
    assert.ok(Array.isArray(items));
    for (const item of items) assert.deepEqual(Object.keys(item).sort(), ['className', 'focused', 'handle', 'height', 'minimized', 'pid', 'program', 'title', 'width', 'x', 'y']);
    const screen = await desktop.call({ capability: 'desktop.screenshot' });
    assert.equal(Buffer.from(screen.content[0].data, 'base64').subarray(1, 4).toString('latin1'), 'PNG');
    const shown = items.find(item => !item.minimized && item.width > 0);
    if (shown) assert.equal(typeof (await desktop.call({ capability: 'desktop.snapshot', input: { handle: shown.handle, maxNodes: 20 } })).text, 'string');
    await assert.rejects(desktop.call({ capability: 'desktop.snapshot', input: { handle: 1 } }), { code: 'not_found' });
  } finally { desktop.close(); }
});

// A window of a program of its own, made here: a field, a box to tick, a button and a password field. It stands far off
// the screen, so that nobody sees it, and is read and acted on where it is.
const CHECK_PROGRAM = String.raw`using System; using System.Drawing; using System.Windows.Forms;
public static class Check { [STAThread] public static void Main() {
  var form = new Form { Text = "DevMate desktop check", StartPosition = FormStartPosition.Manual, Location = new Point(-20000, -20000), Width = 420, Height = 200 };
  var name = new TextBox { Left = 10, Top = 10, Width = 200, AccessibleName = "Name" };
  var keep = new CheckBox { Text = "Keep", Left = 10, Top = 40 };
  var save = new Button { Text = "Save", Left = 10, Top = 70 };
  var secret = new TextBox { Left = 220, Top = 10, Width = 150, UseSystemPasswordChar = true, AccessibleName = "Secret" };
  save.Click += (s, e) => form.Text = "Saved " + name.Text + (keep.Checked ? " kept" : "");
  form.Controls.AddRange(new Control[] { name, keep, save, secret });
  Application.Run(form);
} }`;
test('on Windows a control is acted on through accessibility: a field filled, a box ticked, a button pressed, a password field left alone', { skip: process.platform !== 'win32' && 'the windows are acted on on Windows', timeout: 120000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-desktop-act-')), program = path.join(temp, 'devmate-desktop-check.exe'), source = path.join(temp, 'check.cs');
  fs.writeFileSync(source, CHECK_PROGRAM);
  execFileSync(process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:CHECK_SOURCE)) -ReferencedAssemblies System.Windows.Forms, System.Drawing -OutputAssembly $env:CHECK_PROGRAM -OutputType WindowsApplication'],
    { env: { ...process.env, CHECK_SOURCE: source, CHECK_PROGRAM: program }, windowsHide: true });
  const shown = spawn(program, [], { stdio: 'ignore' });
  const desktop = createDesktop({ stored: () => ({ enabled: true, input: true }) });
  t.after(() => { desktop.close(); shown.kill(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  let window;
  for (let tries = 0; tries < 100 && !window; tries++) { window = (await desktop.call({ capability: 'desktop.windows', input: { query: 'DevMate desktop check' } })).items[0]; if (!window) await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(window, 'the window is there'); assert.equal(window.program, 'devmate-desktop-check');
  const lines = (await desktop.call({ capability: 'desktop.snapshot', input: { handle: window.handle } })).text;
  const ref = pattern => Number(new RegExp('\\[(\\d+)\\] ' + pattern).exec(lines)?.[1]);
  const [name, keep, save, secret] = [ref('edit "Name"'), ref('checkbox "Keep"'), ref('button "Save"'), ref('edit "Secret" \\(password field\\)')];
  assert.ok(name && keep && save && secret, lines);
  const act = input => desktop.call({ capability: 'desktop.act', input: { handle: window.handle, ...input } });
  assert.deepEqual(await act({ ref: name, action: 'setValue', value: 'Ada' }), { handle: window.handle, ref: name, action: 'setValue', control: 'edit', name: 'Name', untrusted: true });
  assert.equal((await act({ ref: keep, action: 'toggle' })).control, 'checkbox');
  assert.equal((await act({ ref: save, action: 'invoke' })).control, 'button');
  let title;
  for (let tries = 0; tries < 50 && title !== 'Saved Ada kept'; tries++) { title = (await desktop.call({ capability: 'desktop.windows', input: { query: 'Saved' } })).items[0]?.title; if (title !== 'Saved Ada kept') await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(title, 'Saved Ada kept');
  // Not into a password field; not what a control does not take; not a ref no snapshot of this window gave.
  await assert.rejects(act({ ref: secret, action: 'setValue', value: 'x' }), { code: 'forbidden', message: /password field/ });
  await assert.rejects(act({ ref: keep, action: 'setValue', value: 'x' }), { code: 'invalid_input', message: /^This control does not take setValue\. It takes: toggle, focus\.$/ });
  await assert.rejects(act({ ref: 999, action: 'invoke' }), { code: 'not_found', message: /No desktop\.snapshot of this window gave the ref 999/ });
  // A program named among those never acted on is not acted on.
  const careful = createDesktop({ stored: () => ({ enabled: true, input: true }), never: [...NEVER_ACTED_ON, 'devmate-desktop-check'] });
  try {
    await careful.call({ capability: 'desktop.snapshot', input: { handle: window.handle } });
    await assert.rejects(careful.call({ capability: 'desktop.act', input: { handle: window.handle, ref: save, action: 'invoke' } }), { code: 'forbidden', message: /^DevMate does not act in the windows of devmate-desktop-check/ });
  } finally { careful.close(); }
});
