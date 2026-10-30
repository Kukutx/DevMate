import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { main } from '../runtime/cli.mjs';
import { stopRuntime } from '../runtime/launcher.mjs';

// In a file of its own: `devmate serve` runs the runtime in the process that calls it, and a runtime sets up the
// process for itself (what it does with a fault nobody caught, with a signal, with the current directory). That
// stays with this file's process and reaches no other test.
test('devmate serve runs the runtime in its own process, and what the runtime writes there by itself is held to what the command writes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-cli-serve-')), instanceRoot = path.join(directory, 'instance');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const output = () => ({ write() {} });
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  // The process's own error output, as this test's process has it: what reaches it is noted, and it is put back
  // afterwards. (Its standard output is left alone: the test runner speaks to its parent on it.)
  const written = { err: [] }, own = { err: process.stderr.write };
  process.stderr.write = chunk => { written.err.push(chunk); return true; };
  let ended;
  try {
    ended = main(['serve', '--instance', instanceRoot, '--port', String(port)], { stdout: output(), stderr: output() });
    for (let round = 0; round < 400 && !fs.existsSync(path.join(instanceRoot, 'runtime.json')); round++) await new Promise(resolve => setTimeout(resolve, 50));
    await new Promise(resolve => setTimeout(resolve, 300));
    // A line the runtime writes by itself (a fault with the path that was asked for, what a connector's program
    // said) goes straight to the process's output, past the two streams the command was given.
    const esc = String.fromCharCode(0x1b);
    process.stderr.write('ssh said ' + esc + '[2K' + esc + ']8;;https://example.com' + String.fromCharCode(7) + 'this\n');
    process.stderr.write('a line with a tab\tand an end\n');
    process.stderr.write(Buffer.from([0x1b, 0x5b]));
    assert.ok(written.err.includes('ssh said \\u001b[2K\\u001b]8;;https://example.com\\u0007this\n'), JSON.stringify(written.err.slice(-3)));
    assert.ok(written.err.includes('a line with a tab\tand an end\n'), 'a line end and a tab stay');
    assert.ok(Buffer.isBuffer(written.err.at(-1)), 'what is no text is passed on as it is');
    await stopRuntime({ instanceRoot, timeoutMs: 15000 });
    assert.equal(await ended, 0);
    // With the runtime gone the process's output is its own again.
    const after = written.err.length;
    process.stderr.write(esc + '\n');
    assert.equal(written.err[after], esc + '\n');
  } finally {
    process.stderr.write = own.err;
    await stopRuntime({ instanceRoot, timeoutMs: 15000 }).catch(() => {});
    await ended?.catch(() => {});
  }
});
