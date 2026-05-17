/**
 * Smoke tests — src/core/tab.js::list/newTab/closeTab.
 * switchTab still flagged for integration (it spawns CDP connections in
 * a way the simple mocks don't model).
 */
import { describe, it, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupConnection } from '../helpers/mock-cdp.js';
import * as tab from '../../src/core/tab.js';

describe('core/tab.js — smoke', () => {
  const realFetch = globalThis.fetch;
  after(cleanupConnection);
  afterEach(() => { globalThis.fetch = realFetch; });

  // Mock CDP factory: returns a fake client whose Runtime.evaluate hands
  // back the configured pine_script name per target.
  function fakeCdpFactory(scriptByTarget) {
    return async ({ target }) => ({
      Runtime: {
        enable: async () => {},
        evaluate: async () => ({ result: { value: scriptByTarget[target] ?? null } }),
      },
      close: async () => {},
    });
  }

  function mockTabsFetch(tabs) {
    globalThis.fetch = async () => ({ json: async () => tabs });
  }

  it('test_list_smoke', async () => {
    mockTabsFetch([
      { id: 't1', type: 'page', title: 'Live stock charts on AAPL', url: 'https://www.tradingview.com/chart/abc123/' },
      { id: 't2', type: 'page', title: 'Chart', url: 'https://www.tradingview.com/chart/xyz789/' },
      { id: 't3', type: 'page', title: 'Some other page', url: 'https://example.com' },
      { id: 'wk1', type: 'worker', url: 'https://www.tradingview.com/chart/' },
    ]);
    const r = await tab.list({ include_pine_script: false });
    assert.equal(r.success, true);
    assert.equal(r.tab_count, 2);
    assert.equal(r.tabs[0].id, 't1');
    assert.equal(r.tabs[0].chart_id, 'abc123');
    assert.equal(r.tabs[1].chart_id, 'xyz789');
  });

  it('test_list_smoke_with_pine_script', async () => {
    mockTabsFetch([
      { id: 't1', type: 'page', title: 'Live stock charts on AAPL', url: 'https://www.tradingview.com/chart/abc123/' },
      { id: 't2', type: 'page', title: 'Chart', url: 'https://www.tradingview.com/chart/xyz789/' },
    ]);
    const r = await tab.list({
      include_pine_script: true,
      _deps: { cdpFactory: fakeCdpFactory({ t1: 'My Strategy', t2: null }) },
    });
    assert.equal(r.success, true);
    assert.equal(r.tab_count, 2);
    assert.equal(r.tabs[0].pine_script, 'My Strategy');
    assert.equal(r.tabs[1].pine_script, null);
  });

  it('test_switchTabByName_smoke_throws_when_no_match', async () => {
    mockTabsFetch([
      { id: 't1', type: 'page', title: 'Chart', url: 'https://www.tradingview.com/chart/abc/' },
    ]);
    await assert.rejects(
      tab.switchTabByName({
        name: 'Nonexistent',
        _deps: { cdpFactory: fakeCdpFactory({ t1: 'Different Script' }) },
      }),
      /No tab found.*Nonexistent.*Available scripts: Different Script/i,
    );
  });

  it('test_switchTabByName_smoke_throws_with_no_pine_scripts', async () => {
    mockTabsFetch([
      { id: 't1', type: 'page', title: 'Chart', url: 'https://www.tradingview.com/chart/abc/' },
    ]);
    await assert.rejects(
      tab.switchTabByName({
        name: 'Anything',
        _deps: { cdpFactory: fakeCdpFactory({ t1: null }) },
      }),
      /No tabs have a Pine script open/i,
    );
  });

  it('test_switchTabByName_smoke_validates_name', async () => {
    await assert.rejects(
      tab.switchTabByName({}),
      /name \(string\) is required/i,
    );
  });

  it('test_newTab_smoke_opens_picker', async () => {
    // newTab: triggers + via React onClick in a shell page, then diffs
    // /json/list to find the new picker target. Mock the shell page + the
    // before/after fetch responses to simulate a successful click.
    const beforeIds = ['existing-chart-1', 'shell-1'];
    const newPickerId = 'new-picker-99';
    let callIdx = 0;
    globalThis.fetch = async (url) => {
      callIdx++;
      if (url.endsWith('/json/list')) {
        // First call: snapshot before trigger
        if (callIdx === 1) return { json: async () => [
          { id: 'shell-1', type: 'page', url: 'file:///app/index.html' },
          { id: 'existing-chart-1', type: 'page', url: 'https://www.tradingview.com/chart/abc/' },
        ]};
        // Subsequent calls: snapshot after — picker has appeared
        return { json: async () => [
          { id: 'shell-1', type: 'page', url: 'file:///app/index.html' },
          { id: 'existing-chart-1', type: 'page', url: 'https://www.tradingview.com/chart/abc/' },
          { id: newPickerId, type: 'page', url: 'file:///app/new-tab/index.html?foo=bar', title: 'picker' },
        ]};
      }
      return { json: async () => [] };
    };
    const fakeCdp = async () => ({
      Runtime: {
        evaluate: async () => ({ result: { value: { invoked: true } } }),
      },
      close: async () => {},
    });
    const r = await tab.newTab({ _deps: { cdpFactory: fakeCdp } });
    assert.equal(r.success, true);
    assert.equal(r.action, 'picker_tab_opened');
    assert.equal(r.picker_tab_id, newPickerId);
    assert.ok(r.hint.includes('layout picker'));
  });

  it('test_newTab_smoke_returns_failure_when_shell_not_found', async () => {
    globalThis.fetch = async () => ({ json: async () => [
      // Only chart pages — no Electron shell page exists
      { id: 'c1', type: 'page', url: 'https://www.tradingview.com/chart/abc/' },
    ]});
    const r = await tab.newTab({ _deps: { cdpFactory: async () => ({ close: async () => {} }) } });
    assert.equal(r.success, false);
    assert.equal(r.action, 'no_shell_found');
  });

  it('test_closeTab_smoke_closes_by_id', async () => {
    let closeCalls = [];
    globalThis.fetch = async (url) => {
      if (url.endsWith('/json/list')) return { json: async () => [
        { id: 'pick-1', type: 'page', title: 'picker', url: 'file:///app/new-tab/index.html' },
        { id: 'c1', type: 'page', title: 'Chart', url: 'https://www.tradingview.com/chart/abc/' },
        { id: 'c2', type: 'page', title: 'Chart', url: 'https://www.tradingview.com/chart/xyz/' },
      ]};
      if (url.includes('/json/close/')) {
        closeCalls.push(url);
        return { status: 200, text: async () => 'Target is closing' };
      }
      return { json: async () => [] };
    };
    const r = await tab.closeTab({ id: 'pick-1' });
    assert.equal(r.success, true);
    assert.equal(r.action, 'tab_closed');
    assert.equal(r.closed_id, 'pick-1');
    assert.equal(closeCalls.length, 1);
    assert.ok(closeCalls[0].endsWith('/json/close/pick-1'));
  });

  it('test_closeTab_smoke_refuses_last_chart_tab', async () => {
    globalThis.fetch = async (url) => {
      if (url.endsWith('/json/list')) return { json: async () => [
        { id: 'c1', type: 'page', url: 'https://www.tradingview.com/chart/abc/' },
      ]};
      return { json: async () => [] };
    };
    await assert.rejects(
      tab.closeTab({ id: 'c1' }),
      /last chart tab/i,
    );
  });

  it('test_closeTab_smoke_allows_closing_picker_when_only_one_chart_left', async () => {
    // Edge case: closing a picker should NEVER trip the "last chart tab"
    // check, because the picker isn't a chart tab.
    globalThis.fetch = async (url) => {
      if (url.endsWith('/json/list')) return { json: async () => [
        { id: 'pick-1', type: 'page', title: 'picker', url: 'file:///app/new-tab/index.html' },
        { id: 'c1', type: 'page', title: 'Chart', url: 'https://www.tradingview.com/chart/abc/' },
      ]};
      if (url.includes('/json/close/')) return { status: 200, text: async () => 'ok' };
      return { json: async () => [] };
    };
    const r = await tab.closeTab({ id: 'pick-1' });
    assert.equal(r.success, true);
  });

  it('test_closeTab_smoke_uses_current_target_when_id_omitted', async () => {
    globalThis.fetch = async (url) => {
      if (url.endsWith('/json/list')) return { json: async () => [
        { id: 'current-target', type: 'page', title: 'Chart', url: 'https://www.tradingview.com/chart/abc/' },
        { id: 'c2', type: 'page', title: 'Chart', url: 'https://www.tradingview.com/chart/xyz/' },
      ]};
      if (url.includes('/json/close/')) return { status: 200, text: async () => 'ok' };
      return { json: async () => [] };
    };
    const r = await tab.closeTab({
      _deps: { getTargetInfo: async () => ({ id: 'current-target' }) },
    });
    assert.equal(r.success, true);
    assert.equal(r.closed_id, 'current-target');
  });

  // Regression: a single hung target's CDP connection used to stall the whole
  // list — Promise.all waits for every probe. _readActivePineScript now wraps
  // each probe in a 2s timeout and falls through to null. The healthy probe
  // returns its real value; the hung one returns null without holding things up.
  it('test_list_smoke_pine_read_timeout_does_not_stall', async () => {
    mockTabsFetch([
      { id: 'fast', type: 'page', title: 'Live stock charts on AAPL', url: 'https://www.tradingview.com/chart/fast/' },
      { id: 'hung', type: 'page', title: 'Live stock charts on NVDA', url: 'https://www.tradingview.com/chart/hung/' },
    ]);
    // Hung factory: connect returns a client whose evaluate never resolves.
    const hungFactory = async ({ target }) => {
      if (target === 'fast') {
        return {
          Runtime: { enable: async () => {}, evaluate: async () => ({ result: { value: 'Fast Script' } }) },
          close: async () => {},
        };
      }
      return {
        Runtime: { enable: async () => {}, evaluate: () => new Promise(() => {}) },
        close: async () => {},
      };
    };
    const start = Date.now();
    const r = await tab.list({ include_pine_script: true, _deps: { cdpFactory: hungFactory } });
    const elapsed = Date.now() - start;
    assert.equal(r.success, true);
    assert.equal(r.tabs[0].pine_script, 'Fast Script');
    assert.equal(r.tabs[1].pine_script, null);
    // Timeout cap is 2s — give a little slack for CI variance, but well under
    // the indefinite hang the bug used to cause.
    assert.ok(elapsed < 4000, `list completed in ${elapsed}ms (timeout cap is 2s)`);
  });
});
