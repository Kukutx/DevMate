import assert from 'node:assert/strict';
import test from 'node:test';
import { executeCommand } from '../gateway/command-process.mjs';
import { assertPackageScriptIdentifier, packageManagerInvocation } from '../gateway/package-manager.mjs';

test('Windows package-manager command shims run through cmd.exe without enabling Node shell mode', () => {
  assert.deepEqual(packageManagerInvocation('npm', ['run', 'test:unit'], { platform: 'win32', comspec: 'cmd.exe' }), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'npm.cmd', 'run', 'test:unit']
  });
  assert.equal(packageManagerInvocation('bun', ['run', 'test'], { platform: 'win32' }).command, 'bun');
});

test('POSIX package-manager commands remain direct argv execution', () => {
  assert.deepEqual(packageManagerInvocation('pnpm', ['run', 'check'], { platform: 'linux' }), {
    command: 'pnpm',
    args: ['run', 'check']
  });
});

test('package script names are option-safe before reaching a Windows command shim', () => {
  assert.equal(assertPackageScriptIdentifier('test:e2e'), 'test:e2e');
  assert.equal(assertPackageScriptIdentifier('release.preflight'), 'release.preflight');
  assert.throws(() => assertPackageScriptIdentifier('test & echo injected'), /option-safe package script identifier/);
  assert.throws(() => assertPackageScriptIdentifier('-dangerous'), /option-safe package script identifier/);
});

test('unsupported package managers fail closed', () => {
  assert.throws(() => packageManagerInvocation('unknown', [], { platform: 'win32' }), /Unsupported package manager/);
});

test('Windows npm project scripts run through the bounded cmd wrapper', { skip: process.platform !== 'win32' }, async () => {
  const invocation = packageManagerInvocation('npm', ['run', 'version:check']);
  const result = await executeCommand(invocation.command, invocation.args, {
    cwd: process.cwd(),
    timeoutMs: 30000,
    maxOutputChars: 20000,
    shell: false
  });
  assert.equal(result.exitCode, 0, result.stderr || result.error || 'npm.cmd failed');
  assert.match(result.stdout, /Verified DevMate version/);
});
