import assert from 'node:assert/strict';
import test from 'node:test';
import { __test, runnerControlListener } from '../gateway/runner-control-plane.mjs';

test('rejects absolute remote artifact paths instead of rewriting them as relative', () => {
  assert.equal(__test.artifactPathAllowed('artifacts/report.json'), true);
  assert.equal(__test.artifactPathAllowed('/etc/passwd'), false);
  assert.equal(__test.artifactPathAllowed('C:/Windows/system.ini'), false);
  assert.equal(__test.artifactPathAllowed('//server/share/file.txt'), false);
  assert.deepEqual(__test.sanitizeArtifacts([
    { path: '/etc/passwd', bytes: 1 },
    { path: 'artifacts/report.json', bytes: 1 }
  ], 'runner-1', 'app').map(item => item.path), ['artifacts/report.json']);
});

test('does not intercept adjacent Runner API versions', async () => {
  let forwarded = 0;
  const listener = runnerControlListener((_req, _res) => {
    forwarded += 1;
    return 'forwarded';
  });
  const result = await listener({ url: '/runner/v10/heartbeat' }, {});
  assert.equal(result, 'forwarded');
  assert.equal(forwarded, 1);
});
