import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DevMateService } from '../runtime/service.mjs';
import { Store } from '../runtime/store.mjs';
import { createSecretStore } from '../runtime/secrets.mjs';
import { normalizeConfig } from '../runtime/config.mjs';
import { main as cli } from '../runtime/cli.mjs';

const require = createRequire(import.meta.url);
const { createVscodeRuntimeEntry } = require('../vscode-host/runtime-entry.cjs');
const owner = Object.freeze({ id: 'owner', surface: 'local' });
// The owner of the instance closes first; only then can its directory be removed.
function temporary(t, prefix, close = () => {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const owned = { directory, close };
  t.after(async () => { await owned.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return owned;
}
async function service(t, config, extra = {}) {
  const owned = temporary(t, 'devmate-doctor-'), temp = owned.directory;
  const instance = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: '', config, ...extra });
  owned.close = () => instance.close();
  await instance.ready;
  return { service: instance, temp };
}

test('connection credentials live in the instance, reach only the connection and are never returned', async t => {
  const { service: runtime, temp } = await service(t, {});
  const stored = await runtime.call('secret.set', { name: 'CLOUDFLARE_TUNNEL_TOKEN', value: '  token-value  ' }, owner);
  assert.deepEqual(stored, { name: 'CLOUDFLARE_TUNNEL_TOKEN', stored: true, restartRequired: true });
  assert.deepEqual(await runtime.call('secret.list', {}, owner), { names: ['CLOUDFLARE_TUNNEL_TOKEN'] });
  assert.equal(JSON.stringify(await runtime.call('settings.read', {}, owner)).includes('token-value'), false);
  const secrets = createSecretStore(path.join(temp, 'instance'));
  assert.equal(secrets.environment({ CLOUDFLARE_TUNNEL_TOKEN: 'from-environment', PATH: 'p' }).CLOUDFLARE_TUNNEL_TOKEN, 'token-value', 'a stored credential wins over the environment variable');
  assert.equal(process.env.CLOUDFLARE_TUNNEL_TOKEN === 'token-value', false, 'it is never placed in the runtime environment that project commands inherit');
  for (const [name, value] of [['bad name', 'x'], ['OK', 'two\nlines']]) await assert.rejects(runtime.call('secret.set', { name, value }, owner), { code: 'invalid_input' });
  // Credentials and the doctor are local-owner only: an MCP caller, even the owner, cannot reach them.
  for (const operation of ['secret.set', 'secret.list', 'secret.remove', 'runtime.doctor']) {
    await assert.rejects(runtime.call(operation, operation === 'secret.set' ? { name: 'A', value: 'b' } : operation === 'secret.remove' ? { name: 'A' } : {}, { id: 'owner' }), { code: 'forbidden' });
  }
  assert.equal((await runtime.call('secret.remove', { name: 'CLOUDFLARE_TUNNEL_TOKEN' }, owner)).removed, true);
  assert.deepEqual(secrets.names(), []);
});

test('history, receipts and finished records are pruned by age while recent events and unfinished work stay', async t => {
  const owned = temporary(t, 'devmate-retention-'), store = new Store(path.join(owned.directory, 'instance'));
  owned.close = () => store.close();
  const finished = store.create('job', { kind: 'command', status: 'completed' }), running = store.create('job', { kind: 'command', status: 'running' });
  const answered = store.create('approval', { status: 'resolved' }), waiting = store.create('approval', { status: 'pending' });
  for (let index = 0; index < 26; index++) store.event('fixture.old', null, { index });
  store.saveOperation('owner:done', 'x', 'f', { value: 1 }); store.saveOperation('owner:pending', 'x', 'f', { pending: true });
  const past = new Date(Date.now() - 40 * 86400000).toISOString();
  store.db.prepare('UPDATE events SET created_at=?').run(past); store.db.prepare('UPDATE operations SET created_at=?').run(past);
  store.db.prepare("UPDATE entities SET data=json_set(data,'$.updatedAt',?)").run(past);
  const fresh = store.create('job', { kind: 'command', status: 'completed' });
  for (let index = 0; index < 4; index++) store.event('fixture.new', null, { index });
  assert.equal(store.revision, 35);
  assert.deepEqual(store.prune({ olderThanMs: 30 * 86400000, keepLatestEvents: 10 }), { events: 25, operations: 2, entities: 2 });
  assert.equal(store.events({ limit: 100 }).length, 10, 'the newest events survive regardless of age so clients can resume');
  assert.equal(store.operation('owner:done'), null);
  assert.equal(store.operation('owner:pending'), null, 'a receipt still pending after the whole retention period belongs to a call that never finished');
  for (const [kind, item] of [['job', running], ['approval', waiting], ['job', fresh]]) assert.equal(store.get(kind, item.id).id, item.id, 'unfinished and recent records stay');
  for (const [kind, item] of [['job', finished], ['approval', answered]]) assert.throws(() => store.get(kind, item.id), { code: 'not_found' });
  assert.deepEqual(store.prune({ olderThanMs: 30 * 86400000 }), { events: 0, operations: 0, entities: 0 });
  assert.throws(() => store.prune({}), TypeError);
  assert.equal(normalizeConfig({}).retentionDays, 30); assert.throws(() => normalizeConfig({ retentionDays: 0 }));
  // Recent activity is the newest of one scope, however busy other scopes are.
  const project = store.create('project', { name: 'p', root: owned.directory });
  for (const marker of ['first', 'second']) store.event('fixture.project', { id: 'x', projectId: project.id }, { marker });
  for (let index = 0; index < 150; index++) store.event('fixture.other', null, { index });
  assert.deepEqual(store.recentEvents({ projectId: project.id, limit: 100 }).map(event => event.marker), ['first', 'second']);
  assert.equal(store.recentEvents({ limit: 3 }).length, 3);
});

test('the doctor names what works, what is missing and the exact next step', async t => {
  const local = await service(t, {});
  const quiet = await local.service.call('runtime.doctor', {}, owner);
  const find = (report, id) => report.checks.find(item => item.id === id);
  assert.equal(find(quiet, 'node').status, 'ok'); assert.equal(find(quiet, 'shell').status, 'ok');
  assert.equal(find(quiet, 'connection').status, 'info'); assert.match(find(quiet, 'connection').fix, /devmate connect openai-tunnel --tunnel-id <id>/); assert.match(find(quiet, 'connection').fix, /devmate relay setup user@host/);
  assert.equal(find(quiet, 'projects').status, 'warn'); assert.equal(find(quiet, 'security').status, 'ok');
  const exposed = await service(t, { connection: { kind: 'cloudflare', publicUrl: 'https://devmate.example.com/mcp', executable: process.execPath } },
    { verifier: async () => ({ verified: false, reachable: false, reason: 'ENOTFOUND' }) });
  exposed.service.connection = { status: () => ({ kind: 'cloudflare', phase: 'connecting', routeService: 'http://127.0.0.1:8789' }) };
  const report = await exposed.service.call('runtime.doctor', {}, owner);
  assert.equal(report.status, 'fail');
  assert.equal(find(report, 'connection.executable').status, 'ok');
  assert.equal(find(report, 'connection.credential').status, 'fail'); assert.match(find(report, 'connection.credential').fix, /devmate secret set CLOUDFLARE_TUNNEL_TOKEN/);
  assert.equal(find(report, 'connection.public').status, 'fail'); assert.match(find(report, 'connection.public').fix, /route the hostname to http:\/\/127\.0\.0\.1:8789/);
  assert.equal(find(report, 'security').status, 'warn'); assert.match(find(report, 'security').fix, /oauth, issuer https:\/\/devmate\.example\.com\).*devmate login-code/);
  await exposed.service.call('secret.set', { name: 'CLOUDFLARE_TUNNEL_TOKEN', value: 't' }, owner);
  exposed.service.verifier = async () => ({ verified: true, reachable: true, tools: 70 }); exposed.service.verification = null;
  exposed.service.connection = { status: () => ({ kind: 'cloudflare', phase: 'connected' }) };
  const healthy = await exposed.service.call('runtime.doctor', {}, owner);
  assert.equal(find(healthy, 'connection.credential').status, 'ok'); assert.equal(find(healthy, 'connection.public').status, 'ok');
  // A relay whose address is not reached while ssh runs: the line about the process is in order, and the remedy of a
  // line in order is not shown anywhere. So what OpenSSH said last stands in the line that needs it, not in a pointer
  // to one that shows nothing.
  const relayed = await service(t, { connection: { kind: 'ssh', publicUrl: 'https://devmate.example.com/mcp/' + 'k'.repeat(32), executable: process.execPath, host: '203.0.113.7', user: 'deploy', relay: true } },
    { verifier: async () => ({ verified: false, reachable: false, reason: 'no answer' }) });
  relayed.service.connection = { status: () => ({ kind: 'ssh', phase: 'connected', diagnostic: 'debug1: Connecting to 203.0.113.7\r\nWarning: remote port forwarding failed for listen port 18443\n' }) };
  const stuck = await relayed.service.call('runtime.doctor', {}, owner);
  assert.equal(find(stuck, 'connection.process').status, 'ok');
  // (An entry is one line, also where what a program said had several: nothing in it begins a line of its own.)
  assert.deepEqual([find(stuck, 'connection.public').status, find(stuck, 'connection.public').fix], ['fail', 'devmate restart opens the forward to the relay again. What OpenSSH said last: debug1: Connecting to 203.0.113.7 Warning: remote port forwarding failed for listen port 18443']);
  relayed.service.connection = { status: () => ({ kind: 'ssh', phase: 'connected' }) }; relayed.service.verification = null;
  assert.equal(find(await relayed.service.call('runtime.doctor', {}, owner), 'connection.public').fix, 'devmate restart opens the forward to the relay again.');
  assert.equal(healthy.status, 'warn', 'a verified but unauthenticated public URL is still a warning');
  // The CLI prints the same report and fails the command only when something is broken.
  const lines = [];
  const code = await cli(['doctor'], { stdout: { write: text => lines.push(text) }, stderr: { write() {} }, clientFactory: () => ({ call: async () => report }) });
  assert.equal(code, 1); assert.match(lines.join(''), /\[FAIL\] connection\.credential: CLOUDFLARE_TUNNEL_TOKEN is missing\n\s+-> Store it with: devmate secret set CLOUDFLARE_TUNNEL_TOKEN/);
  assert.equal(await cli(['doctor'], { stdout: { write() {} }, stderr: { write() {} }, clientFactory: () => ({ call: async () => healthy }) }), 0);
});

test('a shared folder that was moved or deleted is said to be that: by the call that needs it, by the doctor and where projects are named', async t => {
  const { service: runtime, temp } = await service(t, {});
  const { serverInstructions } = await import('../runtime/mcp.mjs');
  const connected = { id: 'owner' }, kept = path.join(temp, 'kept'), moved = path.join(temp, 'moved');
  for (const folder of [kept, moved]) { fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'a.txt'), 'a'); }
  await runtime.call('project.create', { root: kept, name: 'kept' }, owner);
  const project = await runtime.call('project.create', { root: moved, name: 'moved' }, owner);
  const find = async id => (await runtime.call('runtime.doctor', {}, owner)).checks.find(item => item.id === id);
  const flow = await runtime.call('workflow.create', { projectId: project.id, title: 'Before it moved' }, owner);
  assert.match(serverInstructions(runtime), new RegExp(project.id + ' = moved \\(.*, write\\);'));
  assert.equal(await find('projects.missing'), undefined);
  fs.renameSync(moved, path.join(temp, 'elsewhere'));
  // What is said of a folder where projects are named for a model is what was seen last: that is on every request,
  // and the file system is not asked there. Fifty of them look at nothing.
  const look = fs.promises.lstat;
  let looks = 0;
  fs.promises.lstat = (...args) => { looks++; return look(...args); };
  try { for (let request = 0; request < 50; request++) assert.match(serverInstructions(runtime), new RegExp(project.id + ' = moved \\(.*, write\\);')); } finally { fs.promises.lstat = look; }
  assert.equal(looks, 0);
  // Where the projects are listed the folders are looked at for the answer, so the list is true when it is given,
  // and what is said elsewhere is true from then on: no call has to have met the missing folder first.
  const listed = async () => Object.fromEntries((await runtime.call('project.list', {}, connected)).items.map(item => [item.name, item.missing]));
  assert.deepEqual(await listed(), { kept: undefined, moved: true });
  assert.match(serverInstructions(runtime), new RegExp(project.id + ' = moved \\(.*, folder not there\\);'));
  // Each call that needs the folder says what happened to it and what is done about it, instead of a bare ENOENT.
  // What is done differs: a drive is connected again and nothing is lost; taking the project off the list takes what
  // is kept for it as well, and is said to, in full.
  const takingOff = 'Taking a project off the list also removes what DevMate keeps for it: its workflows, tasks, agents and their messages, approvals and questions, jobs with their output, references and artifacts, ' +
    'and the copies agents worked in that were not applied (of such a copy the repository, wherever it is now, keeps its note of the worktree and the branch devmate/copy-…: there, "git worktree prune" and then "git branch -D devmate/copy-…" remove them). ' +
    'An editor then no longer shares the folder at the old place by itself.';
  const said = 'The folder of this project is not there: ' + project.root + '. If it is on a disk or a share that is not connected right now, connect it and call again; nothing has to be removed for that. ' +
    'If it was moved, renamed or deleted, its owner takes the project off the list (devmate project remove ' + project.id + ') ' +
    'and shares the folder where it is now (devmate project add <folder>). ' + takingOff;
  for (const [operation, input] of [['workspace.read', { path: 'a.txt' }], ['workspace.files', {}], ['workspace.write', { path: 'b.txt', text: 'b' }], ['git.status', {}], ['project.overview', {}], ['shell.run', { file: process.execPath, args: ['-v'] }],
    // A coding agent and an engine start their programs in that folder: refused the same way, before anything is made
    // for the task (started all the same, the program fails for want of a folder, which reads as if it were not installed).
    ['agents.delegate', { provider: 'codex', prompt: 'x', waitMs: 0 }], ['agents.delegate', { provider: 'codex', prompt: 'x', isolate: true, waitMs: 0 }],
    ['agents.start', { workflowId: flow.id, provider: 'codex' }], ['agents.start', { workflowId: flow.id, provider: 'codex', prompt: 'x' }], ['capability.list', { engine: 'godot' }]])
    await assert.rejects(runtime.call(operation, { projectId: project.id, ...input }, connected), { code: 'project_missing', message: said }, operation);
  assert.deepEqual([runtime.store.count('workflow', { projectId: project.id }), runtime.store.count('agent', { projectId: project.id }), runtime.store.count('approval', { projectId: project.id })], [1, 0, 0], 'nothing was made for the agent, and the owner is not asked about a task that cannot start');
  assert.equal((await runtime.call('workspace.read', { projectId: 'kept', path: 'a.txt' }, connected)).text, 'a', 'the other project works as before');
  // A job for an engine in that project is one that never started, and says so: nothing is left to be looked into.
  const job = await runtime.call('job.start', { projectId: project.id, kind: 'capability', input: { capability: 'godot.diagnose', input: {} } }, owner);
  let ended = job;
  for (let round = 0; round < 200 && ['queued', 'running'].includes(ended.status); round++) { await new Promise(resolve => setTimeout(resolve, 25)); ended = await runtime.call('job.read', { id: job.id }, owner); }
  assert.deepEqual([ended.status, ended.outcome, ended.error?.code], ['failed', 'not_started', 'project_missing']);
  assert.deepEqual(await listed(), { kept: undefined, moved: true });
  // Where a call has to say which project it means, the one that is gone is marked.
  await assert.rejects(runtime.call('workspace.write', { path: 'b.txt', text: 'b' }, connected), error => error.code === 'project_required' && error.message.includes(' = kept;') && error.message.endsWith(project.id + ' = moved (its folder is not there)'));
  assert.match(serverInstructions(runtime), new RegExp(project.id + ' = moved \\(.*, folder not there\\);'));
  assert.match(serverInstructions(runtime), / = kept \(.*, write\);/);
  const missing = await find('projects.missing');
  assert.equal(missing.status, 'warn');
  assert.equal(missing.detail, 'The folder of 1 project(s) is not there: "moved" at ' + project.root);
  assert.equal(missing.fix, 'Where the folder is on a drive or a share that is not connected right now, connect it: nothing has to be removed. Where it was moved, renamed or deleted, take the project off the list ' +
    '(devmate project remove <id, name or folder>) and share the folder where it is now (devmate project add <folder>). ' + takingOff);
  // At the computer the command line lists it marked as well.
  const printed = [];
  assert.equal(await cli(['project', 'list'], { stdout: { write: text => printed.push(text) }, stderr: { write() {} }, clientFactory: () => ({ call: (name, input) => runtime.call(name, input, owner) }) }), 0);
  assert.deepEqual(JSON.parse(printed.join('')).map(item => [item.name, item.missing]), [['kept', undefined], ['moved', true]]);
  // A call for the project that goes through without its folder (it reads what DevMate keeps) does not take the mark
  // off: the folder is looked at, and it is still not there.
  await runtime.call('workspace.history', { projectId: project.id }, connected);
  assert.match(serverInstructions(runtime), new RegExp(project.id + ' = moved \\(.*, folder not there\\);'));
  // Put back where it was (a drive that is connected again), the project works with everything it had, and the first
  // call for it that goes through takes the mark off at once, wherever it is said: a model that has just read a file
  // there is not told that the folder is not there.
  const elsewhere = path.join(temp, 'elsewhere');
  fs.renameSync(elsewhere, moved);
  assert.equal((await runtime.call('workspace.read', { projectId: project.id, path: 'a.txt' }, connected)).text, 'a');
  assert.match(serverInstructions(runtime), new RegExp(project.id + ' = moved \\(.*, write\\);'));
  assert.deepEqual(await listed(), { kept: undefined, moved: undefined });
  assert.equal(await find('projects.missing'), undefined);
  // Gone again and back again with no call in between that used it: the list alone takes the mark, and takes it off.
  fs.renameSync(moved, elsewhere);
  assert.deepEqual(await listed(), { kept: undefined, moved: true });
  fs.renameSync(elsewhere, moved);
  assert.deepEqual(await listed(), { kept: undefined, moved: undefined });
  assert.match(serverInstructions(runtime), new RegExp(project.id + ' = moved \\(.*, write\\);'));
  // The doctor answers from the same look: what it says and what the list says are never two things.
  fs.renameSync(moved, elsewhere);
  assert.equal((await find('projects.missing')).detail, 'The folder of 1 project(s) is not there: "moved" at ' + project.root);
  assert.match(serverInstructions(runtime), new RegExp(project.id + ' = moved \\(.*, folder not there\\);'));
  // It is taken off the list although its folder is gone, and nothing is said of it afterwards.
  assert.equal((await runtime.call('project.remove', { id: project.id }, owner)).removed, true);
  assert.equal(await find('projects.missing'), undefined);
});

test('a runtime that starts while a shared folder is gone says so from its first answer; a folder that does not answer is named and not waited for twice; a drive that is not connected is said to be that', async t => {
  const owned = temporary(t, 'devmate-doctor-'), temp = owned.directory, instanceRoot = path.join(temp, 'instance');
  const { serverInstructions } = await import('../runtime/mcp.mjs');
  let runtime = new DevMateService({ instanceRoot, endpoint: '', config: {} });
  owned.close = () => runtime.close();
  await runtime.ready;
  const folders = Object.fromEntries(['kept', 'away', 'slow'].map(name => { const folder = path.join(temp, name); fs.mkdirSync(folder); return [name, folder]; }));
  const projects = {};
  for (const [name, root] of Object.entries(folders)) projects[name] = await runtime.call('project.create', { root, name }, owner);
  await runtime.close();
  // The folder went while nothing ran (a drive that is connected later, a folder that was moved meanwhile).
  fs.renameSync(folders.away, path.join(temp, 'elsewhere'));
  runtime = new DevMateService({ instanceRoot, endpoint: '', config: {} });
  await runtime.ready;
  // The first thing a client is told names the projects, and a session keeps it: it is true from the start.
  assert.match(serverInstructions(runtime), new RegExp(projects.away.id + ' = away \\(.*, folder not there\\);'));
  assert.match(serverInstructions(runtime), new RegExp(projects.kept.id + ' = kept \\(.*, write\\);'));
  const listed = async () => Object.fromEntries((await runtime.call('project.list', {}, { id: 'owner' })).items.map(item => [item.name, item.missing]));
  assert.deepEqual(await listed(), { kept: undefined, away: true, slow: undefined });

  // A folder on a share that does not answer: whoever lists the projects waits for it up to a bound, once, and is
  // given it as it was last seen; the doctor names it instead of waiting for the system to give up.
  const look = fs.promises.lstat;
  // (The bound is a second here, and what must not happen again is a wait of that length: a computer that is busy
  // with other tests has room on both sides.)
  runtime.folderWaitMs = 1000;
  fs.promises.lstat = target => target === projects.slow.root ? new Promise(() => {}) : look(target);
  try {
    let began = Date.now();
    assert.deepEqual(await listed(), { kept: undefined, away: true, slow: undefined });
    assert.ok(Date.now() - began >= 900 && Date.now() - began < 10000, 'waited for the bound: ' + (Date.now() - began) + ' ms');
    await new Promise(resolve => setTimeout(resolve, 100));
    began = Date.now();
    assert.deepEqual(await listed(), { kept: undefined, away: true, slow: undefined });
    assert.ok(Date.now() - began < 600, 'a look that has not answered for longer than the bound is not waited for again: ' + (Date.now() - began) + ' ms');
    const checks = (await runtime.call('runtime.doctor', {}, owner)).checks, unanswered = checks.find(item => item.id === 'projects.unanswered');
    assert.deepEqual([unanswered.status, unanswered.detail], ['warn', 'The folder of 1 project(s) has not answered when it was looked for: "slow" at ' + projects.slow.root]);
    // Nothing is to be removed for it: a project that is taken off the list does not come back with the share.
    assert.equal(unanswered.fix, 'That is a share or a drive that hangs. Connect it again, or wait for it: nothing has to be removed. Until it answers, calls for such a project wait for it as long as the system does.');
    assert.equal(checks.find(item => item.id === 'projects.missing').detail, 'The folder of 1 project(s) is not there: "away" at ' + projects.away.root);
  } finally { fs.promises.lstat = look; }

  // A drive letter that is not there at all (Windows): connecting it is the whole remedy, and removing is not offered.
  if (process.platform === 'win32') {
    const letter = [...'ZYXWVUTSRQ'].find(one => !fs.existsSync(one + ':\\'));
    if (letter) {
      const root = letter + ':\\devmate-not-connected\\project';
      runtime.store.update('project', projects.kept.id, { root });
      await assert.rejects(runtime.call('workspace.read', { projectId: projects.kept.id, path: 'a.txt' }, { id: 'owner' }), error => error.code === 'project_missing' && error.details?.driveMissing === true &&
        error.message === 'The folder of this project is on a drive that is not connected: ' + root + '. Connect the drive and call again; nothing has to be removed for that.');
    }
  }
});

test('what the command line writes for the owner to read holds no character a terminal acts on, whoever chose the words', async t => {
  const { service: runtime, temp } = await service(t, {});
  const connected = { id: 'owner' }, code = number => String.fromCharCode(number);
  const esc = code(0x1b), bel = code(7), csi = code(0x9b), del = code(0x7f), turned = code(0x202e), back = code(13);
  const folder = path.join(temp, 'gone'); fs.mkdirSync(folder);
  const project = await runtime.call('project.create', { root: folder, name: 'plain' }, owner);
  // A client may name a project, in the guarded profile too. This name moves the cursor up, wipes the line, writes
  // one of its own, makes a link the terminal's way, and begins another line: all of it where the doctor names the
  // project because its folder is gone.
  const name = 'x' + esc + '[1A' + esc + '[2K[ ok ] security: nothing to do ' + esc + ']8;;https://example.com' + bel + 'here' + esc + ']8;;' + bel + csi + '2K' + del + turned + back + '\n[ ok ] forged: line';
  await runtime.call('project.update', { id: project.id, name }, connected);
  fs.rmSync(folder, { recursive: true });
  // (A name too short to be taken out of a report as a name, with a line end in it.)
  const short = path.join(temp, 'short'); fs.mkdirSync(short);
  await runtime.call('project.create', { root: short, name: 'p\nq' }, owner);
  fs.rmSync(short, { recursive: true });
  // And it asks for an operation by a name that is kept among the recent failures, for the report.
  await assert.rejects(runtime.call('operations.call', { operation: 'no' + esc + '[2Ksuch\n[ ok ] forged: line', input: {} }, connected), { code: 'unknown_operation' });
  fs.appendFileSync(path.join(temp, 'instance', 'runtime.log'), 'a line a program wrote ' + esc + '[31mred' + esc + '[0m\n');
  const run = async args => { const written = []; const exit = await cli([...args, '--instance', path.join(temp, 'instance')], { stdout: { write: text => written.push(text) }, stderr: { write: text => written.push(text) },
    clientFactory: () => ({ call: (operation, input) => runtime.call(operation, input, owner) }) }); return { exit, text: written.join('') }; };
  const none = (text, what) => { for (const [one, called] of [[esc, 'ESC'], [bel, 'BEL'], [csi, 'CSI'], [del, 'DEL'], [turned, 'a character that turns the line'], [back, 'a carriage return']]) assert.equal(text.includes(one), false, what + ' holds ' + called); };
  const doctor = await run(['doctor']);
  none(doctor.text, 'the doctor');
  // The doctor gives a name as a name: in quotes it cannot close, on one line, without those characters, cut short.
  const given = 'x[1A[2K[ ok ] security: nothing to do ]8;;https://example.comhere]8;;2K [ ok ] forged: line'.slice(0, 60);
  assert.ok(doctor.text.includes('[warn] projects.missing: The folder of 2 project(s) is not there: "' + given + '" at '), doctor.text);
  assert.ok(doctor.text.includes('; "p q" at '), 'an entry stays on its one line');
  assert.equal(doctor.text.split('\n').some(line => line.startsWith('[ ok ] forged')), false, 'no line of the report is one the name wrote');
  // The answer itself is made that way, so every place that shows it has it: an editor's output and a side panel too.
  const checked = (await runtime.call('runtime.doctor', {}, owner)).checks;
  for (const item of checked) assert.equal(/[\r\n]/.test(item.detail + (item.fix || '')), false, item.id);
  const report = await run(['doctor', '--report']);
  none(report.text, 'the report');
  assert.ok(report.text.includes('Unknown DevMate operation: no\\u001b[2Ksuch [ ok ] forged: line'));
  assert.equal(report.text.split('\n').some(line => line.startsWith('[ ok ] forged')), false);
  assert.ok(report.text.includes('; "p q" at ') && !report.text.split('\n').some(line => line.startsWith('q" at ')), 'an entry of the report stays on its one line');
  // A report is made to be shared: the name of a project is taken out of it, also as the doctor says it. (What a name
  // may hold and still leave the report its own words is a test of its own below.)
  assert.ok(/\[warn\] projects\.missing: The folder of 2 project\(s\) is not there: "<folder-\d>" at <folder-\d>; "p q" at <folder-\d>\n/.test(report.text), report.text);
  // What is printed as JSON says the same characters by their numbers, and reads back as the name it is.
  const listed = await run(['project', 'list']);
  none(listed.text, 'the list');
  assert.equal(JSON.parse(listed.text)[0].name, name);
  const logs = await run(['logs']);
  none(logs.text, 'the log');
  assert.ok(logs.text.includes('a line a program wrote \\u001b[31mred\\u001b[0m'));
});

test('the doctor says when the shell is there and runs nothing', async t => {
  const { service: runtime } = await service(t, {});
  const find = async id => (await runtime.call('runtime.doctor', {}, owner)).checks.find(item => item.id === id);
  // Asked only where a command is a script the shell is started with, and said only when it fails.
  if (runtime.processes.shell.kind !== 'powershell') assert.equal(await find('shell.run'), undefined);
  runtime.processes.shell.kind = 'powershell';
  let asked = 0;
  runtime.processes.tryShell = async () => { asked++; return { ok: true }; };
  assert.equal(await find('shell.run'), undefined); assert.equal(asked, 1);
  runtime.processes.tryShell = async () => ({ ok: false, reason: 'File C:\\x.ps1 cannot be loaded because running scripts is disabled on this system. + FullyQualifiedErrorId : UnauthorizedAccess' });
  const refused = await find('shell.run');
  assert.equal(refused.status, 'fail');
  assert.match(refused.detail, / did not run a one-line command: File C:\\x\.ps1 cannot be loaded because running scripts is disabled/);
  assert.match(refused.fix, /^A policy on this computer forbids PowerShell to run scripts .*Get-ExecutionPolicy -List/);
  runtime.processes.tryShell = async () => ({ ok: false, reason: 'it did not end within 10 seconds' });
  assert.match((await find('shell.run')).fix, /^No command runs through DevMate until the shell does\./);
  assert.equal((await runtime.call('runtime.doctor', {}, owner)).status, 'fail');
});

test('the report for a bug says what happened and not who or where: no credentials, paths, account names or addresses', async t => {
  const { anonymize } = await import('../runtime/report.mjs');
  const home = process.platform === 'win32' ? 'C:\\Users\\Maria Example' : '/home/maria';
  const sample = [
    'instance at ' + path.join(home, '.devmate', 'runtime') + ' and as JSON ' + JSON.stringify(path.join(home, 'work', 'shop')),
    'a second account: ' + (process.platform === 'win32' ? 'C:\\Users\\other\\file.txt' : '/home/other/file.txt') + ' and /Users/third/x',
    'reached at https://calm-river.trycloudflare.com/mcp/abcdefghijklmnopqrstuvwxyz012345 and https://devmate.example.com/mcp from 203.0.113.9, locally at 127.0.0.1:8788',
    'git push https://maria:hunter2@github.com/x/y with --token s3cr3t-value and GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 by maria@example.com',
    'the project Acme Billing failed at 10:15:42 from 2001:db8:85a3::8a2e:370:7334 and fe80::1, std::string and a::b::c stay code'
  ].join('\n');
  const clean = anonymize(sample, { home, places: [[path.join(home, 'work', 'shop'), '<folder-1>']], names: [['Acme Billing', '<folder-1>'], ['app', '<folder-2>']], hosts: ['devmate.example.com'] });
  assert.match(clean, /the project <folder-1> failed at 10:15:42 from <address> and <address>, std::string and a::b::c stay code/);
  for (const kept of ['Maria', 'maria', 'other', 'third', 'calm-river', 'abcdefghijklmnopqrstuvwxyz012345', 'devmate.example.com', '203.0.113.9', 'hunter2', 's3cr3t-value', 'ghp_', 'shop']) assert.ok(!clean.includes(kept), kept + ' is still in: ' + clean);
  assert.match(clean, /instance at ~[\\/]\.devmate[\\/]runtime and as JSON "<folder-1>"/); assert.match(clean, /https:\/\/<assigned>\.trycloudflare\.com\/mcp\/<key>/);
  assert.match(clean, /https:\/\/<public-host>\/mcp from <address>, locally at 127\.0\.0\.1:8788/); assert.match(clean, /by <email>/);

  // The whole report, from a runtime that shares a folder and has seen a failure.
  const { service: runtime, temp } = await service(t, { connection: { kind: 'cloudflare', publicUrl: 'https://devmate.example.com/mcp', executable: process.execPath } });
  const root = path.join(temp, 'A Private Folder Name'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'a.txt'), 'x');
  const project = await runtime.call('project.create', { root }, owner);
  await runtime.call('workspace.read', { projectId: project.id, path: 'a.txt' }, { id: 'owner' });
  await assert.rejects(runtime.call('workspace.read', { projectId: project.id, path: 'missing-file.txt' }, { id: 'owner' }));
  fs.writeFileSync(path.join(temp, 'instance', 'runtime.log'), '2026-10-11T10:00:00.000Z connection: could not reach devmate.example.com from ' + root + '\n');
  const { text } = await runtime.call('runtime.report', {}, owner);
  assert.match(text, /^DevMate report\. Credentials, private paths, account names and addresses were taken out as far as they can be recognised: read it before you share it\./);
  assert.match(text, /Connection: cloudflare · sign-in: none · profile: guarded/); assert.match(text, /Shared folders: 1 \(1 read and write, 0 read only\)/);
  assert.match(text, /\n\[FAIL\] connection\.credential: CLOUDFLARE_TUNNEL_TOKEN is missing/); assert.match(text, /\nworkspace\.read {2}2 \(2\) {2}1 {2}\d+ {2}\d+ {2}\d+ {2}\w+×1\n/);
  assert.match(text, /\n#\d+ \S+ workspace\.read \w+ \(connected, \d+ ms\): /); assert.match(text, /connection: could not reach <public-host> from <folder-1>/);
  // A failure names its project; the report says which folder that was, not what it is called.
  await runtime.call('project.update', { id: project.id, name: 'Client Secret Product' }, owner);
  await assert.rejects(runtime.call('workspace.read', { projectId: 'Client Secret Product', path: 'missing-file.txt' }, { id: 'owner' }));
  fs.appendFileSync(path.join(temp, 'instance', 'runtime.log'), '2026-10-11T10:00:01.000Z agent: turn failed in Client Secret Product\n');
  const named = (await runtime.call('runtime.report', {}, owner)).text;
  assert.match(named, /agent: turn failed in <folder-1>/); assert.ok(!named.includes('Client Secret Product'));
  for (const kept of ['A Private Folder Name', 'devmate.example.com', temp, path.basename(os.homedir()) + path.sep]) assert.ok(!text.includes(kept), kept + ' is still in the report');
  // It is the owner's to make at this computer; with full access their client may read it as well.
  await assert.rejects(runtime.call('runtime.report', {}, { id: 'owner' }), { code: 'forbidden' });
  // The command prints exactly that, and without a runtime what can be seen from outside.
  const printed = [];
  assert.equal(await cli(['doctor', '--report'], { stdout: { write: value => printed.push(value) }, stderr: { write() {} }, clientFactory: () => ({ call: async name => { assert.equal(name, 'runtime.report'); return { text }; } }) }), 0);
  assert.equal(printed.join(''), text + '\n');
  const offline = [];
  assert.equal(await cli(['doctor', '--report', '--instance', path.join(temp, 'instance')], { stdout: { write: value => offline.push(value) }, stderr: { write() {} },
    clientFactory: () => ({ call: async () => { throw Object.assign(new Error('stopped'), { code: 'RUNTIME_STOPPED' }); } }) }), 0);
  // The folders an instance shares are read from its state, so that a log line does not give their names away.
  assert.match(offline.join(''), /the runtime is not running/); assert.match(offline.join(''), /could not reach \S+ from <folder-1>/);
  assert.ok(!offline.join('').includes(temp) && !offline.join('').includes('A Private Folder Name'), 'neither the instance directory nor a shared folder is spelled out');
});

test('a report keeps its own words and gives nothing away, whatever a project is called', async t => {
  const { anonymize } = await import('../runtime/report.mjs');
  // What gives somebody away is taken out before a name is: a name may be a part of it, and may not keep the rest.
  assert.equal(anonymize('from bob@acme.com', { names: [['acme', '<folder-1>']] }), 'from <email>');
  // A name finds nothing in what was put in: not in what a rule put in, and not in what stands for another name.
  assert.equal(anonymize('mail of maria@example.com for Acme Shop, folder and address', { names: [['Acme Shop', '<folder-1>'], ['folder', '<folder-2>'], ['email', '<folder-3>'], ['address', '<folder-4>']] }),
    'mail of <email> for <folder-1>, <folder-2> and <folder-4>');
  // A name is a word where it begins or ends with a letter, and stands anywhere where it does not.
  assert.equal(anonymize('AcmeCorp, Acme-Corp, x[beta]y and a/shop/b', { names: [['Acme', '<folder-1>'], ['[beta]', '<folder-2>'], ['/shop', '<folder-3>']] }), 'AcmeCorp, <folder-1>-Corp, x<folder-2>y and a<folder-3>/b');
  assert.equal(anonymize('five     blanks', { names: [['     ', '<folder-1>']] }), 'five     blanks');
  // A public host is a word somebody chose as well, and goes after the addresses for the same reason: before them,
  // the account on the owner's own server was left standing before the @ (what OpenSSH says of a relay it cannot reach).
  assert.equal(anonymize('ssh: deploy@relay.example.com: Permission denied (publickey). Asked Relay.Example.com:22', { hosts: ['relay.example.com'] }), 'ssh: <email>: Permission denied (publickey). Asked <public-host>:22');
  // A host that is an address with a port, or one a quick tunnel was given, does not stand there either way.
  assert.equal(anonymize('at 203.0.113.9:8443 and calm-river.trycloudflare.com', { hosts: ['203.0.113.9:8443', 'calm-river.trycloudflare.com'] }), 'at <address>:8443 and <assigned>.trycloudflare.com');
  // Nor does a host find anything in what was put in, for an address or for another host; and of two hosts the longer
  // goes first, so that one is not left as a part of the other.
  assert.equal(anonymize('carol@example.org, mail, host and relay.host', { hosts: ['mail', 'host', 'relay', 'relay.host'] }), '<email>, <public-host>, <public-host> and <public-host>');
  // The address a quick tunnel was given is put in whole, the part that every such address has with it.
  assert.equal(anonymize('at calm-river.trycloudflare.com for trycloudflare', { names: [['trycloudflare', '<folder-1>']] }), 'at <assigned>.trycloudflare.com for <folder-1>');
  // What stands for a credential is put in as well, and no name is found in it.
  assert.equal(anonymize('Authorization: Bearer abcdefghijklmnop for redacted', { names: [['redacted', '<folder-1>']] }), 'Authorization: Bearer [redacted] for <folder-1>');

  const { service: runtime, temp } = await service(t, { connection: { kind: 'cloudflare', publicUrl: 'https://devmate.example.com/mcp', executable: process.execPath } });
  const connected = { id: 'owner' }, key = 'abcdefghijklmnopqrstuvwxyz012345', special = 'a.b*c(d)[e]+?';
  const make = async folder => { const root = path.join(temp, folder); fs.mkdirSync(root); const project = await runtime.call('project.create', { root, name: 'zz' }, owner); fs.rmSync(root, { recursive: true }); return project; };
  const first = await make('one'), second = await make('two');
  fs.writeFileSync(path.join(temp, 'instance', 'runtime.log'), '2026-10-12T10:00:00.000Z connection: mail from bob@acme.com and carol@gmail.com at 203.0.113.9, https://devmate.example.com/mcp and https://calm-river.trycloudflare.com/mcp/' + key + ' in ' + first.root +
    '\n2026-10-12T10:00:01.000Z agent: axbcde and ' + special + ' are two\n');
  const HEADINGS = ['DevMate report. Credentials, private paths, account names and addresses were taken out as far as they can be recognised: read it before you share it.', 'Checks',
    'Operations since the start: name, calls (through MCP), failed, ms for half of the calls, for 19 in 20, slowest', 'Recent failures, newest first', 'Runtime log, last lines'];
  const ENTRY = /^\[( ok |info|warn|FAIL)\] [a-z][\w.-]*: /;
  // The report's own words: its first lines (about the computer and the settings), its headings, and the mark and the
  // id of every entry, with the arrow of what is to be done about it.
  const own = text => { const lines = text.split('\n'); return [...lines.slice(0, 5).map(line => line.replace(/ · up \d+ min$/, '')), ...lines.slice(5).map(line => HEADINGS.includes(line) ? line : ENTRY.exec(line)?.[0] ?? (line.startsWith('       -> ') ? '->' : null)).filter(Boolean)]; };
  // And all the rest: what an entry says, a failure after the operation it was a failure of, a line of the log.
  const content = text => text.split('\n').slice(5).filter(line => !HEADINGS.includes(line)).map(line => line.replace(ENTRY, '').replace(/^#\d+ \S+ \S+ /, '')).join('\n');
  const report = async (name, other = 'zz') => {
    await runtime.call('project.update', { id: first.id, name }, connected);
    await runtime.call('project.update', { id: second.id, name: other }, connected);
    await runtime.call('operations.call', { operation: name, input: {} }, connected).catch(() => {});
    return (await runtime.call('runtime.report', {}, owner)).text;
  };
  const plain = await report('zz'), words = own(plain), logged = text => { const lines = text.split('\n'); return lines.slice(lines.indexOf('Runtime log, last lines') + 1); };
  const [, where] = /in (<folder-\d>)$/m.exec(plain);
  assert.deepEqual(logged(plain), ['2026-10-12T10:00:00.000Z connection: mail from <email> and <email> at <address>, https://<public-host>/mcp and https://<assigned>.trycloudflare.com/mcp/<key> in ' + where,
    '2026-10-12T10:00:01.000Z agent: axbcde and ' + special + ' are two']);
  assert.ok(words.includes('Checks') && words.includes('[ ok ] node: ') && words.includes('[warn] projects.missing: ') && words.includes('->'), words.join('\n'));

  const long = name => name.trim().length > 3, said = name => name.replace(/\s+/g, ' '), shown = name => '"' + (long(name) ? said(name).replace(said(name).trim(), '<f>') : said(name)) + '" at <f>';
  const account = os.userInfo().username, segment = path.basename(path.dirname(os.homedir()));
  for (const [name, other = 'zz'] of [['[FAIL]'], ['\n[FAIL]'], ['[FAIL] connection.public'], ['ok ] node'], ['FAIL] connection.public'], ['(none)\n\nRuntime log'], ['Checks'], [' Checks\n'], ['DevMate'], ['ok'], ['a'],
    ['Acme', 'Acme Shop'], ['folder', 'Acme Shop'], [special], [account], [segment], ['acme'], ['gmail'], ['/mcp'], ['     '], ['my-app']].filter(([name]) => name)) {
    const text = await report(name, other), what = JSON.stringify(name), lines = text.split('\n');
    assert.deepEqual(own(text), words, what + ': the report\'s own words are as they were');
    for (const kept of ['bob', 'carol', 'acme.com', 'gmail.com', '203.0.113.9', key, 'calm-river', 'devmate.example.com', temp, path.basename(os.homedir()) + path.sep]) assert.ok(!text.includes(kept), what + ': ' + kept + ' is in the report: ' + text);
    assert.equal(/<folder-\d+>-\d/.test(text), false, what + ': a name was found in what stands for another: ' + text);
    assert.deepEqual(logged(text), logged(plain).map(line => name === '/mcp' ? line.replaceAll('/mcp', where) : name === special ? line.replace(special, where) : line), what);
    const missing = lines.find(line => line.startsWith('[warn] projects.missing: ')).split('is not there: ')[1].replace(/<folder-\d>/g, '<f>').split('; ').sort();
    assert.deepEqual(missing, [shown(name), shown(other)].sort(), what);
    if (!long(name)) continue;
    // The name itself is nowhere in what the report says: the folder it is the name of stands there.
    // (As a word, where it begins or ends as one: "folders" is not the project "folder".)
    const stands = (one, text) => new RegExp((/\w/.test(one[0]) ? '(?<!\\w)' : '') + one.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (/\w/.test(one.at(-1)) ? '(?!\\w)' : '')).test(text);
    for (const one of [name, other].filter(long)) assert.ok(!stands(said(one).trim(), content(text).replace(/<folder-\d>/g, '')), what + ': ' + JSON.stringify(one) + ' is in the report: ' + content(text));
    assert.ok(lines.some(line => /^#\d+ \S+ \S+ \w+ \(connected, \d+ ms\): Unknown .* operation: +<folder-\d> ?$/.test(line)), what + ': the failure says which folder, not what it is called: ' + text);
  }

  // A public address that names a port: its host is taken out as it is written with the port and without it.
  const { service: ported, temp: other } = await service(t, { connection: { kind: 'cloudflare', publicUrl: 'https://devmate.example.com:8443/mcp', executable: process.execPath } });
  fs.writeFileSync(path.join(other, 'instance', 'runtime.log'), 'connection: getaddrinfo ENOTFOUND devmate.example.com, asked for https://devmate.example.com:8443/mcp\n');
  const both = (await ported.call('runtime.report', {}, owner)).text;
  assert.ok(both.endsWith('\nconnection: getaddrinfo ENOTFOUND <public-host>, asked for https://<public-host>/mcp') && !both.includes('devmate.example'), both);
});

test('what a report cuts short it has cleaned first: half of an address, a path or a name is not recognised as what it was', async t => {
  const { service: runtime, temp } = await service(t, {});
  const log = path.join(temp, 'instance', 'runtime.log'), report = async () => (await runtime.call('runtime.report', {}, owner)).text;
  // A line of the log is shown by its first 600 characters. The mail address in this one begins before them and ends after.
  fs.writeFileSync(log, 'x'.repeat(590) + ' dora@private.example and more\n');
  let text = await report();
  assert.ok(text.includes('x'.repeat(590) + ' <email>') && !text.includes('dora@'), text);
  // The log is read from its last 24000 bytes on. Where that begins inside a line, the line is the end of one: here
  // the end of a path, without the part that says it is somebody's home. It is not shown; the lines after it are.
  const end = 'me/zoe-private-account/work\n', filler = 'y'.repeat(479) + '\n', last = 'z'.repeat(24000 - end.length - 49 * filler.length - 1) + '\n';
  fs.writeFileSync(log, 'a line from long ago at /ho' + end + filler.repeat(49) + last);
  assert.equal(fs.statSync(log).size - 24000, 'a line from long ago at /ho'.length);
  text = await report();
  assert.ok(!text.includes('zoe-private-account') && text.includes('\n' + 'y'.repeat(479) + '\n') && text.endsWith('\n' + last.trim()), text);
  // A log that is shorter than that is shown from its first line.
  fs.writeFileSync(log, 'the first line\nthe second\n');
  assert.ok((await report()).endsWith('Runtime log, last lines\nthe first line\nthe second'));
  // The message of a failure is shown by its first 300 characters. This one lists the projects by their names, and
  // the second name begins before the 300th character and ends after it.
  const named = 'Client Secret Product '.repeat(9).trim();
  const made = [];
  for (const [folder, name] of [['one', 'filler '.repeat(21).trim()], ['two', named]]) { const root = path.join(temp, folder); fs.mkdirSync(root); made.push(await runtime.call('project.create', { root, name }, owner)); }
  await assert.rejects(runtime.call('workspace.read', { path: 'a.txt' }, { id: 'owner' }), error => error.code === 'project_required' && error.message.indexOf(named) < 300 && error.message.indexOf(named) + named.length > 300);
  text = await report();
  const failure = text.split('\n').find(line => / workspace\.read project_required \(connected, \d+ ms\): /.test(line));
  assert.ok(/ = <folder-1>; \S+ = <folder-2>$/.test(failure) && !text.includes('Client Sec'), text);
  // What runtime.metrics gives of the same failure is its first 300 characters, as before.
  const told = (await runtime.call('runtime.metrics', {}, owner)).usage.recentFailures[0].message;
  assert.equal(told.length, 300); assert.ok(told.startsWith('Several projects are available'));
  // And a message that is long when it has been cleaned is shown by its first 300 characters in the report as well.
  await assert.rejects(runtime.call('workspace.read', { projectId: made[0].id, path: 'q'.repeat(400) + '.txt' }, { id: 'owner' }), error => error.message.includes('q'.repeat(400)));
  assert.equal((await report()).split('\n').find(line => line.includes('qqqq')).split(' ms): ')[1].length, 300);
});

test('the VS Code connection wizard stores the token privately, saves a signed-in Cloudflare route and offers the URL and sign-in code', async () => {
  const calls = [], copied = [], messages = [], confirmations = [];
  let running = true, rejectSettings = false, saved = { auth: { mode: 'none' }, connection: { kind: 'local' }, retentionDays: 30 };
  const answers = { picks: ['Cloudflare Tunnel', 'Require sign-in'], inputs: ['https://devmate.example.com/anything', 'C:\\cf\\cloudflared.exe', 'cf-token'] };
  const client = { start: async () => { running = true; }, stop: async () => { running = false; }, status: async () => ({ running, state: 'ready', record: { generation: 'g' } }),
    snapshot: async () => ({}), operations: async () => ({ items: [] }), workbenchUrl: async () => 'http://127.0.0.1:8788', dispose() {}, subscribe: () => ({ dispose() {} }),
    call: async (name, input) => {
      calls.push([name, input]);
      if (name === 'window.attach') return { windowId: input.windowId, roots: [], selectedProjectId: null };
      if (name === 'settings.read') return { saved };
      if (name === 'settings.replace' && rejectSettings) throw Object.assign(new Error('invalid_executable'), { code: 'invalid_executable' });
      if (name === 'settings.replace') saved = input.config;
      if (name === 'connection.status') return { kind: 'cloudflare', publicUrl: 'https://devmate.example.com/mcp' };
      if (name === 'auth.code.create') return { code: 'dml_one-time' };
      if (name === 'runtime.doctor') return { version: '4.0.0', status: 'ok', checks: [{ id: 'node', status: 'ok', detail: 'Node.js' }] };
      if (name === 'access.update') profile = input.profile;
      if (name.startsWith('access.')) return { profile };
      return {};
    } };
  let profile = 'guarded';
  const commands = new Map();
  const vscode = {
    TreeItem: class { constructor(label) { this.label = label; } }, TreeItemCollapsibleState: { None: 0 },
    EventEmitter: class { constructor() { this.event = () => {}; } fire() {} dispose() {} },
    workspace: { name: 'Empty', isTrusted: true, workspaceFolders: [], getConfiguration: () => ({ get: (_name, fallback) => fallback }) },
    window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }), registerTreeDataProvider: () => ({ dispose() {} }),
      showErrorMessage: async message => { messages.push('error: ' + message); },
      showWarningMessage: async (message, options, ...actions) => { confirmations.push({ message, ...options }); return actions[0]; },
      showInformationMessage: async (message, ...actions) => { messages.push(message); return actions[0]; },
      showQuickPick: async items => { const wanted = answers.picks.shift(); return items.find(item => item.label === wanted); },
      showInputBox: async () => answers.inputs.shift() },
    commands: { registerCommand: (id, handler) => { commands.set(id, handler); return { dispose() {} }; } },
    env: { openExternal: async () => true, clipboard: { writeText: async value => { copied.push(value); } } }, Uri: { parse: value => value }
  };
  const entry = createVscodeRuntimeEntry(vscode, { client });
  await entry.activate({ subscriptions: [] });
  // While sign-in is off there is no code to copy, and the command says where sign-in is switched on.
  await commands.get('devMate.runtime.loginCode')();
  assert.match(messages.at(-1), /Sign-in is off/); assert.deepEqual(copied, []);
  const config = await commands.get('devMate.runtime.configureConnection')();
  assert.deepEqual(config.connection, { kind: 'cloudflare', publicUrl: 'https://devmate.example.com/mcp', executable: 'C:\\cf\\cloudflared.exe', tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN' });
  assert.deepEqual(config.auth, { mode: 'oauth', issuer: 'https://devmate.example.com' }); assert.equal(config.retentionDays, 30, 'unrelated settings are preserved');
  const named = name => calls.filter(([operation]) => operation === name).map(([, input]) => input);
  assert.deepEqual(named('secret.set'), [{ name: 'CLOUDFLARE_TUNNEL_TOKEN', value: 'cf-token' }]);
  assert.deepEqual(named('settings.replace'), [{ config }]); assert.equal(JSON.stringify(config).includes('cf-token'), false);
  const order = calls.map(([operation]) => operation).filter(operation => ['settings.replace', 'secret.set'].includes(operation));
  assert.deepEqual(order, ['settings.replace', 'secret.set'], 'settings are validated before a credential is stored');
  // Restarting the runtime every window shares is a decision, asked in a modal dialog that names the route to configure.
  assert.equal(confirmations[0].modal, true); assert.match(confirmations[0].message, /Restart the shared DevMate runtime/);
  assert.match(confirmations[0].detail, /route the hostname to http:\/\/127\.0\.0\.1:8789/); assert.equal(named('runtime.doctor').length, 1, 'a restart is followed by a check');
  assert.equal(await commands.get('devMate.runtime.copyMcpUrl')(), 'https://devmate.example.com/mcp');
  await commands.get('devMate.runtime.loginCode')();
  assert.deepEqual(copied, ['https://devmate.example.com/mcp', 'dml_one-time']);
  // A configuration the runtime rejects leaves no credential behind.
  rejectSettings = true; calls.length = 0;
  answers.picks = ['OpenAI Secure MCP Tunnel']; answers.inputs = ['tunnel_abc', 'relative\\tunnel-client.exe', 'runtime-key'];
  assert.equal(await commands.get('devMate.runtime.configureConnection')(), undefined);
  assert.deepEqual(named('secret.set'), []); assert.match(messages.at(-1), /^error: invalid_executable/);
  rejectSettings = false;
  // The organization named for a tunnel on the command line stays with that tunnel, and goes with no other.
  saved = { ...saved, connection: { kind: 'openai-tunnel', tunnelId: 'tunnel_abc', runtimeKeyEnv: 'CONTROL_PLANE_API_KEY', organizationId: 'org-abc' } };
  answers.picks = ['OpenAI Secure MCP Tunnel']; answers.inputs = ['tunnel_abc', '', ''];
  assert.deepEqual((await commands.get('devMate.runtime.configureConnection')()).connection, { kind: 'openai-tunnel', tunnelId: 'tunnel_abc', runtimeKeyEnv: 'CONTROL_PLANE_API_KEY', organizationId: 'org-abc' });
  answers.picks = ['OpenAI Secure MCP Tunnel']; answers.inputs = ['tunnel_other', '', ''];
  assert.deepEqual((await commands.get('devMate.runtime.configureConnection')()).connection, { kind: 'openai-tunnel', tunnelId: 'tunnel_other', runtimeKeyEnv: 'CONTROL_PLANE_API_KEY' });
  answers.picks = ['Local only'];
  const local = await commands.get('devMate.runtime.configureConnection')();
  assert.deepEqual(local.connection, { kind: 'local' }); assert.deepEqual(local.auth, { mode: 'none' });
  // The permission profile: full access is confirmed in a modal dialog that says what it hands over; going back is not asked twice.
  answers.picks = ['Full access']; confirmations.length = 0;
  assert.equal(await commands.get('devMate.runtime.accessProfile')(), 'full');
  assert.equal(confirmations[0].modal, true); assert.match(confirmations[0].detail, /credential files/); assert.match(confirmations[0].detail, /granted automatically/);
  answers.picks = ['Guarded'];
  assert.equal(await commands.get('devMate.runtime.accessProfile')(), 'guarded');
  assert.deepEqual(named('access.update'), [{ profile: 'full' }, { profile: 'guarded' }]); assert.equal(confirmations.length, 1);
  await entry.deactivate();
});

test('the editor says when a new address can be reached from the cloud, once, and when a route stopped working', async () => {
  const quick = { kind: 'cloudflare-quick', temporaryAddress: true, remoteMcpVerified: false };
  const first = 'https://first-fixture.trycloudflare.com/mcp/key-of-the-first-start', second = 'https://second-fixture.trycloudflare.com/mcp/key-of-the-second-start';
  let route = { ...quick, phase: 'connecting' }, now = 1_000_000;
  const said = [], warned = [], copied = [], stored = new Map();
  const client = { status: async () => ({ running: true, state: 'ready', record: { generation: 'g', port: 8788 } }), dispose() {}, subscribe: () => ({ dispose() {} }),
    call: async (name, input) => name === 'window.attach' ? { windowId: input.windowId, roots: [], selectedProjectId: null } : name === 'connection.status' ? route : {} };
  const window = () => {
    const bar = { show() {}, dispose() {} }, commands = new Map();
    const vscode = {
      TreeItem: class { constructor(label) { this.label = label; } }, TreeItemCollapsibleState: { None: 0 },
      EventEmitter: class { constructor() { this.event = () => {}; } fire() {} dispose() {} },
      workspace: { name: 'Empty', isTrusted: true, workspaceFolders: [], getConfiguration: () => ({ get: (_name, fallback) => fallback }) },
      window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }), registerTreeDataProvider: () => ({ dispose() {} }), createStatusBarItem: () => bar,
        showErrorMessage: async () => {}, showWarningMessage: async message => { warned.push(message); },
        showInformationMessage: async (message, ...actions) => { said.push(message); return actions[0]; } },
      commands: { registerCommand: (id, handler) => { commands.set(id, handler); return { dispose() {} }; } },
      env: { clipboard: { writeText: async value => { copied.push(value); } } }, Uri: { parse: value => value }
    };
    const entry = createVscodeRuntimeEntry(vscode, { client, clock: () => now });
    // What every window of this editor shares, as the editor keeps it.
    const globalState = { get: (key, fallback) => stored.has(key) ? stored.get(key) : fallback, update: async (key, value) => { stored.set(key, value); } };
    const look = async () => { await commands.get('devMate.runtime.status')(); await new Promise(resolve => setImmediate(resolve)); return bar; };
    return { entry, bar, commands, look, start: () => entry.activate({ subscriptions: [], globalState }) };
  };
  const one = window();
  await one.start();
  // The tunnel is still connecting: the status bar says so, and there is no address to copy. The local one is not offered in its place.
  assert.equal((await one.look()).text, '$(sync~spin) DevMate'); assert.match(one.bar.tooltip, /\(connecting\)/);
  assert.equal(await one.commands.get('devMate.runtime.copyMcpUrl')(), undefined); assert.deepEqual(copied, []); assert.match(said.pop(), /has not been given its address yet/);
  // It has an address the world does not know yet: still waiting, nothing announced.
  route = { ...quick, phase: 'connected', publicUrl: first, verification: { url: first, verified: false, reachable: false, pending: 'dns', reason: 'The address is seconds old and not in DNS yet.' } };
  assert.equal((await one.look()).text, '$(sync~spin) DevMate'); assert.match(one.bar.tooltip, /waiting for the new address to be known/); assert.deepEqual(said, []);
  // Checked end to end: this is the moment a client in the cloud can connect. It is said once, with the address one click away.
  route = { ...quick, phase: 'connected', publicUrl: first, remoteMcpVerified: true, verification: { url: first, verified: true, reachable: true } };
  assert.equal((await one.look()).text, '$(plug) DevMate'); assert.match(one.bar.tooltip, /Reachable from the cloud/);
  assert.equal(said.length, 2); assert.match(said[0], /can be reached from the cloud at a new address/); assert.match(said[1], /Copied the public MCP URL\. It ends in the key of this start/); assert.deepEqual(copied, [first]);
  await one.look(); assert.equal(said.length, 2, 'not said again');
  // Another window of the same editor does not repeat it, and what the editor remembers is not the address: that ends in the key.
  const two = window(); await two.start(); await two.look();
  assert.equal(said.length, 2); assert.ok(![...stored.values()].some(value => /key-of-the-first-start|first-fixture/.test(String(value))));
  // The route stops working. One failed check is not news; a route that stays broken is said once.
  route = { ...quick, phase: 'connected', publicUrl: first, verification: { url: first, verified: false, reachable: false, reason: 'ECONNREFUSED' } };
  assert.equal((await one.look()).text, '$(warning) DevMate'); assert.deepEqual(warned, []);
  now += 21_000; await one.look(); await one.look();
  assert.equal(warned.length, 1); assert.match(warned[0], /the public address does not reach this computer \(ECONNREFUSED\)/);
  // It works again under the same address: the status bar shows it, nobody is interrupted.
  route = { ...quick, phase: 'connected', publicUrl: first, remoteMcpVerified: true, verification: { url: first, verified: true, reachable: true } };
  assert.equal((await one.look()).text, '$(plug) DevMate'); assert.equal(said.length, 2);
  // The tunnel started again and has another address: the client needs the new one, so it is said.
  route = { ...quick, phase: 'connected', publicUrl: second, remoteMcpVerified: true, verification: { url: second, verified: true, reachable: true } };
  await one.look();
  assert.equal(said.length, 4); assert.match(said[2], /new address/); assert.deepEqual(copied, [first, second]);
  await one.entry.deactivate(); await two.entry.deactivate();
});

test('restorable versions are bounded by age and by total size, least recently used first', async t => {
  const { __test } = await import('../runtime/service.mjs');
  const owned = temporary(t, 'devmate-history-cap-'), directory = path.join(owned.directory, 'history');
  fs.mkdirSync(directory);
  const version = (name, bytes, daysAgo) => { const file = path.join(directory, name); fs.writeFileSync(file, Buffer.alloc(bytes)); const at = new Date(Date.now() - daysAgo * 86400000); fs.utimesSync(file, at, at); };
  version('expired', 10, 45); version('oldest', 100, 20); version('middle', 100, 10); version('newest', 100, 1);
  __test.pruneHistory(directory, 30 * 86400000, 250);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['middle', 'newest'], 'past the size bound the version used longest ago goes first');
  __test.pruneHistory(directory, 30 * 86400000);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['middle', 'newest'], 'within both bounds nothing is removed');
  assert.doesNotThrow(() => __test.pruneHistory(path.join(owned.directory, 'missing'), 1000));
});

test('the doctor warns when the instance lives where other accounts of this computer can read it', { skip: process.platform !== 'win32' && 'file modes protect the instance elsewhere' }, async t => {
  const outside = await service(t, {});
  const check = (await outside.service.call('runtime.doctor', {}, owner)).checks.find(item => item.id === 'instance');
  if (path.relative(os.homedir(), outside.temp).startsWith('..') || path.parse(outside.temp).root !== path.parse(os.homedir()).root) {
    assert.equal(check.status, 'warn'); assert.match(check.fix, /owner token and credentials/);
  } else assert.equal(check, undefined);
});
