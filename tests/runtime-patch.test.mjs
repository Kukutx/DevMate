import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../runtime/store.mjs';
import { createWorkspaceService } from '../runtime/workspace.mjs';
import { parsePatch, patchText } from '../runtime/patch.mjs';
import { DevMateService } from '../runtime/service.mjs';
import { MODEL_VISIBLE_OPERATIONS, presentResult } from '../runtime/mcp.mjs';

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-patch-'));
  const root = path.join(temp, 'project'), controlRoot = path.join(temp, 'instance');
  fs.mkdirSync(root);
  const store = new Store(controlRoot);
  const record = store.create('project', { root, name: 'Patching', access: 'write', status: 'ready' });
  const project = { ...record, controlRoot };
  const service = createWorkspaceService({ store });
  t.after(() => { store.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const file = name => path.join(root, name);
  const put = (name, text) => { fs.mkdirSync(path.dirname(file(name)), { recursive: true }); fs.writeFileSync(file(name), text); };
  const get = name => fs.readFileSync(file(name), 'utf8');
  // Every file of the project with its text, the way two states of it are compared.
  const tree = (directory = root, found = {}) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) tree(full, found); else found[path.relative(root, full).replace(/\\/g, '/')] = fs.readFileSync(full, 'utf8');
    }
    return found;
  };
  return { temp, root, project, service, store, file, put, get, tree };
}
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const envelope = (...sections) => ['*** Begin Patch', ...sections.flat(), '*** End Patch', ''].join('\n');

test('one patch in the envelope form updates, adds, deletes and moves files, all of them recorded and taken back as one', t => {
  const { project, service, store, put, get, file, tree } = fixture(t);
  put('src/app.js', 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n');
  put('old.txt', 'gone\n');
  put('lib/util.js', 'export const x = 1;\n');
  const before = tree(), entry = store.revision;
  const result = service.applyPatch(project, { patch: envelope(
    ['*** Update File: src/app.js', '@@', ' function a() {', '-  return 1;', '+  return 10;', ' }', '@@ function b() {', '-  return 2;', '+  return 20;', '+  // twice'],
    ['*** Add File: src/new/added.js', '+export const added = true;', '+'],
    ['*** Delete File: old.txt'],
    ['*** Update File: lib/util.js', '*** Move to: lib/helpers.js', '@@', '-export const x = 1;', '+export const x = 2;']) });
  assert.equal(get('src/app.js'), 'function a() {\n  return 10;\n}\n\nfunction b() {\n  return 20;\n  // twice\n}\n');
  assert.equal(get('src/new/added.js'), 'export const added = true;\n\n');
  assert.equal(fs.existsSync(file('old.txt')), false); assert.equal(fs.existsSync(file('lib/util.js')), false);
  assert.equal(get('lib/helpers.js'), 'export const x = 2;\n');
  assert.deepEqual(result.files, [
    { operation: 'update', path: 'src/app.js', additions: 3, removals: 2, lines: [1, 6] },
    { operation: 'add', path: 'src/new/added.js', additions: 2, removals: 0 },
    { operation: 'delete', path: 'old.txt' },
    { operation: 'move', path: 'lib/helpers.js', additions: 1, removals: 1, lines: [1], previousPath: 'lib/util.js' }]);
  assert.deepEqual([result.additions, result.removals, result.since], [6, 3, entry]);
  // Each file is a history entry of its own, and the number the result names takes the whole patch back.
  assert.deepEqual(service.history(project, {}).items.map(item => item.action + ' ' + item.path).reverse(),
    ['written src/app.js', 'written src/new/added.js', 'moved lib/helpers.js', 'written lib/helpers.js', 'removed old.txt']);
  const undone = service.restore(project, { since: result.since });
  assert.deepEqual(undone.left, []); assert.deepEqual(tree(), before);
});

test('a hunk is found by its text: indentation and trailing spaces may differ, what is unchanged stays as the file has it', t => {
  const { project, service, put, get } = fixture(t);
  put('a.py', 'class A:\n\tdef run(self):   \n\t\treturn 1\n\nclass B:\n\tdef run(self):\n\t\treturn 1\n');
  // Written with spaces where the file has tabs, and without the spaces that end a line in the file.
  const result = service.applyPatch(project, { patch: envelope(['*** Update File: a.py', '@@ class B:', '     def run(self):', '-        return 1', '+\t\treturn 2']) });
  assert.equal(get('a.py'), 'class A:\n\tdef run(self):   \n\t\treturn 1\n\nclass B:\n\tdef run(self):\n\t\treturn 2\n');
  assert.deepEqual(result.files[0].lines, [6]);
  // Lines that are there twice, with nothing that says which: refused, not guessed. A line it comes after settles it.
  put('twice.txt', 'first:\nx = 1\nsecond:\nx = 1\n');
  assert.throws(() => service.applyPatch(project, { patch: envelope(['*** Update File: twice.txt', '-x = 1', '+x = 2']) }),
    error => error.code === 'patch_ambiguous' && /fits at line 2 and again at line 4/.test(error.message) && /Nothing was changed/.test(error.message) && error.details.lines.join() === '2,4');
  assert.equal(get('twice.txt'), 'first:\nx = 1\nsecond:\nx = 1\n');
  assert.deepEqual(service.applyPatch(project, { patch: envelope(['*** Update File: twice.txt', '@@ second:', '-x = 1', '+x = 2']) }).files[0].lines, [4]);
  assert.deepEqual(service.applyPatch(project, { patch: envelope(['*** Update File: twice.txt', ' first:', '-x = 1', '+x = 3']) }).files[0].lines, [1]);
  assert.equal(get('twice.txt'), 'first:\nx = 3\nsecond:\nx = 2\n');
  // Typographic quotes, dashes and spaces in the patch find the plain ones in the file, and the other way round.
  put('quotes.txt', 'say "hello" - now\nit\u2019s here\u00a0too\n');
  service.applyPatch(project, { patch: "<<'EOF'\n" + envelope(['*** Update File: quotes.txt', ' say \u201chello\u201d \u2013 now', "-it's here too", '+done']) + 'EOF\n' });
  assert.equal(get('quotes.txt'), 'say "hello" - now\ndone\n');
  // Lines with nothing before them are added at the end; "*** End of File" ties a hunk to the end.
  put('end.txt', 'tail\nbody\ntail\n');
  service.applyPatch(project, { patch: envelope(['*** Update File: end.txt', '-tail', '+TAIL', '*** End of File'], ['*** Update File: twice.txt', '+appended']) });
  assert.equal(get('end.txt'), 'tail\nbody\nTAIL\n'); assert.equal(get('twice.txt'), 'first:\nx = 3\nsecond:\nx = 2\nappended\n');
});

test('line endings, a byte-order mark and a missing final newline are kept as the file has them', t => {
  const { project, service, put, get, file } = fixture(t);
  put('crlf.txt', 'one\r\ntwo\r\nthree\r\n');
  service.applyPatch(project, { patch: envelope(['*** Update File: crlf.txt', ' one', '-two', '+2', '+2.5', ' three']) });
  assert.equal(get('crlf.txt'), 'one\r\n2\r\n2.5\r\nthree\r\n');
  fs.writeFileSync(file('bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('first\nsecond')]));
  service.applyPatch(project, { patch: '--- a/bom.txt\n+++ b/bom.txt\n@@ -1,2 +1,2 @@\n-first\n+FIRST\n second\n\\ No newline at end of file\n' });
  assert.deepEqual([...fs.readFileSync(file('bom.txt'))].slice(0, 3), [0xef, 0xbb, 0xbf]);
  assert.equal(get('bom.txt').slice(1), 'FIRST\nsecond');
  // The marker after a removed line only: the file ends with a newline from now on.
  service.applyPatch(project, { patch: '--- a/bom.txt\n+++ b/bom.txt\n@@ -2 +2 @@\n-second\n\\ No newline at end of file\n+second\n' });
  assert.equal(get('bom.txt').slice(1), 'FIRST\nsecond\n');
  // A patch that arrives with CRLF line ends is the same patch.
  put('plain.txt', 'a\nb\n');
  service.applyPatch(project, { patch: envelope(['*** Update File: plain.txt', ' a', '-b', '+c']).replace(/\n/g, '\r\n') });
  assert.equal(get('plain.txt'), 'a\nc\n');
});

test('what git diff prints is applied as it is: changes, a new file, a deleted one, a rename, a name that needs quoting', t => {
  const { root, project, service, put, tree } = fixture(t);
  git(root, 'init', '-q');
  put('src/app.js', Array.from({ length: 40 }, (_, index) => 'line ' + (index + 1)).join('\n') + '\n');
  put('docs/old.md', '# Old\n\ntext\n');
  put('keep.txt', 'first\nlast without newline');
  put('rename-me.txt', 'a\nb\nc\nd\ne\nf\ng\nh\n');
  put('中文 文件.txt', '第一行\n第二行\n');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
  const pristine = tree();
  put('src/app.js', pristine['src/app.js'].replace('line 3\n', 'line three\n').replace('line 30\n', 'line 30\ninserted\n').replace('line 38\n', ''));
  fs.rmSync(path.join(root, 'docs', 'old.md'));
  put('keep.txt', 'first\nlast, changed, still without newline');
  fs.renameSync(path.join(root, 'rename-me.txt'), path.join(root, 'renamed.txt'));
  put('renamed.txt', 'a\nb\nc\nd\ne\nf\ng\nH\n');
  put('中文 文件.txt', '第一行\n第二行，改过\n');
  put('new/added.txt', 'brand new\n');
  git(root, 'add', '-A');
  const wanted = tree(), patch = git(root, 'diff', '--cached', '-M', 'HEAD');
  assert.match(patch, /rename from rename-me\.txt/); assert.match(patch, /"a\/\\344/, 'git quoted the name');
  git(root, 'reset', '-q', '--hard', 'HEAD'); git(root, 'clean', '-fdq');
  assert.deepEqual(tree(), pristine);
  // First as a rehearsal: it says what would happen and changes nothing.
  const rehearsal = service.applyPatch(project, { patch, dryRun: true });
  assert.equal(rehearsal.dryRun, true); assert.equal(rehearsal.since, undefined); assert.deepEqual(tree(), pristine);
  const result = service.applyPatch(project, { patch });
  assert.deepEqual(result.files, rehearsal.files);
  assert.deepEqual(result.files.map(item => item.operation + ' ' + item.path).sort(), ['add new/added.txt', 'delete docs/old.md', 'move renamed.txt', 'update keep.txt', 'update src/app.js', 'update 中文 文件.txt']);
  assert.deepEqual(tree(), wanted);
  // Asked again, git prints the very patch that was applied.
  git(root, 'add', '-A');
  assert.equal(git(root, 'diff', '--cached', '-M', 'HEAD'), patch);
});

test('a unified diff whose line numbers are stale is applied where its lines are', t => {
  const { project, service, put, get } = fixture(t);
  const body = Array.from({ length: 30 }, (_, index) => 'row ' + (index + 1));
  put('data.txt', ['added above', 'and another', ...body].join('\n') + '\n');
  // Written against the file before two lines were added at its top: both hunks are two lines further down.
  const result = service.applyPatch(project, { patch: ['--- data.txt\t2026-01-01 10:00:00', '+++ data.txt\t2026-01-01 10:05:00', '@@ -4,3 +4,3 @@', ' row 4', '-row 5', '+ROW 5', ' row 6',
    '@@ -20,2 +20,3 @@', ' row 20', '+between', ' row 21', ''].join('\n') });
  assert.deepEqual(result.files[0].lines, [6, 22]);
  assert.deepEqual(get('data.txt').split('\n').slice(5, 8), ['row 4', 'ROW 5', 'row 6']); assert.deepEqual(get('data.txt').split('\n').slice(21, 24), ['row 20', 'between', 'row 21']);
  // An insertion with no line around it goes where its header says.
  service.applyPatch(project, { patch: '--- a/data.txt\n+++ b/data.txt\n@@ -0,0 +1 @@\n+very first\n' });
  assert.equal(get('data.txt').split('\n')[0], 'very first');
});

test('a patch that does not fit changes nothing and says where it stops matching', t => {
  const { project, service, put, tree } = fixture(t);
  put('a.txt', 'alpha\nbeta\ngamma\n'); put('b.txt', 'one\ntwo\nthree\n'); put('.env', 'TOKEN=x\n');
  const before = tree();
  const refused = (patch, expected) => { assert.throws(() => service.applyPatch(project, { patch }), expected); assert.deepEqual(tree(), before); };
  // The first file would fit; the second does not, so neither is touched.
  refused(envelope(['*** Update File: a.txt', '-beta', '+BETA'], ['*** Update File: b.txt', ' one', ' two', '-four', '+4']),
    error => error.code === 'patch_failed' && error.details.path === 'b.txt' && error.details.hunk === 1 &&
      /Its first 2 line\(s\) match at line 1, then line 3 of the file is:\n {2}three\nwhere the patch has:\n {2}four/.test(error.message) && /Nothing was changed/.test(error.message));
  refused(envelope(['*** Update File: a.txt', '-nowhere', '+x']), error => error.code === 'patch_failed' && /None of its lines is there/.test(error.message));
  refused(envelope(['*** Update File: a.txt', '@@ class Missing', '-beta', '+x']), { code: 'patch_failed', message: /No line "class Missing" is there/ });
  refused(envelope(['*** Update File: a.txt', '-beta', '+BETA'], ['*** Add File: b.txt', '+again']), { code: 'already_exists' });
  refused(envelope(['*** Update File: a.txt', '-beta', '+BETA'], ['*** Delete File: missing.txt']), { code: 'not_found' });
  refused(envelope(['*** Update File: a.txt', '-beta', '+BETA'], ['*** Update File: a.txt', '-alpha', '+ALPHA']), { code: 'invalid_patch', message: /more than once/ });
  refused(envelope(['*** Update File: a.txt', '*** Move to: b.txt', '-beta', '+BETA']), { code: 'already_exists' });
  refused(envelope(['*** Update File: a.txt', '-beta', '+BETA'], ['*** Update File: .env', '-TOKEN=x', '+TOKEN=y']), { code: 'protected_workspace_path' });
  refused(envelope(['*** Update File: a.txt', '-beta', '+BETA'], ['*** Add File: ../outside.txt', '+x']), { code: 'outside_project' });
  refused('--- a/b.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n', { code: 'patch_failed', message: /leave part of the file/ });
  // What is not a patch at all is said to be none, with the two forms that are read.
  for (const patch of ['', 'just some words', '*** Begin Patch\n*** Update File: a.txt\n-beta\n+BETA\n', envelope(['*** Update File: a.txt', ' alpha']), envelope(['*** Rename File: a.txt']),
    envelope(['*** Add File: c.txt', 'no plus']), '--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n', '@@ -1 +1 @@\n-alpha\n+x\n', 'diff --git a/x.bin b/x.bin\nBinary files a/x.bin and b/x.bin differ\n'])
    refused(patch, { code: 'invalid_patch' });
  // A read-only project takes no patch, not even as a rehearsal.
  assert.throws(() => service.applyPatch({ ...project, access: 'read' }, { patch: envelope(['*** Delete File: a.txt']), dryRun: true }), { code: 'read_only' });
});

test('a write that fails halfway takes back what the patch had already changed', t => {
  const { project, service, put, tree, file } = fixture(t);
  put('a.txt', 'alpha\n'); put('b.txt', 'one\n'); put('c.txt', 'see\n');
  const before = tree(), rename = fs.renameSync;
  // The third change cannot be written: as when a disk fills up or a file is locked.
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to).endsWith('b.txt')) throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
    return rename(from, to);
  });
  assert.throws(() => service.applyPatch(project, { patch: envelope(['*** Add File: fresh.txt', '+new'], ['*** Update File: a.txt', '-alpha', '+ALPHA'], ['*** Delete File: c.txt'],
    ['*** Update File: b.txt', '-one', '+ONE']) }), error => error.code === 'EIO' && /^The patch was not applied: /.test(error.message) && /Nothing of it was kept\.$/.test(error.message));
  t.mock.restoreAll();
  assert.deepEqual(tree(), before); assert.equal(fs.existsSync(file('fresh.txt')), false);
  // What happened is in the history, the taking back included. The deletion had not been reached: it comes last.
  assert.deepEqual(service.history(project, { limit: 50 }).items.map(item => item.action + ' ' + item.path).reverse(),
    ['written fresh.txt', 'written a.txt', 'written a.txt', 'removed fresh.txt']);
});

test('the two forms are read into the same changes, and one file\'s text is worked out without a disk', () => {
  const asEnvelope = parsePatch(envelope(['*** Update File: f.txt', '@@', ' a', '-b', '+B', ' c']));
  const asDiff = parsePatch('diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@ some section\n a\n-b\n+B\n c\n');
  assert.deepEqual(asEnvelope, [{ action: 'update', path: 'f.txt', hunks: [{ header: null, lines: [{ kind: ' ', text: 'a' }, { kind: '-', text: 'b' }, { kind: '+', text: 'B' }, { kind: ' ', text: 'c' }] }] }]);
  assert.deepEqual(asDiff, [{ action: 'update', path: 'f.txt', hunks: [{ oldStart: 1, lines: asEnvelope[0].hunks[0].lines }] }]);
  for (const [change] of [asEnvelope, asDiff]) assert.deepEqual(patchText('a\nb\nc\n', change), { text: 'a\nB\nc\n', additions: 1, removals: 1, lines: [1] });
  // A removed line that looks like a file header is a line of its hunk: the header's counts say how long the hunk is.
  const [tricky] = parsePatch('--- a/list.md\n+++ b/list.md\n@@ -1,3 +1,2 @@\n title\n--- item\n-++ more\n+-- item\n');
  assert.deepEqual(patchText('title\n-- item\n++ more\n', tricky).text, 'title\n-- item\n');
  // A plain diff names its files without a/ and b/; several files follow one another without a "diff" line.
  assert.deepEqual(parsePatch('--- one.txt\n+++ one.txt\n@@ -1 +1 @@\n-a\n+b\n--- /dev/null\n+++ two.txt\n@@ -0,0 +1,2 @@\n+x\n+y\n\\ No newline at end of file\n--- three.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-z\n')
    .map(change => [change.action, change.path, change.text]), [['update', 'one.txt', undefined], ['add', 'two.txt', 'x\ny'], ['delete', 'three.txt', undefined]]);
  assert.deepEqual(parsePatch('diff --git a/old name.txt b/new name.txt\nsimilarity index 100%\nrename from old name.txt\nrename to new name.txt\n'), [{ action: 'update', path: 'old name.txt', moveTo: 'new name.txt', hunks: [] }]);
  assert.throws(() => parsePatch(envelope(...Array.from({ length: 201 }, (_, index) => ['*** Delete File: f' + index]))), { code: 'invalid_patch', message: /more than 200/ });
  // A long file is no different: a change near its end, and a hunk that fits nowhere, are both answered at once.
  const long = Array.from({ length: 200000 }, (_, index) => 'line ' + index).join('\n') + '\n';
  const [late] = parsePatch(envelope(['*** Update File: long.txt', ' line 199990', '-line 199991', '+changed', ' line 199992']));
  const patched = patchText(long, late);
  assert.deepEqual(patched.lines, [199991]); assert.equal(patched.text.length, long.length - 'line 199991'.length + 'changed'.length);
  assert.throws(() => patchText(long, parsePatch(envelope(['*** Update File: long.txt', ' line 5', '-absent', '+x']))[0]), { code: 'patch_failed', message: /Its first 1 line\(s\) match at line 6/ });
});

test('workspace_patch is a tool of its own: described, bounded, refused where the project is read only', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-patch-service-'));
  const root = path.join(temp, 'project'); fs.mkdirSync(root);
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: '' });
  await service.ready;
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const owner = { id: 'owner', surface: 'local' }, connected = { id: 'owner' };
  const project = await service.call('project.create', { root }, owner);
  fs.writeFileSync(path.join(root, 'a.txt'), 'alpha\nbeta\n');
  assert.ok(MODEL_VISIBLE_OPERATIONS.has('workspace.patch'));
  const operation = service.operations.get('workspace.patch');
  assert.equal(operation.readOnly, false); assert.equal(operation.destructive, true);
  assert.match(operation.description, /\*\*\* Begin Patch/); assert.match(operation.description, /unified diff/);
  const result = await service.call('workspace.patch', { patch: envelope(['*** Update File: a.txt', ' alpha', '-beta', '+BETA'], ['*** Add File: b.txt', '+new']) }, connected);
  const shown = presentResult(operation, result).content[0].text;
  assert.match(shown, /^Changed 2 file\(s\) \(\+2 −1\):\n {2}update a\.txt {2}\(\+1 −1\) {2}at line 1\n {2}add {4}b\.txt {2}\(\+1 −0\)\nTake all of it back with workspace_restore \{since:\d+\}\.\n\{"since":\d+\}$/);
  assert.match(operation.description, /starts with "\+", in a new file too/); assert.match(operation.description, /do not read the files again/);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'alpha\nBETA\n');
  await service.call('workspace.restore', { since: result.since }, connected);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'alpha\nbeta\n'); assert.equal(fs.existsSync(path.join(root, 'b.txt')), false);
  await assert.rejects(service.call('workspace.patch', { patch: '' }, connected), { code: 'invalid_input' });
  await assert.rejects(service.call('workspace.patch', { patch: 'x'.repeat(4000001) }, connected), { code: 'invalid_input' });
  await service.call('project.update', { id: project.id, access: 'read' }, owner);
  await assert.rejects(service.call('workspace.patch', { patch: envelope(['*** Delete File: a.txt']) }, connected), { code: 'read_only' });
});
