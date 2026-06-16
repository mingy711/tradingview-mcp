import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { installCdpMocks, resetCdpMocks, cleanupConnection } from '../helpers/mock-cdp.js';
import { normalizeTicker, parseRss, scoreHeadlines, getTickerNews, getSignalSnapshot } from '../../src/core/news.js';

describe('core/news.js — smoke', () => {
  after(async () => { resetCdpMocks(); await cleanupConnection(); });

  // ── pure helpers ──────────────────────────────────────────────────
  it('normalizeTicker strips exchange prefix + cont-contract marker', () => {
    assert.equal(normalizeTicker('NASDAQ:AAPL'), 'AAPL');
    assert.equal(normalizeTicker('CME_MINI:ES1!'), 'ES1!');
    assert.equal(normalizeTicker('=BTCUSD'), 'BTCUSD');
    assert.equal(normalizeTicker('CRYPTO:=ETHUSD'), 'ETHUSD');
    assert.equal(normalizeTicker(''), '');
  });

  it('parseRss extracts items with title/link/pubDate/description', () => {
    const xml = `<rss><channel>
      <title>Test Feed</title>
      <item>
        <title><![CDATA[Apple beats Q4 earnings]]></title>
        <link>https://example.com/1</link>
        <pubDate>Mon, 12 May 2026 09:00:00 GMT</pubDate>
        <description>Strong results.</description>
      </item>
      <item>
        <title>Tesla downgrade by analyst</title>
        <link>https://example.com/2</link>
        <pubDate>Mon, 12 May 2026 10:00:00 GMT</pubDate>
        <description>Lawsuit risk grows.</description>
      </item>
    </channel></rss>`;
    const out = parseRss(xml, 'nasdaq');
    assert.equal(out.channel_title, 'Test Feed');
    assert.equal(out.items.length, 2);
    assert.equal(out.items[0].title, 'Apple beats Q4 earnings');
    assert.equal(out.items[1].title, 'Tesla downgrade by analyst');
  });

  it('scoreHeadlines counts positive vs negative keywords', () => {
    const r = scoreHeadlines([
      { title: 'Stock beats estimates, bullish rally', description: 'profit surge' },
      { title: 'Lawsuit risk grows', description: 'downgrade and selloff' },
      { title: 'Neutral news headline', description: 'regular update' },
    ]);
    // Token-aware: each kw matches the token form once.
    // positive tokens: beats, bullish, rally, profit, surge = 5
    // negative tokens: lawsuit, risk, downgrade, selloff = 4
    assert.equal(r.positive_hits, 5);
    assert.equal(r.negative_hits, 4);
    assert.equal(r.score, 1);
    assert.equal(r.bias, 'mixed');
  });

  it('scoreHeadlines bias bands at |score| > 1', () => {
    assert.equal(scoreHeadlines([{ title: 'profit beats rally' }]).bias, 'positive');
    assert.equal(scoreHeadlines([{ title: 'lawsuit downgrade selloff' }]).bias, 'negative');
    assert.equal(scoreHeadlines([{ title: 'just a single beat' }]).bias, 'mixed');
  });

  // ── getTickerNews ──────────────────────────────────────────────────
  it('getTickerNews aliases SP:SPX → SPY for news lookup', async () => {
    let calledUrl = null;
    const fakeFetch = async (url) => {
      calledUrl = url;
      return { ok: true, text: async () => `<rss><channel><title>SPY</title>
        <item><title>SPY rally</title><link>x</link></item></channel></rss>` };
    };
    const r = await getTickerNews({
      symbol: 'SP:SPX', limit: 3,
      _deps: { fetch: fakeFetch },
    });
    assert.equal(r.success, true);
    assert.equal(r.ticker, 'SPY');
    assert.ok(calledUrl.includes('SPY'), `expected SPY in URL: ${calledUrl}`);
  });

  it('getTickerNews falls back to second source on first failure', async () => {
    const calls = [];
    const fakeFetch = async (url) => {
      calls.push(url);
      if (calls.length === 1) return { ok: false, status: 500 };
      return { ok: true, text: async () => `<rss><channel>
        <item><title>Yahoo headline</title><link>y</link></item></channel></rss>` };
    };
    const r = await getTickerNews({
      symbol: 'AAPL', _deps: { fetch: fakeFetch },
    });
    assert.equal(r.success, true);
    assert.equal(r.source, 'yahoo_finance');
    assert.equal(calls.length, 2);
  });

  it('getTickerNews throws when all sources fail', async () => {
    const fakeFetch = async () => { throw new Error('network down'); };
    await assert.rejects(
      () => getTickerNews({ symbol: 'AAPL', _deps: { fetch: fakeFetch } }),
      /network down/,
    );
  });

  it('getTickerNews uses chart symbol when none provided', async () => {
    installCdpMocks({
      evaluate: async () => ({ symbol: 'NASDAQ:NVDA', exchange: 'NASDAQ' }),
    });
    const fakeFetch = async () => ({
      ok: true,
      text: async () => `<rss><channel><item><title>NVDA news</title><link>x</link></item></channel></rss>`,
    });
    const r = await getTickerNews({ _deps: { fetch: fakeFetch } });
    assert.equal(r.ticker, 'NVDA');
    assert.equal(r.symbol, 'NASDAQ:NVDA');
  });

  // ── getSignalSnapshot ──────────────────────────────────────────────
  it('getSignalSnapshot bundles quote + price action + indicators + news', async () => {
    const bars = Array.from({ length: 100 }, (_, i) => ({
      time: 1700000000 + i * 3600,
      open: 100 + i * 0.1, high: 100.5 + i * 0.1, low: 99.5 + i * 0.1,
      close: 100 + i * 0.1, volume: 1000 + i * 10,
    }));
    const r = await getSignalSnapshot({
      headline_limit: 3,
      _deps: {
        getOhlcv: async () => ({ bars }),
        getQuote: async () => ({ symbol: 'NVDA', time: 1700360000, last: 110, open: 110, high: 110.5, low: 109.5, close: 110, volume: 2000, bid: 109.9, ask: 110.1 }),
        getStudyValues: async () => ({ success: true, indicators: [{ name: 'RSI', value: 65 }] }),
        getTickerNews: async () => ({ success: true, source: 'nasdaq', sentiment: { score: 2, bias: 'positive' }, headlines: [{ title: 'h1' }, { title: 'h2' }] }),
      },
    });
    assert.equal(r.success, true);
    assert.equal(r.symbol, 'NVDA');
    assert.ok(r.price_action.sma20 != null);
    assert.ok(r.price_action.sma50 != null);
    assert.ok(r.price_action.atr14 != null);
    assert.equal(r.technical_context.available, true);
    assert.equal(r.technical_context.indicator_count, 1);
    assert.equal(r.news_context.available, true);
    assert.equal(r.news_context.sentiment.bias, 'positive');
  });

  it('getSignalSnapshot degrades gracefully when news fails', async () => {
    const bars = Array.from({ length: 50 }, (_, i) => ({
      time: 1700000000 + i * 3600, open: 100, high: 101, low: 99, close: 100, volume: 1000,
    }));
    const r = await getSignalSnapshot({
      _deps: {
        getOhlcv: async () => ({ bars }),
        getQuote: async () => ({ symbol: 'X', time: 1, last: 100 }),
        getStudyValues: async () => ({ success: true, indicators: [] }),
        getTickerNews: async () => { throw new Error('feed unavailable'); },
      },
    });
    assert.equal(r.news_context.available, false);
    assert.match(r.news_context.error, /feed unavailable/);
  });

  it('getSignalSnapshot throws when no bar data', async () => {
    await assert.rejects(
      () => getSignalSnapshot({
        _deps: {
          getOhlcv: async () => ({ bars: [] }),
          getQuote: async () => ({}),
          getStudyValues: async () => ({}),
          getTickerNews: async () => ({}),
        },
      }),
      /No bar data/,
    );
  });
});
