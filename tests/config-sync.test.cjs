
        'use strict';

        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const test = require('node:test');
        const { SUPPORTED_CONFIG_VERSION } = require('../shared/config-store.cjs');
        const {
          mergeExtensionConfig,
          readExtensionConfig,
          writeExtensionConfig
        } = require('../vscode-host/config-sync.js');

        function tempFile() {
          const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-config-sync-'));
          return path.join(directory, 'config.json');
        }

        test('merges host-owned fields without replacing Gateway-owned state', () => {
          const current = {
            version: SUPPORTED_CONFIG_VERSION,
            instanceId: 'stable',
            auth: { required: true, token: 'owner-token' },
            task: { currentTaskId: 'task-1' },
            runnerControl: { enabled: true },
            trustedWritableRoots: [{ id: 'trusted' }],
            runtime: { maxConcurrentJobs: 4, defaultCommandTimeoutMs: 1000 },
            workspaces: [{ id: 'app' }, { id: 'trusted', trusted: true, role: 'trusted' }]
          };
          const candidate = {
            version: SUPPORTED_CONFIG_VERSION,
            instanceId: 'stale',
            auth: { required: false, token: 'stale-token' },
            runtime: { defaultCommandTimeoutMs: 2000, maxOutputChars: 3000 },
            workspaces: [{ id: 'app' }]
          };
          const merged = mergeExtensionConfig(current, candidate);
          assert.equal(merged.instanceId, 'stable');
          assert.equal(merged.auth.token, 'owner-token');
          assert.equal(merged.auth.required, false);
          assert.equal(merged.task.currentTaskId, 'task-1');
          assert.equal(merged.runtime.maxConcurrentJobs, 4);
          assert.equal(merged.runtime.defaultCommandTimeoutMs, 2000);
          assert.equal(merged.workspaces.some(item => item.id === 'trusted'), true);
        });

        test('partial extension updates preserve existing workspaces', () => {
          const current = {
            version: SUPPORTED_CONFIG_VERSION,
            instanceId: 'stable',
            workspaces: [
              { id: 'app', root: '/workspace/app' },
              { id: 'docs', root: '/workspace/docs', reference: true, mode: 'readonly' },
              { id: 'trusted', root: '/workspace/shared', trusted: true, role: 'trusted' }
            ]
          };
          const merged = mergeExtensionConfig(current, {
            version: SUPPORTED_CONFIG_VERSION,
            connection: { lastPreflightAt: 'now' }
          });
          assert.deepEqual(merged.workspaces, current.workspaces);
          assert.equal(merged.connection.lastPreflightAt, 'now');
        });

        test('writes through the shared locked atomic store', () => {
          const file = tempFile();
          writeExtensionConfig(file, {
            version: SUPPORTED_CONFIG_VERSION,
            instanceId: 'one',
            auth: { required: true, token: 'secret' }
          });
          writeExtensionConfig(file, {
            version: SUPPORTED_CONFIG_VERSION,
            instanceId: 'stale',
            connection: { lastPreflightAt: 'now' }
          });
          const config = readExtensionConfig(file);
          assert.equal(config.instanceId, 'one');
          assert.equal(config.auth.token, 'secret');
          assert.equal(config.connection.lastPreflightAt, 'now');
        });

        test('rejects malformed and future configuration without replacement', () => {
          const malformed = tempFile();
          fs.writeFileSync(malformed, '{broken', 'utf8');
          assert.throws(() => writeExtensionConfig(malformed, { version: SUPPORTED_CONFIG_VERSION }),
            error => error.code === 'config_invalid_json');

          const future = tempFile();
          const original = `${JSON.stringify({ version: SUPPORTED_CONFIG_VERSION + 1 })}\n`;
          fs.writeFileSync(future, original, 'utf8');
          assert.throws(() => writeExtensionConfig(future, { version: SUPPORTED_CONFIG_VERSION }),
            error => error.code === 'unsupported_config_version');
          assert.equal(fs.readFileSync(future, 'utf8'), original);
        });
