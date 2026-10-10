import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactCommand, redactSecrets } from '../runtime/platform/redact.mjs';
import { DevMateService } from '../runtime/service.mjs';
import { presentResult } from '../runtime/mcp.mjs';

const owner = Object.freeze({ id: 'owner', role: 'owner', surface: 'local' });
const node = process.execPath;

test('credentials written inline in a command are not shown; everything else is left exactly as it was', () => {
  const hidden = [
    ['curl -H "Authorization: Bearer abc123def456ghi789" https://api.example.com', 'abc123def456ghi789'],
    ['npm publish --token npm_abcdefghijklmnopqrstuvwxyz0123456789', 'npm_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['mysql --password=hunter2secret -u root', 'hunter2secret'],
    ['deploy --api-key "quoted key value" --region eu', 'quoted key value'],
    ['GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 gh pr list', 'ghp_abcdefghijklmnopqrstuvwxyz0123'],
    ["$env:OPENAI_API_KEY = 'sk-abcdefghijklmnopqrstuvwxyz'; node run.js", 'sk-abcdefghijklmnopqrstuvwxyz'],
    ['git clone https://alice:s3cretPass@github.com/acme/repo.git', 's3cretPass'],
    ['echo AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['use eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U now', 'eyJhbGciOiJIUzI1NiJ9']
  ];
  for (const [command, secret] of hidden) {
    const shown = redactSecrets(command);
    assert.equal(shown.includes(secret), false, command);
    assert.ok(shown.includes('[redacted]'), command);
  }
  // What surrounds the credential is still readable.
  assert.equal(redactSecrets('mysql --password=hunter2secret -u root'), 'mysql --password=[redacted] -u root');
  assert.equal(redactSecrets('git clone https://alice:s3cretPass@github.com/acme/repo.git'), 'git clone https://[redacted]@github.com/acme/repo.git');
  for (const plain of ['npm test -- --grep "token refresh"', 'git commit -m "rename password field"', 'node build.js --out dist', 'rg -n "api_key" src', 'echo $env:PATH', 'TOKENS_PER_PAGE=50 node paginate.js']) {
    assert.equal(redactSecrets(plain), plain, 'left alone: ' + plain);
  }
  for (const other of [undefined, null, 7, '']) assert.equal(redactSecrets(other), other);
  // With an executable and separate arguments, a flag and its value are seen together.
  assert.deepEqual(redactCommand({ file: 'gh', args: ['auth', 'login', '--token', 'ghp_abcdefghijklmnopqrstuvwxyz0123', '--hostname', 'github.com'] }).args,
    ['auth', 'login', '--token', '[redacted]', '--hostname', 'github.com']);
  assert.deepEqual(redactCommand({ command: 'curl -u bob:pw https://x', cwd: 'sub' }), { command: 'curl -u bob:pw https://x', cwd: 'sub' }, 'an unusual form is not recognised, and nothing is invented');
});

test('a command runs exactly as given while lists, the journal and other members see it without its credentials', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-redact-'));
  const root = path.join(temp, 'project'); fs.mkdirSync(root);
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: '' });
  await service.ready;
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const project = await service.call('project.create', { root }, owner);
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
  const args = ['-e', 'console.log(process.argv.slice(1).join(" "))', '--', '--token', secret];
  // The program really receives the credential.
  const ran = await service.call('shell.run', { file: node, args }, owner);
  assert.ok(ran.output.includes(secret), 'what runs is unchanged');
  assert.equal(ran.command.includes(secret), false); assert.ok(ran.command.includes('--token [redacted]'));
  assert.equal(JSON.stringify(await service.call('process.list', {}, owner)).includes(secret), false);
  const journal = service.store.events({ limit: 200 }).filter(event => event.type === 'workspace.process.started');
  assert.equal(journal.length, 1); assert.equal(JSON.stringify(journal).includes(secret), false, 'the activity record never held it');
  // A job keeps its exact command to run and retry; who may see it depends on who asks.
  const job = await service.call('job.start', { kind: 'command', input: { file: node, args } }, owner);
  let state = await service.call('job.read', { id: job.id }, owner);
  for (let attempt = 0; attempt < 100 && state.status !== 'completed'; attempt++) { await new Promise(resolve => setTimeout(resolve, 50)); state = await service.call('job.read', { id: job.id }, owner); }
  assert.equal(state.status, 'completed'); assert.ok(state.input.args.args.includes(secret), 'the owner sees their own command');
  const member = { id: 'member', role: 'read', projectIds: [project.id] };
  const seen = await service.call('job.read', { id: job.id }, member);
  assert.deepEqual(seen.input.args.args.slice(-2), ['--token', '[redacted]']);
  assert.equal(JSON.stringify((await service.call('job.list', {}, member)).items.map(item => item.input)).includes(secret), false);
  const events = await service.call('event.list', { latest: true, limit: 100 }, member);
  assert.ok(events.items.some(event => event.type === 'job.created')); assert.equal(JSON.stringify(events.items.map(event => event.entity?.input)).includes(secret), false);
  assert.ok(JSON.stringify((await service.call('event.list', { latest: true, limit: 100 }, owner)).items).includes(secret), 'the owner\'s own view is complete');
  const snapshot = await service.snapshot({ projectId: project.id }, member);
  assert.equal(JSON.stringify(snapshot.activity.map(event => event.entity?.input)).includes(secret), false);
  assert.deepEqual(Object.keys(snapshot.connection).sort(), ['kind', 'phase', 'remoteMcpVerified'], 'a member\'s snapshot carries the connection state, not the machine behind it');
});

test('every text a caller sends is bounded, and a monorepo\'s own instruction files are pointed out', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-bounds-'));
  const root = path.join(temp, 'project'); fs.mkdirSync(path.join(root, 'packages', 'api'), { recursive: true }); fs.mkdirSync(path.join(root, 'apps', 'web'), { recursive: true });
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: '' });
  await service.ready;
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await service.call('project.create', { root }, owner);
  const long = 'x'.repeat(5000);
  for (const [operation, input] of [['workspace.read', { path: long }], ['workspace.write', { path: long, text: 'x' }], ['workspace.files', { path: long }],
    ['shell.run', { file: node, args: Array.from({ length: 2001 }, () => 'a') }], ['shell.run', { command: 'echo hi', cwd: long }],
    ['git.log', { paths: [long] }], ['capability.call', { capability: 'y'.repeat(201) }], ['agents.delegate', { provider: 'claude', prompt: 'x', model: 'm'.repeat(201) }]]) {
    await assert.rejects(service.call(operation, input, owner), { code: 'invalid_input' }, operation);
  }
  // Ordinary long input still works: a path near the limit of a file system, and a full-size file.
  assert.equal((await service.call('workspace.write', { path: 'deep/' + 'd'.repeat(120) + '.txt', text: 'y'.repeat(3_000_000) }, owner)).written, true);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Root rules\n');
  fs.writeFileSync(path.join(root, 'packages', 'api', 'AGENTS.md'), '# API rules\n');
  fs.writeFileSync(path.join(root, 'apps', 'web', 'CLAUDE.md'), '# Web rules\n');
  const overview = await service.call('project.overview', {}, owner);
  assert.deepEqual(overview.instructions.map(item => item.path), ['AGENTS.md'], 'the root file is read in full');
  assert.deepEqual(overview.nestedInstructions, ['apps/web/CLAUDE.md', 'packages/api/AGENTS.md'], 'the others are named, each for its own folder');
  assert.match(presentResult(service.operations.get('project.overview'), overview).content[0].text, /Folders with their own instruction file \(read it before working there\): apps\/web\/CLAUDE\.md, packages\/api\/AGENTS\.md/);
});
