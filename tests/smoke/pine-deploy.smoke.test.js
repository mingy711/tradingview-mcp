import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupConnection } from '../helpers/mock-cdp.js';
import { deployScript, deriveCleanMatch } from '../../src/core/pine-deploy.js';

describe('core/pine-deploy.js — smoke', () => {
  after(async () => { await cleanupConnection(); });

  // ── deriveCleanMatch ──────────────────────────────────────────────
  it('derives title from indicator() declaration', () => {
    const src = `//@version=6
indicator("My Cool RSI", overlay=true)
// ...`;
    assert.equal(deriveCleanMatch(src, '/x/foo.pine'), 'My Cool RSI');
  });

  it('derives title from strategy() declaration', () => {
    const src = `strategy('NQ Reversal v3', shorttitle='NQR')`;
    assert.equal(deriveCleanMatch(src, '/x/foo.pine'), 'NQ Reversal v3');
  });

  it('handles multi-line indicator declaration', () => {
    const src = `indicator(
      title = "Multiline Title",
      overlay = true,
      max_lines_count = 500,
    )`;
    assert.equal(deriveCleanMatch(src, '/x/foo.pine'), 'Multiline Title');
  });

  it('falls back to file basename when no declaration found', () => {
    assert.equal(deriveCleanMatch('// nothing', '/a/b/my-script.pine'), 'my-script');
    assert.equal(deriveCleanMatch('// nothing', 'C:\\path\\thing.pine'), 'thing');
  });

  // ── deployScript orchestration (inject pine + chart stubs) ────────
  // Build fake pine + chart modules that record the call order, so we
  // verify orchestration without exercising the underlying setSource /
  // save / smartCompile logic (those have their own smoke files).
  function makeStubs(overrides = {}) {
    const calls = [];
    const chart = {
      removeStudiesByTitle: async (args) => {
        calls.push(['chart.removeStudiesByTitle', args.title_match]);
        return overrides.removeResult || { removed: ['old'], matched: ['old'] };
      },
    };
    const pine = {
      setSource: async ({ source }) => { calls.push(['pine.setSource', source.length]); return { success: true }; },
      save: async () => { calls.push(['pine.save']); return { success: true }; },
      smartCompile: async () => {
        calls.push(['pine.smartCompile']);
        return overrides.compile || { study_added: true, matched_study: 'Test', pine_title: 'Test' };
      },
      getErrors: async () => { calls.push(['pine.getErrors']); return { errors: overrides.errors || [] }; },
    };
    return { pine, chart, calls };
  }

  it('reads source, pre-cleans, sets, saves, compiles, returns shape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pine-deploy-'));
    try {
      const path = join(dir, 'TestRSI.pine');
      const src = '//@version=6\nindicator("Test RSI", overlay=false)\nplot(close)';
      writeFileSync(path, src);
      const { pine, chart, calls } = makeStubs();
      const r = await deployScript({ pinePath: path, cleanMatch: 'Test RSI', _deps: { pine, chart } });
      assert.equal(r.success, true);
      assert.equal(r.file, path);
      assert.equal(r.source_bytes, src.length);
      assert.deepEqual(r.pre_cleaned, { match: 'Test RSI', removed: ['old'], matched: ['old'] });
      assert.equal(r.study_added, true);
      // Verify call order: pre-clean → setSource → save → smartCompile → getErrors
      assert.deepEqual(calls.map(c => c[0]), [
        'chart.removeStudiesByTitle', 'pine.setSource', 'pine.save', 'pine.smartCompile', 'pine.getErrors',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('auto-derives cleanMatch from indicator() when not provided', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pine-deploy-'));
    try {
      const path = join(dir, 'AutoDerive.pine');
      writeFileSync(path, 'indicator("Auto Cool Title", overlay=true)\nplot(0)');
      const { pine, chart, calls } = makeStubs();
      const r = await deployScript({ pinePath: path, _deps: { pine, chart } });
      assert.equal(r.pre_cleaned.match, 'Auto Cool Title');
      assert.equal(calls[0][1], 'Auto Cool Title');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cleanMatch=null skips pre-clean entirely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pine-deploy-'));
    try {
      const path = join(dir, 'NoClean.pine');
      writeFileSync(path, 'indicator("NoClean")\nplot(close)');
      const { pine, chart, calls } = makeStubs();
      const r = await deployScript({ pinePath: path, cleanMatch: null, _deps: { pine, chart } });
      assert.equal(r.pre_cleaned, null);
      assert.ok(!calls.some(c => c[0] === 'chart.removeStudiesByTitle'), 'no pre-clean call');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports errors from Monaco and sets success=false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pine-deploy-'));
    try {
      const path = join(dir, 'Broken.pine');
      writeFileSync(path, 'indicator("Broken")\nbroken_syntax(');
      const { pine, chart } = makeStubs({
        errors: [{ line: 2, column: 14, message: 'Mismatched paren', severity: 8 }],
      });
      const r = await deployScript({ pinePath: path, cleanMatch: null, _deps: { pine, chart } });
      assert.equal(r.success, false);
      assert.equal(r.errors.length, 1);
      assert.match(r.errors[0].message, /paren/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pre-clean failure does not abort deploy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pine-deploy-'));
    try {
      const path = join(dir, 'PreCleanFails.pine');
      writeFileSync(path, 'indicator("PCFail")\nplot(0)');
      const { pine, chart: realChart, calls } = makeStubs();
      const chart = {
        ...realChart,
        removeStudiesByTitle: async () => { calls.push(['chart.removeStudiesByTitle:THREW']); throw new Error('CDP busy'); },
      };
      const r = await deployScript({ pinePath: path, _deps: { pine, chart } });
      assert.equal(r.pre_cleaned.error, 'CDP busy');
      assert.equal(r.success, true, 'deploy proceeds even when pre-clean errors');
      assert.ok(calls.some(c => c[0] === 'pine.smartCompile'), 'smartCompile still ran');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on empty file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pine-deploy-'));
    try {
      const path = join(dir, 'empty.pine');
      writeFileSync(path, '   \n  \n');
      await assert.rejects(() => deployScript({ pinePath: path }), /empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when pinePath missing', async () => {
    await assert.rejects(() => deployScript({}), /pinePath is required/);
  });
});
