/**
 * Smoke tests — src/core/chart.js.
 */
import { describe, it, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { installCdpMocks, resetCdpMocks, cleanupConnection } from '../helpers/mock-cdp.js';
import * as chart from '../../src/core/chart.js';

describe('core/chart.js — setSymbol verification (post-call retry)', () => {
  afterEach(() => resetCdpMocks());
  after(cleanupConnection);

  it('test_setSymbol_throws_when_change_silently_failed_even_after_hard_reload', async () => {
    // Worst-case stuck state: dialog dismissal didn't help, hard reload
    // (Page.reload) succeeded but TV is still pinned to the old symbol.
    // The wrapper has tried everything — throws SYMBOL_DID_NOT_CHANGE with
    // hard_reloaded:true so the caller knows recovery was attempted.
    let dismissedCalls = 0;
    let reloadCalls = 0;
    installCdpMocks({
      evaluate: async (expr) => {
        if (typeof expr === 'string' && /\.symbol\(\)/.test(expr) && !expr.includes('setSymbol')) {
          return 'CME_MINI:ESM2026'; // stuck — never changes
        }
        return undefined;
      },
      evaluateAsync: async () => undefined,
    });
    await assert.rejects(
      chart.setSymbol({
        symbol: 'NASDAQ:AAPL',
        _deps: {
          waitForChartReady: async () => true,
          waitForStudiesReady: async () => true,
          dismissBlockingDialogs: async () => { dismissedCalls++; return [{ note: 'leave_replay', button: 'Leave' }]; },
          getClient: async () => ({ Page: { reload: async () => { reloadCalls++; } } }),
          disconnect: async () => {},
        },
      }),
      (err) => {
        assert.equal(err.code, 'SYMBOL_DID_NOT_CHANGE');
        assert.equal(err.requested, 'NASDAQ:AAPL');
        assert.equal(err.actual, 'CME_MINI:ESM2026');
        assert.deepEqual(err.dismissed_dialogs, [{ note: 'leave_replay', button: 'Leave' }]);
        assert.equal(err.hard_reloaded, true);
        return true;
      },
    );
    assert.equal(dismissedCalls, 1, 'dismissBlockingDialogs invoked exactly once on retry');
    assert.equal(reloadCalls, 1, 'Page.reload invoked exactly once as last-resort');
  });

  it('test_setSymbol_recovers_from_error_overlay_via_hard_reload', async () => {
    // The "JS API matches but chart shows error overlay" case: chart.symbol()
    // returns the requested symbol so the dialog-dismiss path is skipped,
    // but the chart canvas shows "This symbol doesn't exist". setSymbol
    // escalates straight to hard reload, which clears the overlay.
    let reloaded = false;
    let reloadCalls = 0;
    installCdpMocks({
      evaluate: async (expr) => {
        if (typeof expr === 'string' && /getAllStudies/.test(expr)) {
          return [];
        }
        if (typeof expr === 'string' && /\.symbol\(\)/.test(expr) && !expr.includes('setSymbol')) {
          // JS API matches from the start — this is the trickier stuck state
          return 'CME_MINI:NQM2026';
        }
        if (typeof expr === 'string' && /errorCard|noDataHere/.test(expr)) {
          // Overlay detection: present before reload, gone after
          return reloaded ? null : "This symbol doesn't exist";
        }
        return undefined;
      },
      evaluateAsync: async () => undefined,
    });
    const r = await chart.setSymbol({
      symbol: 'CME_MINI:NQM2026',
      _deps: {
        waitForChartReady: async () => true,
        waitForStudiesReady: async () => true,
        dismissBlockingDialogs: async () => [],
        getClient: async () => ({
          Page: { reload: async () => { reloadCalls++; reloaded = true; } },
        }),
        disconnect: async () => {},
      },
    });
    assert.equal(r.success, true);
    assert.equal(r.symbol, 'CME_MINI:NQM2026');
    assert.equal(r.hard_reloaded, true);
    assert.equal(reloadCalls, 1, 'hard reload fired once');
  });

  it('test_setSymbol_throws_SYMBOL_LOAD_ERROR_when_overlay_persists', async () => {
    // Overlay stays even after hard reload — caller gets the distinct
    // SYMBOL_LOAD_ERROR code so they can route it differently from the
    // JS-API-mismatch case.
    installCdpMocks({
      evaluate: async (expr) => {
        if (typeof expr === 'string' && /getAllStudies/.test(expr)) return [];
        if (typeof expr === 'string' && /\.symbol\(\)/.test(expr) && !expr.includes('setSymbol')) {
          return 'CME_MINI:NQM2026';
        }
        if (typeof expr === 'string' && /errorCard|noDataHere/.test(expr)) {
          return "This symbol doesn't exist"; // never clears
        }
        return undefined;
      },
      evaluateAsync: async () => undefined,
    });
    await assert.rejects(
      chart.setSymbol({
        symbol: 'CME_MINI:NQM2026',
        _deps: {
          waitForChartReady: async () => true,
          waitForStudiesReady: async () => true,
          dismissBlockingDialogs: async () => [],
          getClient: async () => ({ Page: { reload: async () => {} } }),
          disconnect: async () => {},
        },
      }),
      (err) => {
        assert.equal(err.code, 'SYMBOL_LOAD_ERROR');
        assert.equal(err.error_overlay, "This symbol doesn't exist");
        assert.equal(err.hard_reloaded, true);
        return true;
      },
    );
  });

  it('test_setSymbol_surfaces_inert_pine_studies_after_hard_reload', async () => {
    // After hard reload, TV restores a user Pine study to the layout but
    // doesn't refetch its source — meta.pine.source is null and _indexes
    // stays empty. The wrapper detects both and surfaces inert_studies
    // so the caller doesn't waste time debugging empty data tools.
    let reloaded = false;
    installCdpMocks({
      evaluate: async (expr) => {
        if (typeof expr === 'string' && /getAllStudies/.test(expr)) return [];
        if (typeof expr === 'string' && /\.symbol\(\)/.test(expr) && !expr.includes('setSymbol')) {
          return 'CME_MINI:NQM2026';
        }
        if (typeof expr === 'string' && /errorCard|noDataHere/.test(expr)) {
          return reloaded ? null : "This symbol doesn't exist";
        }
        if (typeof expr === 'string' && /isTVScript/.test(expr)) {
          // Inert detection probe — return one inert Pine study
          return [{
            id: 'vxpejS',
            name: '-4 CB Model Indicator',
            scriptIdPart: 'USER;0da8b34c1497447d88653feb5bf9f33d',
            indexes_count: 0,
          }];
        }
        return undefined;
      },
      evaluateAsync: async () => undefined,
    });
    const r = await chart.setSymbol({
      symbol: 'CME_MINI:NQM2026',
      _deps: {
        waitForChartReady: async () => true,
        waitForStudiesReady: async () => true,
        dismissBlockingDialogs: async () => [],
        getClient: async () => ({ Page: { reload: async () => { reloaded = true; } } }),
        disconnect: async () => {},
      },
    });
    assert.equal(r.success, true);
    assert.equal(r.hard_reloaded, true);
    assert.ok(Array.isArray(r.inert_studies), 'inert_studies populated');
    assert.equal(r.inert_studies.length, 1);
    assert.equal(r.inert_studies[0].name, '-4 CB Model Indicator');
    assert.equal(r.inert_studies[0].indexes_count, 0);
    assert.ok(r.inert_studies_hint.includes('Pine editor'), 'hint mentions Pine editor');
  });

  it('test_setSymbol_recovers_via_hard_reload', async () => {
    // Stuck through both the first attempt and dialog dismissal; only the
    // hard reload (Page.reload) breaks the stuck state. Mock flips
    // chart.symbol() to the requested value only after reload runs.
    let reloaded = false;
    let reloadCalls = 0;
    installCdpMocks({
      evaluate: async (expr) => {
        if (typeof expr === 'string' && /getAllStudies/.test(expr)) {
          return [{ id: 's1', name: 'RSI' }];
        }
        if (typeof expr === 'string' && /\.symbol\(\)/.test(expr) && !expr.includes('setSymbol')) {
          return reloaded ? 'NASDAQ:AAPL' : 'CME_MINI:ESM2026';
        }
        return undefined;
      },
      evaluateAsync: async () => undefined,
    });
    const r = await chart.setSymbol({
      symbol: 'NASDAQ:AAPL',
      _deps: {
        waitForChartReady: async () => true,
        waitForStudiesReady: async () => true,
        dismissBlockingDialogs: async () => [{ note: 'leave_replay', button: 'Leave' }],
        getClient: async () => ({
          Page: { reload: async () => { reloadCalls++; reloaded = true; } },
        }),
        disconnect: async () => {},
      },
    });
    assert.equal(r.success, true);
    assert.equal(r.symbol, 'NASDAQ:AAPL');
    assert.equal(r.hard_reloaded, true);
    assert.deepEqual(r.prior_studies, [{ id: 's1', name: 'RSI' }]);
    assert.equal(reloadCalls, 1);
  });

  it('test_setSymbol_succeeds_when_actual_matches_after_normalize', async () => {
    // TV resolves 'AAPL' to 'NASDAQ:AAPL' or 'BATS:AAPL'; the verify check
    // strips the exchange prefix before comparing.
    installCdpMocks({
      evaluate: async (expr) => {
        if (typeof expr === 'string' && /\.symbol\(\)/.test(expr) && !expr.includes('setSymbol')) {
          return 'BATS:AAPL';
        }
        return undefined;
      },
      evaluateAsync: async () => undefined,
    });
    const r = await chart.setSymbol({
      symbol: 'AAPL',
      _deps: {
        waitForChartReady: async () => true,
        waitForStudiesReady: async () => true,
        dismissBlockingDialogs: async () => [],
      },
    });
    assert.equal(r.success, true);
    assert.equal(r.symbol, 'BATS:AAPL');
    assert.equal(r.requested, 'AAPL');
  });

  it('test_setSymbol_succeeds_after_retry_dismissing_dialog', async () => {
    // Stage-based mock: chart.symbol() stays stuck until dismissBlockingDialogs
    // runs, at which point the dialog is "closed" and TV finally applies the
    // pending symbol switch. This reproduces the path where a Leave-replay
    // dialog absorbed the change and dismissing it lets the retry succeed.
    let dialogDismissed = false;
    let dismissedCalls = 0;
    installCdpMocks({
      evaluate: async (expr) => {
        if (typeof expr === 'string' && /\.symbol\(\)/.test(expr) && !expr.includes('setSymbol')) {
          return dialogDismissed ? 'NASDAQ:AAPL' : 'CME_MINI:ESM2026';
        }
        return undefined;
      },
      evaluateAsync: async () => undefined,
    });
    const r = await chart.setSymbol({
      symbol: 'NASDAQ:AAPL',
      _deps: {
        waitForChartReady: async () => true,
        waitForStudiesReady: async () => true,
        dismissBlockingDialogs: async () => {
          dismissedCalls++;
          dialogDismissed = true;
          return [{ note: 'leave_replay', button: 'Leave' }];
        },
      },
    });
    assert.equal(r.success, true);
    assert.equal(r.symbol, 'NASDAQ:AAPL');
    assert.deepEqual(r.dismissed_dialogs, [{ note: 'leave_replay', button: 'Leave' }]);
    assert.equal(dismissedCalls, 1);
  });
});

describe('core/chart.js — smoke', () => {
  afterEach(() => resetCdpMocks());
  after(cleanupConnection);

  it('test_getState_smoke', async () => {
    installCdpMocks({
      evaluate: async () => ({ symbol: 'AAPL', resolution: 'D', chartType: 1, studies: [] }),
    });
    const r = await chart.getState();
    assert.equal(r.success, true);
    assert.equal(r.symbol, 'AAPL');
  });

  it('test_setSymbol_smoke', async () => {
    const deps = {
      evaluate: async (expr) => {
        // setSymbol's verification reads .symbol() — echo back so the check passes
        if (typeof expr === 'string' && /\.symbol\(\)/.test(expr) && !expr.includes('setSymbol')) {
          return 'NVDA';
        }
        return undefined;
      },
      evaluateAsync: async () => undefined,
      waitForChartReady: async () => true,
      waitForStudiesReady: async () => true,
      dismissBlockingDialogs: async () => [],
    };
    const r = await chart.setSymbol({ symbol: 'NVDA', _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.symbol, 'NVDA');
    assert.equal(r.chart_ready, true);
  });

  it('test_setTimeframe_smoke', async () => {
    const deps = {
      evaluate: async () => undefined,
      waitForChartReady: async () => true,
    };
    const r = await chart.setTimeframe({ timeframe: '5', _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.timeframe, '5');
  });

  it('test_setType_smoke_byName', async () => {
    const r = await chart.setType({ chart_type: 'Candles', _deps: { evaluate: async () => undefined } });
    assert.equal(r.success, true);
    assert.equal(r.type_num, 1);
  });

  it('test_setType_smoke_byNumber', async () => {
    const r = await chart.setType({ chart_type: '8', _deps: { evaluate: async () => undefined } });
    assert.equal(r.type_num, 8);
  });

  it('test_setType_smoke_invalid', async () => {
    await assert.rejects(
      chart.setType({ chart_type: 'Unicorn', _deps: { evaluate: async () => undefined } }),
      /Unknown chart type/,
    );
  });

  it('test_manageIndicator_smoke_add', async () => {
    let call = 0;
    const deps = {
      evaluate: async () => {
        call++;
        if (call === 1) return ['old-1'];      // before
        if (call === 2) return undefined;      // createStudy
        return ['old-1', 'new-42'];            // after
      },
    };
    const r = await chart.manageIndicator({ action: 'add', indicator: 'RSI', _deps: deps });
    assert.equal(r.action, 'add');
    assert.equal(r.entity_id, 'new-42');
    assert.equal(r.success, true);
  });

  it('test_manageIndicator_smoke_routes_USER_to_pine_editor', async () => {
    // USER;<hash> form should route through _addUserScript rather than
    // chart.createStudy. We can't mock the entire pine.openScript +
    // pine.smartCompile chain without dynamic module patching, so this
    // smoke just asserts the request shape is recognized and the
    // wrapper attempts the pine path (any thrown error from inside
    // pine.openScript is OK — it means we got past the routing gate).
    let createStudyCalled = false;
    installCdpMocks({
      evaluate: async (expr) => {
        if (typeof expr === 'string' && /createStudy\(/.test(expr)) {
          createStudyCalled = true;
        }
        if (typeof expr === 'string' && /getAllStudies/.test(expr)) {
          return [];
        }
        // Force the pine path to throw early — any error proves we routed there
        return undefined;
      },
      evaluateAsync: async () => {
        throw new Error('routed_to_pine_editor');
      },
    });
    let err;
    try {
      await chart.manageIndicator({
        action: 'add',
        indicator: 'USER;0da8b34c1497447d88653feb5bf9f33d',
      });
    } catch (e) { err = e; }
    assert.ok(err, 'expected USER; path to throw via the pine editor route');
    assert.equal(createStudyCalled, false, 'must not call chart.createStudy for USER; scripts');
  });

  it('test_manageIndicator_smoke_remove', async () => {
    const r = await chart.manageIndicator({
      action: 'remove', indicator: 'RSI', entity_id: 'old-1',
      _deps: { evaluate: async () => undefined },
    });
    assert.equal(r.success, true);
    assert.equal(r.action, 'remove');
  });

  it('test_manageIndicator_smoke_missingEntityId', async () => {
    await assert.rejects(
      chart.manageIndicator({ action: 'remove', indicator: 'RSI', _deps: { evaluate: async () => undefined } }),
      /entity_id required/,
    );
  });

  it('test_getVisibleRange_smoke', async () => {
    installCdpMocks({
      evaluate: async () => ({ visible_range: { from: 1, to: 2 }, bars_range: { from: 0, to: 100 } }),
    });
    const r = await chart.getVisibleRange();
    assert.equal(r.success, true);
    assert.equal(r.visible_range.from, 1);
  });

  it('test_setVisibleRange_smoke', async () => {
    let call = 0;
    const deps = {
      evaluate: async () => (++call === 1 ? undefined : { from: 100, to: 200 }),
    };
    const r = await chart.setVisibleRange({ from: 100, to: 200, _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.requested.from, 100);
    assert.equal(r.actual.to, 200);
  });

  it('test_scrollToDate_smoke_iso', async () => {
    installCdpMocks({ evaluate: async () => 'D' });
    const r = await chart.scrollToDate({ date: '2025-01-15' });
    assert.equal(r.success, true);
    assert.equal(r.date, '2025-01-15');
    assert.equal(r.resolution, 'D');
  });

  it('test_scrollToDate_smoke_unix', async () => {
    installCdpMocks({ evaluate: async () => '5' });
    const r = await chart.scrollToDate({ date: '1700000000' });
    assert.equal(r.centered_on, 1700000000);
  });

  it('test_scrollToDate_smoke_invalid', async () => {
    await assert.rejects(chart.scrollToDate({ date: 'not-a-date' }), /Could not parse date/);
  });

  it('test_symbolInfo_smoke', async () => {
    installCdpMocks({
      evaluate: async () => ({
        symbol: 'AAPL', exchange: 'NASDAQ', description: 'Apple Inc.',
        type: 'stock', resolution: 'D', chart_type: 1,
      }),
    });
    const r = await chart.symbolInfo();
    assert.equal(r.success, true);
    assert.equal(r.symbol, 'AAPL');
    assert.equal(r.exchange, 'NASDAQ');
  });

  it('test_symbolSearch_smoke', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ symbols: [
        { symbol: '<em>AAPL</em>', description: 'Apple', exchange: 'NASDAQ', type: 'stock' },
      ]}),
    });
    try {
      const r = await chart.symbolSearch({ query: 'AAPL' });
      assert.equal(r.success, true);
      assert.equal(r.count, 1);
      assert.equal(r.results[0].symbol, 'AAPL'); // <em> tags stripped
    } finally { globalThis.fetch = realFetch; }
  });
});
