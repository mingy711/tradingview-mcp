import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { installCdpMocks, resetCdpMocks, cleanupConnection } from '../helpers/mock-cdp.js';
import { evaluateChecked } from '../../src/connection.js';

// evaluateChecked wraps an expression with page-side JSON.stringify +
// length checksum. The mock receives the wrapped expression and returns
// what the page would have produced for that wrapped form.
function pageReturn(value) {
  if (value === undefined) return { __s: 'undefined', __sz: 9, __isUndef: true };
  const s = JSON.stringify(value);
  return { __s: s, __sz: s.length };
}

describe('evaluateChecked — smoke', () => {
  after(async () => { resetCdpMocks(); await cleanupConnection(); });

  it('round-trips a flat object', async () => {
    installCdpMocks({ evaluate: async () => pageReturn({ a: 1, b: 'two' }) });
    const r = await evaluateChecked('whatever()');
    assert.deepEqual(r, { a: 1, b: 'two' });
  });

  it('round-trips arrays of primitives', async () => {
    installCdpMocks({ evaluate: async () => pageReturn([1, 2, 3, 4, 5]) });
    const r = await evaluateChecked('whatever()');
    assert.deepEqual(r, [1, 2, 3, 4, 5]);
  });

  it('round-trips null and zero correctly', async () => {
    installCdpMocks({ evaluate: async () => pageReturn(null) });
    assert.equal(await evaluateChecked('null'), null);
    installCdpMocks({ evaluate: async () => pageReturn(0) });
    assert.equal(await evaluateChecked('0'), 0);
    installCdpMocks({ evaluate: async () => pageReturn(false) });
    assert.equal(await evaluateChecked('false'), false);
    installCdpMocks({ evaluate: async () => pageReturn('') });
    assert.equal(await evaluateChecked('""'), '');
  });

  it('returns undefined when the page expression returns undefined', async () => {
    installCdpMocks({ evaluate: async () => pageReturn(undefined) });
    assert.equal(await evaluateChecked('void 0'), undefined);
  });

  it('surfaces page-side runtime errors with label', async () => {
    installCdpMocks({ evaluate: async () => ({ __err: 'page-side eval: foo is not defined' }) });
    await assert.rejects(
      () => evaluateChecked('foo()', { label: 'getFoo' }),
      /getFoo: page-side eval: foo is not defined/,
    );
  });

  it('surfaces page-side JSON.stringify failures (cycles, BigInt)', async () => {
    installCdpMocks({ evaluate: async () => ({ __err: "page-side JSON.stringify: Converting circular structure to JSON" }) });
    await assert.rejects(
      () => evaluateChecked('cyclicThing'),
      /circular structure/,
    );
  });

  it('detects CDP-side truncation via length checksum', async () => {
    // Simulate: page-side computed sz=1000 bytes, but CDP delivered only 500.
    installCdpMocks({ evaluate: async () => ({ __s: 'x'.repeat(500), __sz: 1000 }) });
    await assert.rejects(
      () => evaluateChecked('bigPayload()', { label: 'pineLabels' }),
      /pineLabels: CDP truncated response \(page-side 1000 bytes, client-side 500 bytes\)/,
    );
  });

  it('throws on malformed wrapper response (no __s field)', async () => {
    installCdpMocks({ evaluate: async () => ({ random: 'shape' }) });
    await assert.rejects(
      () => evaluateChecked('whatever'),
      /malformed wrapper response/,
    );
  });

  it('throws when client-side JSON.parse fails on corrupted payload', async () => {
    // Page-side and client-side lengths match, but the string is not valid JSON.
    installCdpMocks({ evaluate: async () => ({ __s: 'not-json', __sz: 8 }) });
    await assert.rejects(
      () => evaluateChecked('whatever'),
      /JSON\.parse failed/,
    );
  });

  it('uses default "evaluate" label when none provided', async () => {
    installCdpMocks({ evaluate: async () => ({ __err: 'page-side eval: x' }) });
    await assert.rejects(
      () => evaluateChecked('x()'),
      /^Error: evaluate: page-side eval: x$/,
    );
  });

  it('handles deeply-nested objects (no chain-too-long since CDP only ships a string)', async () => {
    const deep = { a: { b: { c: { d: { e: { f: 'leaf' } } } } } };
    installCdpMocks({ evaluate: async () => pageReturn(deep) });
    const r = await evaluateChecked('deep()');
    assert.deepEqual(r, deep);
  });

  it('handles arrays of objects (typical Pine graphics payload shape)', async () => {
    const labels = Array.from({ length: 50 }, (_, i) => ({
      text: `Label ${i}`, price: 100 + i, time: 1700000000 + i * 60,
    }));
    installCdpMocks({ evaluate: async () => pageReturn(labels) });
    const r = await evaluateChecked('getLabels()');
    assert.equal(r.length, 50);
    assert.equal(r[49].text, 'Label 49');
  });

  it('respects evaluateChecked test override (falls through bypass)', async () => {
    let called = false;
    installCdpMocks({
      evaluate: async () => { throw new Error('should not be called'); },
      evaluateChecked: async (expr) => { called = true; return { mocked: true, expr }; },
    });
    const r = await evaluateChecked('whatever');
    assert.equal(called, true);
    assert.equal(r.mocked, true);
  });
});
