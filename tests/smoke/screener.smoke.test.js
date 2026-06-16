import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { screenerScan, _test } from '../../src/core/screener.js';

describe('core/screener.js — smoke', () => {
  // ── pure helpers ──────────────────────────────────────────────────
  it('parseList handles CSV, JSON array, single string, array', () => {
    assert.deepEqual(_test.parseList('AAPL,MSFT,QQQ'), ['AAPL', 'MSFT', 'QQQ']);
    assert.deepEqual(_test.parseList('["NASDAQ:AAPL", "NASDAQ:MSFT"]'), ['NASDAQ:AAPL', 'NASDAQ:MSFT']);
    assert.deepEqual(_test.parseList('  AAPL  '), ['AAPL']);
    assert.deepEqual(_test.parseList(['A', '', 'B']), ['A', 'B']);
    assert.deepEqual(_test.parseList(''), []);
    assert.deepEqual(_test.parseList(null), []);
  });

  it('normalizeMarket falls back to stock when neither matches', () => {
    assert.equal(_test.normalizeMarket('bogus', null).key, 'stock');
    assert.equal(_test.normalizeMarket('crypto', null).key, 'crypto');
    assert.equal(_test.normalizeMarket('crypto', 'forex').key, 'forex', 'asset_type overrides market');
    assert.equal(_test.normalizeMarket(null, null).key, 'stock');
  });

  it('formatRow maps positional d[] array to named columns', () => {
    const row = { s: 'NASDAQ:AAPL', d: ['AAPL', 200, 1.5, 3.0, 50000000, 3e12, 'stock', 'common', 'Apple Inc'] };
    const cols = ['name', 'close', 'change', 'change_abs', 'volume', 'market_cap_basic', 'type', 'subtype', 'description'];
    const out = _test.formatRow(row, cols);
    assert.equal(out.ticker, 'NASDAQ:AAPL');
    assert.equal(out.symbol, 'AAPL');
    assert.equal(out.price, 200);
    assert.equal(out.change_pct, 1.5);
    assert.equal(out.volume, 50000000);
    assert.equal(out.market_cap, 3e12);
  });

  it('matchesPreset accepts when preset has no queryTypes', () => {
    assert.equal(_test.matchesPreset({ type: 'stock' }, { queryTypes: [] }), true);
    assert.equal(_test.matchesPreset({ type: 'stock' }, { queryTypes: ['stock'] }), true);
    assert.equal(_test.matchesPreset({ type: 'fund' }, { queryTypes: ['stock'] }), false);
  });

  // ── screenerScan ──────────────────────────────────────────────────
  it('screenerScan hits the right endpoint with default stock preset', async () => {
    let calledUrl = null;
    let calledBody = null;
    const fakeFetch = async (url, opts) => {
      calledUrl = url;
      calledBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          data: [
            { s: 'NASDAQ:NVDA', d: ['NVDA', 1000, 5.2, 50, 30000000, 2.5e12, 'stock', 'common', 'NVIDIA'] },
          ],
          totalCount: 1,
        }),
      };
    };
    const r = await screenerScan({
      market: 'stock', limit: 5,
      _deps: { fetch: fakeFetch, symbolSearch: async () => ({ results: [] }) },
    });
    assert.equal(calledUrl, 'https://scanner.tradingview.com/america/scan');
    assert.equal(calledBody.range[1], 4, 'range cap = limit - 1');
    assert.deepEqual(calledBody.symbols.query.types, ['stock']);
    assert.equal(calledBody.sort.sortBy, 'change');
    assert.equal(calledBody.sort.sortOrder, 'desc');
    assert.equal(r.row_count, 1);
    assert.equal(r.rows[0].symbol, 'NVDA');
    assert.equal(r.rows[0].price, 1000);
  });

  it('screenerScan applies range filters', async () => {
    let calledBody = null;
    const fakeFetch = async (url, opts) => {
      calledBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ data: [], totalCount: 0 }) };
    };
    await screenerScan({
      min_price: 10, max_price: 1000, min_volume: 100000,
      min_change_pct: 2, max_change_pct: 20,
      _deps: { fetch: fakeFetch, symbolSearch: async () => ({ results: [] }) },
    });
    assert.ok(calledBody.filter.some(f => f.left === 'close' && f.operation === 'egreater' && f.right === 10));
    assert.ok(calledBody.filter.some(f => f.left === 'close' && f.operation === 'eless' && f.right === 1000));
    assert.ok(calledBody.filter.some(f => f.left === 'volume' && f.right === 100000));
    assert.ok(calledBody.filter.some(f => f.left === 'change' && f.operation === 'egreater' && f.right === 2));
    assert.ok(calledBody.filter.some(f => f.left === 'change' && f.operation === 'eless' && f.right === 20));
  });

  it('screenerScan throws on non-200 response', async () => {
    const fakeFetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(
      () => screenerScan({ _deps: { fetch: fakeFetch, symbolSearch: async () => ({ results: [] }) } }),
      /returned 503/,
    );
  });

  it('screenerScan hydrates bare tickers via symbolSearch', async () => {
    const searched = [];
    const fakeSearch = async ({ query }) => {
      searched.push(query);
      return { results: [{ symbol: query, full_name: `NASDAQ:${query}`, type: 'stock', exchange: 'NASDAQ' }] };
    };
    let body = null;
    const fakeFetch = async (url, opts) => {
      body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ data: [], totalCount: 0 }) };
    };
    await screenerScan({
      tickers: 'AAPL,MSFT',
      _deps: { fetch: fakeFetch, symbolSearch: fakeSearch },
    });
    assert.deepEqual(searched, ['AAPL', 'MSFT']);
    assert.deepEqual(body.symbols.tickers, ['NASDAQ:AAPL', 'NASDAQ:MSFT']);
  });

  it('screenerScan passes fully-qualified tickers through unchanged', async () => {
    const fakeSearch = async () => { throw new Error('should not call'); };
    let body = null;
    const fakeFetch = async (url, opts) => {
      body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ data: [], totalCount: 0 }) };
    };
    await screenerScan({
      tickers: '["NASDAQ:AAPL","BATS:SPY"]',
      _deps: { fetch: fakeFetch, symbolSearch: fakeSearch },
    });
    assert.deepEqual(body.symbols.tickers, ['NASDAQ:AAPL', 'BATS:SPY']);
  });

  it('screenerScan routes crypto market to crypto scanner endpoint', async () => {
    let url = null;
    const fakeFetch = async (u, opts) => {
      url = u;
      return { ok: true, json: async () => ({ data: [], totalCount: 0 }) };
    };
    await screenerScan({
      market: 'crypto', query: 'bitcoin',
      _deps: { fetch: fakeFetch, symbolSearch: async () => ({ results: [{ full_name: 'BINANCE:BTCUSDT', type: 'crypto' }] }) },
    });
    assert.equal(url, 'https://scanner.tradingview.com/crypto/scan');
  });
});
