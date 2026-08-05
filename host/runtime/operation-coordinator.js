'use strict';

class OperationCoordinator {
  constructor({ name = 'operation' } = {}) {
    this.name = String(name || 'operation');
    this.tail = Promise.resolve();
    this.current = null;
    this.queued = 0;
    this.sequence = 0;
  }

  run(label, operation) {
    if (typeof operation !== 'function') throw new TypeError('Operation callback must be a function');
    const id = ++this.sequence;
    const name = String(label || this.name);
    this.queued += 1;

    const task = this.tail
      .catch(() => undefined)
      .then(async () => {
        this.queued = Math.max(0, this.queued - 1);
        this.current = { id, name, startedAt: new Date().toISOString() };
        try {
          return await operation(this.current);
        } finally {
          if (this.current?.id === id) this.current = null;
        }
      });

    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }

  snapshot() {
    return {
      name: this.name,
      current: this.current ? { ...this.current } : null,
      queued: this.queued,
      sequence: this.sequence
    };
  }

  async idle() {
    await this.tail;
  }
}

module.exports = { OperationCoordinator };
