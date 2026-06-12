import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Each test must import a FRESH copy of connection.js because parseFilter
// reads TV_MCP_TARGET_FILTER at module-load time. We use a dynamic import
// with a cache-busting query.
let importIdx = 0;
async function freshImport(envOverride = {}) {
  importIdx++;
  for (const [k, v] of Object.entries(envOverride)) process.env[k] = v;
  return import(`../../src/connection.js?bust=${importIdx}`);
}
function clearEnv() {
  delete process.env.TV_MCP_TARGET_FILTER;
}

describe('connection.js — pin + filter (smoke)', () => {
  beforeEach(() => clearEnv());
  afterEach(() => clearEnv());

  it('getActiveFilter() returns null when env unset', async () => {
    const c = await freshImport();
    assert.equal(c.getActiveFilter(), null);
  });

  it('parses symbol=VALUE filter', async () => {
    const c = await freshImport({ TV_MCP_TARGET_FILTER: 'symbol=COMEX:GC1!' });
    assert.deepEqual(c.getActiveFilter(), { field: 'symbol', op: '=', value: 'COMEX:GC1!' });
  });

  it('parses title~SUBSTRING filter (case-insensitive op kept as-is)', async () => {
    const c = await freshImport({ TV_MCP_TARGET_FILTER: 'title~ICC' });
    assert.deepEqual(c.getActiveFilter(), { field: 'title', op: '~', value: 'ICC' });
  });

  it('parses url=SUBSTRING filter', async () => {
    const c = await freshImport({ TV_MCP_TARGET_FILTER: 'url=chart/BdrFz9HL' });
    assert.deepEqual(c.getActiveFilter(), { field: 'url', op: '=', value: 'chart/BdrFz9HL' });
  });

  it('rejects malformed filter string', async () => {
    process.env.TV_MCP_TARGET_FILTER = 'nope';
    await assert.rejects(() => import(`../../src/connection.js?bust=bad-${importIdx++}`), /Invalid TV_MCP_TARGET_FILTER/);
  });

  it('setPin / getPin / clearPin round-trip', async () => {
    const c = await freshImport();
    assert.equal(c.getPin(), null);
    c.setPin('target_xyz');
    assert.equal(c.getPin(), 'target_xyz');
    c.clearPin();
    assert.equal(c.getPin(), null);
  });

  it('CDP_HOST defaults to 127.0.0.1 (not localhost) to avoid IPv6 resolution path', async () => {
    delete process.env.TV_CDP_HOST;
    const c = await freshImport();
    assert.equal(c.CDP_HOST, '127.0.0.1');
  });

  it('CDP_HOST honors TV_CDP_HOST env override', async () => {
    const c = await freshImport({ TV_CDP_HOST: 'remote.docker.internal' });
    assert.equal(c.CDP_HOST, 'remote.docker.internal');
    delete process.env.TV_CDP_HOST;
  });
});
