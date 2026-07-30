const assert = require('node:assert/strict');
const test = require('node:test');
const {
  cloudflareLaunch,
  decorateNgrokArgs,
  normalizePublicUrl,
  parsePort,
  parseTryCloudflareUrl
} = require('../tunnel-provider');

test('builds safe tunnel provider commands without exposing managed tokens in args', () => {
  const launch = cloudflareLaunch(
    'cloudflare-managed',
    8787,
    { publicUrl: 'https://devmate.example.com' },
    { cloudflareTunnelToken: 'secret-token-value-long-enough' }
  );
  assert.deepEqual(launch.args, ['tunnel', 'run']);
  assert.equal(launch.options.env.TUNNEL_TOKEN, 'secret-token-value-long-enough');
  assert.equal(launch.args.join(' ').includes('secret-token'), false);
});

test('decorates ngrok production policies and parses provider output', () => {
  assert.deepEqual(
    decorateNgrokArgs(['http', '8787'], { ngrokTrafficPolicyFile: 'policy.yml' }),
    ['http', '8787', '--traffic-policy-file', 'policy.yml']
  );
  assert.equal(parsePort(['http', 'http://127.0.0.1:8787']), 8787);
  assert.equal(
    parseTryCloudflareUrl('Ready https://random-name.trycloudflare.com now'),
    'https://random-name.trycloudflare.com'
  );
  assert.equal(normalizePublicUrl('devmate.example.com'), 'https://devmate.example.com');
});

test('provides a virtual ngrok compatibility API for alternate tunnel providers', async () => {
  const { TunnelCompatibilityManager } = require('../tunnel-provider');
  const manager = new TunnelCompatibilityManager({
    settings: () => ({ provider: 'external', publicUrl: 'https://devmate.example.com' })
  });
  manager.publicUrl = 'https://devmate.example.com';
  manager.localPort = 8787;
  const wrapped = manager.wrapHttpRequest(() => {
    throw new Error('unexpected real request');
  });
  const result = await new Promise((resolve, reject) => {
    const req = wrapped(
      new URL('http://127.0.0.1:4040/api/tunnels'),
      { method: 'GET' },
      res => {
        let text = '';
        res.on('data', data => { text += data; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(result.status, 200);
  assert.match(result.text, /devmate\.example\.com/);
});

test('passes native ngrok API requests through unchanged', () => {
  const { TunnelCompatibilityManager } = require('../tunnel-provider');
  const sentinel = { native: true };
  const manager = new TunnelCompatibilityManager({ settings: () => ({ provider: 'ngrok' }) });
  const wrapped = manager.wrapHttpRequest(() => sentinel);
  assert.equal(
    wrapped(new URL('http://127.0.0.1:4040/api/tunnels'), { method: 'GET' }),
    sentinel
  );
});
