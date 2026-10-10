import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { DomainError } from './store.mjs';

const fail = (code, message) => new DomainError(code, message);
export class InputRequests {
  constructor(store) {
    this.store = store;
    this.pending = new Map();
    this.validator = new AjvJsonSchemaValidator();
    this.closed = false;
  }
  request({ projectId, serverId, method, params, signal }) {
    if (this.closed || signal?.aborted) return Promise.reject(fail('request_cancelled', 'The originating request has ended.'));
    if (method !== 'elicitation/create' || (params.mode && params.mode !== 'form') || !params.requestedSchema) {
      return Promise.reject(fail('unsupported_input', 'This connection supports MCP form elicitation.'));
    }
    const validate = this.validator.getValidator(params.requestedSchema);
    const item = this.store.create('input', {
      projectId, source: 'mcp', serverId, kind: 'elicitation', details: params,
      status: 'pending', prompt: params.message || 'MCP input requested'
    });
    return new Promise((resolve, reject) => {
      const abort = () => {
        const current = this.pending.get(item.id);
        if (!current) return;
        this.pending.delete(item.id);
        signal?.removeEventListener('abort', abort);
        // This runs from an abort event: a failed state write must not escape as an uncaught exception.
        try { this.store.update('input', item.id, { status: 'expired' }); } catch (error) { this.store.recordNotificationFailure?.(error); }
        reject(fail('request_cancelled', 'The originating request has ended.'));
      };
      this.pending.set(item.id, { resolve, reject, validate, signal, abort });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  respond({ id, response, expectedRevision }) {
    const item = this.store.get('input', id);
    const pending = this.pending.get(id);
    if (item.status !== 'pending' || !pending) throw fail('request_expired', 'This input request is no longer waiting.');
    if (!response || typeof response !== 'object' || Array.isArray(response) ||
        Object.keys(response).some(key => !['action', 'content'].includes(key)) ||
        !['accept', 'decline', 'cancel'].includes(response.action)) throw fail('invalid_response', 'Choose accept, decline or cancel.');
    if (response.action === 'accept') {
      const check = pending.validate(response.content);
      if (!check.valid) throw fail('invalid_response', check.errorMessage);
    } else if (response.content !== undefined) throw fail('invalid_response', 'Decline and cancel do not include form content.');
    // Answers can contain sensitive form data; the journal records only the decision.
    const result = this.store.update('input', id, { status: 'resolved', action: response.action }, expectedRevision);
    this.pending.delete(id);
    pending.signal?.removeEventListener('abort', pending.abort);
    pending.resolve(response);
    return result;
  }
  close() {
    this.closed = true;
    for (const pending of [...this.pending.values()]) pending.abort();
  }
}
