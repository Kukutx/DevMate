import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../runtime/store.mjs';
import { createWorkspaceService } from '../runtime/workspace.mjs';

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-editing-'));
  const root = path.join(temp, 'project'), controlRoot = path.join(temp, 'instance');
  fs.mkdirSync(root);
  const store = new Store(controlRoot);
  const record = store.create('project', { root, name: 'Editing', access: 'write', status: 'ready' });
  const project = { ...record, controlRoot };
  const service = createWorkspaceService({ store });
  t.after(() => { store.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const file = name => path.join(root, name);
  return { root, project, service, store, file };
}
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

test('exact-replacement edits are atomic, unambiguous and keep CRLF files intact', async t => {
  const { project, service, file } = fixture(t);
  fs.writeFileSync(file('app.js'), 'const a = 1;\r\nconst b = 2;\r\nconst a2 = 1;\r\n');
  const before = service.read(project, { path: 'app.js' });
  const edited = service.edit(project, { path: 'app.js', expectedSha256: before.sha256, edits: [
    { oldText: 'const a = 1;\nconst b = 2;', newText: 'const a = 10;\nconst b = 20;' },
    { oldText: ' = 1;', newText: ' = 100;' }
  ] });
  assert.equal(edited.replacements, 2); assert.equal(edited.previousSha256, before.sha256);
  assert.equal(fs.readFileSync(file('app.js'), 'utf8'), 'const a = 10;\r\nconst b = 20;\r\nconst a2 = 100;\r\n');
  // A failing edit leaves the file untouched, including edits that preceded it.
  const stable = fs.readFileSync(file('app.js'), 'utf8');
  assert.throws(() => service.edit(project, { path: 'app.js', edits: [{ oldText: 'const b = 20;', newText: 'const b = 0;' }, { oldText: 'missing', newText: 'x' }] }), { code: 'edit_not_found' });
  assert.throws(() => service.edit(project, { path: 'app.js', edits: [{ oldText: 'const', newText: 'let' }] }), { code: 'edit_ambiguous' });
  assert.throws(() => service.edit(project, { path: 'app.js', expectedSha256: before.sha256, edits: [{ oldText: 'const b', newText: 'let b' }] }), { code: 'conflict' });
  assert.throws(() => service.edit(project, { path: 'app.js', edits: [{ oldText: 'same', newText: 'same' }] }), { code: 'invalid_input' });
  assert.equal(fs.readFileSync(file('app.js'), 'utf8'), stable);
  const all = service.edit(project, { path: 'app.js', edits: [{ oldText: 'const', newText: 'let', replaceAll: true }] });
  assert.equal(all.replacements, 3); assert.equal(fs.readFileSync(file('app.js'), 'utf8').includes('const'), false);
  // Replacement text is literal: `$&` and friends are not expanded.
  service.edit(project, { path: 'app.js', edits: [{ oldText: 'let a = 10;', newText: "let a = '$& $1';" }] });
  assert.match(fs.readFileSync(file('app.js'), 'utf8'), /let a = '\$& \$1';/);
});

test('every change made through DevMate is restorable, including overwrites and deleted files', async t => {
  const { project, service, file } = fixture(t);
  const v1 = service.write(project, { path: 'notes.md', text: 'version one', expectedSha256: null });
  const v2 = service.write(project, { path: 'notes.md', text: 'version two', expectedSha256: v1.sha256 });
  service.edit(project, { path: 'notes.md', edits: [{ oldText: 'two', newText: 'three' }] });
  const removed = service.remove(project, { path: 'notes.md' });
  assert.equal(removed.restorable, true); assert.equal(fs.existsSync(file('notes.md')), false);
  const history = service.history(project, { path: 'notes.md' });
  assert.deepEqual(history.items.map(item => item.action), ['removed', 'written', 'written', 'written']);
  assert.equal(history.items[0].previousRestorable, true);
  assert.equal(history.items.at(-1).previousSha256, undefined, 'creation has no previous version');
  const restored = service.restore(project, { path: 'notes.md', sha256: v2.sha256 });
  assert.equal(restored.written, true); assert.equal(fs.readFileSync(file('notes.md'), 'utf8'), 'version two');
  service.restore(project, { path: 'notes.md', sha256: v1.sha256 });
  assert.equal(fs.readFileSync(file('notes.md'), 'utf8'), 'version one');
  assert.throws(() => service.restore(project, { path: 'notes.md', sha256: 'f'.repeat(64) }), { code: 'not_found' });
  assert.equal(fs.readdirSync(project.root).some(name => name.includes('history')), false, 'history lives in the private instance directory');
});

test('mkdir, move and delete stay inside the project and refuse unsafe replacements', async t => {
  const { project, service, file } = fixture(t);
  assert.deepEqual(service.mkdir(project, { path: 'src/deep/dir' }), { path: 'src/deep/dir', created: true });
  assert.equal(service.mkdir(project, { path: 'src/deep/dir' }).created, false);
  service.write(project, { path: 'src/a.txt', text: 'a', expectedSha256: null });
  service.write(project, { path: 'src/b.txt', text: 'b', expectedSha256: null });
  assert.deepEqual(service.move(project, { from: 'src/a.txt', to: 'src/deep/a.txt' }), { from: 'src/a.txt', to: 'src/deep/a.txt', type: 'file' });
  assert.throws(() => service.move(project, { from: 'src/b.txt', to: 'src/deep/a.txt' }), { code: 'already_exists' });
  service.move(project, { from: 'src/b.txt', to: 'src/deep/a.txt', overwrite: true });
  assert.equal(fs.readFileSync(file('src/deep/a.txt'), 'utf8'), 'b');
  assert.equal(service.history(project, { path: 'src/deep/a.txt' }).items[0].previousRestorable, true, 'the replaced file is kept');
  assert.equal(service.move(project, { from: 'src/deep', to: 'lib' }).type, 'directory');
  assert.throws(() => service.move(project, { from: 'lib', to: '../outside' }), { code: 'outside_project' });
  // A folder cannot be moved into itself, and the attempt creates nothing inside it.
  assert.throws(() => service.move(project, { from: 'lib', to: 'lib/inner/lib' }), { code: 'invalid_input', message: /into itself/ });
  assert.equal(fs.existsSync(path.join(project.root, 'lib', 'inner')), false);
  assert.throws(() => service.move(project, { from: '.', to: 'elsewhere' }), { code: 'invalid_path' });
  assert.throws(() => service.remove(project, { path: 'lib' }), { code: 'directory_not_empty' });
  assert.equal(service.remove(project, { path: 'lib', recursive: true }).type, 'directory');
  assert.equal(fs.existsSync(file('lib')), false);
  assert.throws(() => service.remove(project, { path: '.' }), { code: 'invalid_path' });
  fs.writeFileSync(file('.env'), 'SECRET=1');
  assert.throws(() => service.remove(project, { path: '.env' }), { code: 'protected_workspace_path' });
  assert.throws(() => service.move(project, { from: '.env', to: 'public.txt' }), { code: 'protected_workspace_path' });
  assert.throws(() => service.move(project, { from: 'src', to: 'secrets/src' }), { code: 'protected_workspace_path' });
  assert.equal(fs.readFileSync(file('.env'), 'utf8'), 'SECRET=1');
  const readOnly = { ...project, access: 'read' };
  for (const action of [() => service.mkdir(readOnly, { path: 'x' }), () => service.move(readOnly, { from: 'src', to: 'y' }),
    () => service.remove(readOnly, { path: 'src' }), () => service.restore(readOnly, { path: 'a', sha256: 'f'.repeat(64) })]) {
    assert.throws(action, { code: 'read_only' });
  }
});

test('reads page large files by line, find matches globs and search takes regex, case and glob filters', async t => {
  const { project, service, file } = fixture(t);
  fs.writeFileSync(file('big.txt'), Array.from({ length: 5000 }, (_, i) => 'line ' + (i + 1)).join('\n'));
  const small = service.read(project, { path: 'big.txt', startLine: 10, lineCount: 3 });
  assert.equal(small.text, 'line 10\nline 11\nline 12'); assert.equal(small.totalLines, 5000);
  assert.equal(small.nextStartLine, 13); assert.equal(small.truncated, true);
  fs.writeFileSync(file('huge.txt'), Array.from({ length: 60000 }, (_, i) => 'row ' + i).join('\n'));
  const first = service.read(project, { path: 'huge.txt' });
  assert.equal(first.truncated, true); assert.equal(first.startLine, 1); assert.equal(first.endLine, 2000);
  assert.equal(service.read(project, { path: 'huge.txt', startLine: first.nextStartLine, lineCount: 1 }).text, 'row 2000');
  assert.equal(first.sha256, service.read(project, { path: 'huge.txt', startLine: 59999 }).sha256, 'a page still carries the whole-file hash');
  assert.throws(() => service.read(project, { path: 'big.txt', startLine: 5001 }), { code: 'invalid_range' });
  const whole = service.read(project, { path: 'big.txt' });
  assert.equal(whole.truncated, false); assert.equal(whole.totalLines, 5000);

  fs.mkdirSync(file('src/util'), { recursive: true }); fs.mkdirSync(file('node_modules/pkg'), { recursive: true });
  for (const name of ['src/main.ts', 'src/util/math.ts', 'src/util/math.test.ts', 'src/readme.md', 'node_modules/pkg/index.ts']) fs.writeFileSync(file(name), 'export const Needle = 1;\nconst other = "needle";\n');
  assert.deepEqual((await service.find(project, { pattern: '*.ts' })).items.map(item => item.path).sort(), ['src/main.ts', 'src/util/math.test.ts', 'src/util/math.ts']);
  assert.deepEqual((await service.find(project, { pattern: 'src/**/*.test.ts' })).items.map(item => item.path), ['src/util/math.test.ts']);
  assert.deepEqual((await service.find(project, { pattern: 'src/*.{ts,md}' })).items.map(item => item.path).sort(), ['src/main.ts', 'src/readme.md']);
  assert.equal((await service.find(project, { pattern: '**/*', limit: 2 })).truncated, true);
  // .gitignore is honoured without a Git repository, and can be overridden explicitly.
  fs.writeFileSync(file('.gitignore'), 'generated/\n'); fs.mkdirSync(file('generated')); fs.writeFileSync(file('generated/out.ts'), 'export const Needle = 2;\n');
  assert.equal((await service.find(project, { pattern: '*.ts' })).items.some(item => item.path.startsWith('generated/')), false);
  assert.deepEqual((await service.find(project, { pattern: 'generated/*.ts', includeIgnored: true })).items.map(item => item.path), ['generated/out.ts']);
  assert.equal((await service.find(project, { pattern: '*.ts', includeIgnored: true })).items.some(item => item.path.startsWith('node_modules/')), true);
  fs.writeFileSync(file('.env'), 'Needle=secret\n');
  assert.equal((await service.search(project, { query: 'Needle', includeIgnored: true })).items.some(item => item.path === '.env'), false, 'protected files never appear, even when ignore rules are lifted');
  const literal = await service.search(project, { query: 'Needle', glob: '*.ts' });
  assert.equal(literal.items.length, 3); assert.ok(literal.items.every(item => item.path.endsWith('.ts') && item.line === 1));
  assert.equal((await service.search(project, { query: 'needle', ignoreCase: true, glob: 'src/main.ts' })).items.length, 2);
  assert.equal((await service.search(project, { query: 'Need[a-z]+ = \\d', regex: true, path: 'src/util' })).items.length, 2);
});

test('read-only Git history tools report log, show, blame and branches without exposing protected files', async t => {
  const { project, service, file, root } = fixture(t);
  git(root, 'init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(file('a.txt'), 'first\n'); fs.writeFileSync(file('.env'), 'SECRET=one\n');
  git(root, 'add', '-f', '--', 'a.txt', '.env'); git(root, 'commit', '--quiet', '-m', 'first commit');
  fs.writeFileSync(file('a.txt'), 'first\nsecond\n'); fs.writeFileSync(file('.env'), 'SECRET=two\n');
  git(root, 'commit', '--quiet', '-am', 'second commit'); git(root, 'branch', 'feature');
  const log = await service.gitLog(project, { limit: 5 });
  assert.deepEqual(log.items.map(item => item.subject), ['second commit', 'first commit']);
  assert.match(log.items[0].commit, /^[a-f0-9]{40}$/); assert.equal(log.items[0].author, 'Fixture');
  assert.equal((await service.gitLog(project, { paths: ['a.txt'], limit: 1 })).items.length, 1);
  const show = await service.gitShow(project, {});
  assert.match(show.stdout, /second commit/); assert.match(show.stdout, /\+second/);
  assert.equal(show.stdout.includes('SECRET'), false, 'protected files are excluded from history output');
  const blame = await service.gitBlame(project, { path: 'a.txt', startLine: 2, endLine: 2 });
  assert.match(blame.stdout, /second/); assert.equal(blame.stdout.includes('first\n'), false);
  const branches = await service.gitBranches(project);
  assert.equal(branches.current, 'main'); assert.deepEqual(branches.items.map(item => item.name).sort(), ['feature', 'main']);
  await assert.rejects(service.gitLog(project, { ref: '--output=/tmp/x' }), { code: 'invalid_input' });
  await assert.rejects(service.gitShow(project, { ref: '-p' }), { code: 'invalid_input' });
});
