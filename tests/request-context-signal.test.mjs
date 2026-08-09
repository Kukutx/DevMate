import assert from 'node:assert/strict';
import test from 'node:test';
import {
  requestContext,
  requestSignal,
  runWithRequestContext,
  runWithRequestSignal,
  runWithWorkSessionContext
} from '../gateway/request-context.mjs';

test('request signal composes with request and work-session context', async () => {
  const controller = new AbortController();
  await runWithRequestContext({ requestId: 'req-1', principal: { id: 'owner' } }, async () => {
    await runWithRequestSignal(controller.signal, async () => {
      await runWithWorkSessionContext('session-1', async () => {
        assert.equal(requestSignal(), controller.signal);
        assert.equal(requestContext().requestId, 'req-1');
        assert.equal(requestContext().principal.id, 'owner');
        assert.equal(requestContext().workSessionId, 'session-1');
      });
    });
  });
});
