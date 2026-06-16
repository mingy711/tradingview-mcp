/**
 * Unit tests for removeStudiesByTitle — title-substring match removal via
 * chart.getAllStudies() + chart.removeEntity(). Stubs evaluate() to fake the
 * page-side study list and capture the JS that would run remotely.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { removeStudiesByTitle } from '../src/core/chart.js';

function makeDeps({ studies, removeThrowsFor = new Set() }) {
  const calls = [];
  const evaluate = async (expr) => {
    calls.push(expr);
    // Simulate the IIFE: parse the embedded `target` string and walk `studies`.
    const targetMatch = expr.match(/var target = "([^"]+)"/);
    const target = targetMatch ? targetMatch[1] : '';
    const matched = [];
    const removed = [];
    for (const s of studies) {
      if (String(s.name).toLowerCase().indexOf(target) !== -1) {
        matched.push({ id: s.id, name: s.name });
        if (!removeThrowsFor.has(s.id)) removed.push({ id: s.id, name: s.name });
      }
    }
    return { matched, removed };
  };
  return { evaluate, calls };
}

describe('removeStudiesByTitle', () => {
  it('removes all studies matching the substring (case-insensitive)', async () => {
    const deps = makeDeps({
      studies: [
        { id: 'st-1', name: 'SMC Engine v3' },
        { id: 'st-2', name: 'Volume Profile' },
        { id: 'st-3', name: 'smc engine helper' },
      ],
    });
    const r = await removeStudiesByTitle({ title_match: 'smc engine', _deps: deps });
    assert.equal(r.success, true);
    assert.deepEqual(r.removed.map(x => x.id).sort(), ['st-1', 'st-3']);
    assert.equal(r.matched.length, 2);
  });

  it('returns empty matched/removed when nothing matches', async () => {
    const deps = makeDeps({
      studies: [{ id: 'st-1', name: 'RSI' }],
    });
    const r = await removeStudiesByTitle({ title_match: 'macd', _deps: deps });
    assert.equal(r.success, true);
    assert.deepEqual(r.matched, []);
    assert.deepEqual(r.removed, []);
  });

  it('reports success=false when removeEntity throws for a matched study', async () => {
    const deps = makeDeps({
      studies: [
        { id: 'st-1', name: 'SMC Engine' },
        { id: 'st-2', name: 'SMC Engine v2' },
      ],
      removeThrowsFor: new Set(['st-2']),
    });
    const r = await removeStudiesByTitle({ title_match: 'smc', _deps: deps });
    assert.equal(r.success, false);
    assert.equal(r.matched.length, 2);
    assert.equal(r.removed.length, 1);
    assert.equal(r.removed[0].id, 'st-1');
  });

  it('rejects empty / non-string title_match', async () => {
    const deps = makeDeps({ studies: [] });
    await assert.rejects(() => removeStudiesByTitle({ title_match: '', _deps: deps }), /title_match required/);
    await assert.rejects(() => removeStudiesByTitle({ title_match: null, _deps: deps }), /title_match required/);
    await assert.rejects(() => removeStudiesByTitle({ title_match: 42, _deps: deps }), /title_match required/);
  });

  it('passes a JSON-encoded lowercase target into the evaluated JS (injection-safe)', async () => {
    const deps = makeDeps({ studies: [] });
    await removeStudiesByTitle({ title_match: 'BadName"; alert(1); //', _deps: deps });
    const expr = deps.calls[0];
    // safeString → JSON.stringify; the embedded literal must be a valid quoted
    // string and lowercased.
    assert.match(expr, /var target = "badname\\"; alert\(1\); \/\/"/);
  });
});
