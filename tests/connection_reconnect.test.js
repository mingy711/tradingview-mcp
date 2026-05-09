/**
 * Unit tests for withReconnect retry semantics. The test injects a mock
 * operation that throws reconnect-class errors a configurable number of
 * times before succeeding, and asserts the retry count + final outcome.
 *
 * Note: withReconnect calls getClient() under the hood; we install a stub
 * via __setTestOverrides so no live CDP is needed.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withReconnect, __setTestOverrides } from '../src/connection.js';

describe('withReconnect', () => {
  before(() => {
    __setTestOverrides({ getClient: async () => ({ id: 'fake-client' }) });
  });
  after(() => { __setTestOverrides(null); });

  it('returns the operation result on first success', async () => {
    let calls = 0;
    const op = async () => { calls++; return 'ok'; };
    const r = await withReconnect(op);
    assert.equal(r, 'ok');
    assert.equal(calls, 1);
  });

  it('retries on a reconnect-class error and succeeds on the 2nd attempt', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls === 1) throw new Error('connection closed unexpectedly');
      return 'recovered';
    };
    const r = await withReconnect(op, 3);
    assert.equal(r, 'recovered');
    assert.equal(calls, 2);
  });

  it('throws non-reconnect errors immediately without retry', async () => {
    let calls = 0;
    const op = async () => { calls++; throw new Error('something else broke'); };
    await assert.rejects(() => withReconnect(op, 5), /something else broke/);
    assert.equal(calls, 1);
  });

  it('gives up after maxRetries reconnect failures', async () => {
    let calls = 0;
    const op = async () => { calls++; throw new Error('websocket dead'); };
    await assert.rejects(
      () => withReconnect(op, 2),
      /CDP operation failed after 2 reconnect attempts/
    );
    assert.equal(calls, 2);
  });

  it('matches all reconnect error patterns', async () => {
    const patterns = [
      'connection closed',
      'WebSocket is not open',
      'ECONNREFUSED',
      'target closed',
      'liveness timeout',
      'socket hang up',
      'disconnected',
    ];
    for (const msg of patterns) {
      let calls = 0;
      const op = async () => {
        calls++;
        if (calls === 1) throw new Error(msg);
        return 'recovered';
      };
      const r = await withReconnect(op, 2);
      assert.equal(r, 'recovered', `pattern "${msg}" should trigger retry`);
    }
  });

  it('honors test override when one is installed', async () => {
    __setTestOverrides({
      getClient: async () => ({ id: 'fake-client' }),
      withReconnect: async (op) => 'overridden',
    });
    const r = await withReconnect(async () => 'real-result');
    assert.equal(r, 'overridden');
    __setTestOverrides({ getClient: async () => ({ id: 'fake-client' }) });
  });
});
