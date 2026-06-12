/**
 * Ticker news + signal snapshot — pulls RSS feeds from Nasdaq + Yahoo
 * Finance, scores keyword sentiment, and rolls quote + indicators + news
 * into a single snapshot object for compact trading context.
 *
 * Ported from QuantAgentLabs fork (commit 1a3ea32, May 2026). Adapted to
 * our _deps DI pattern; getOhlcv/getQuote/getStudyValues sourced from
 * src/core/data.js (caller-injectable for tests).
 */
import { evaluate as _evaluate } from '../connection.js';
import { getOhlcv as _getOhlcv, getQuote as _getQuote, getStudyValues as _getStudyValues } from './data.js';

const NEWS_SOURCES = [
  {
    name: 'nasdaq',
    buildUrl: ({ ticker }) => `https://www.nasdaq.com/feed/rssoutbound?symbol=${encodeURIComponent(ticker)}`,
  },
  {
    name: 'yahoo_finance',
    buildUrl: ({ ticker }) => `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`,
  },
];

// Index/ETF aliasing: pure-index symbols have no news feed; route to the
// most liquid tracking ETF instead.
const NEWS_SYMBOL_ALIASES = new Map([
  ['SP:SPX', 'SPY'],
  ['SPX', 'SPY'],
  ['NASDAQ:NDX', 'QQQ'],
  ['NDX', 'QQQ'],
  ['DJ:DJI', 'DIA'],
  ['DJI', 'DIA'],
  ['CBOE:VIX', 'VIXY'],
  ['RUSSELL:RUT', 'IWM'],
  ['RUT', 'IWM'],
]);

const POSITIVE_KEYWORDS = [
  'beat', 'beats', 'upgrade', 'upgrades', 'bullish', 'rally', 'surge', 'growth',
  'strong', 'record', 'expands', 'approval', 'buyback', 'breakout', 'profit',
];
const NEGATIVE_KEYWORDS = [
  'miss', 'misses', 'downgrade', 'downgrades', 'bearish', 'selloff', 'drop',
  'slump', 'weak', 'lawsuit', 'probe', 'cut', 'cuts', 'warning', 'recession',
  'inflation', 'tariff', 'risk',
];

// ── RSS parsing helpers (no external deps) ──────────────────────────────

function stripCdata(value = '') {
  return value.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
}
function decodeHtml(value = '') {
  return value
    // Numeric references first (they may be nested inside named-entity
    // text after an upstream double-encode).
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => { try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return _m; } })
    .replace(/&#(\d+);/g, (_m, dec) => { try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return _m; } })
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
function stripTags(value = '') {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function extractTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? stripTags(decodeHtml(stripCdata(match[1].trim()))) : '';
}

/** Strip exchange prefix and `=` cont-contract marker. "NASDAQ:AAPL" → "AAPL". */
export function normalizeTicker(symbol = '') {
  const base = String(symbol).trim();
  if (!base) return '';
  const last = base.split(':').pop();
  return last.replace(/^=/, '').trim();
}

/** Parse an RSS XML body into { channel_title, items[{title,link,published_at,description,source}] }. */
export function parseRss(xml, sourceName) {
  const channelTitle = extractTag(xml, 'title');
  const items = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map(match => {
    const block = match[0];
    return {
      title: extractTag(block, 'title'),
      link: extractTag(block, 'link'),
      published_at: extractTag(block, 'pubDate'),
      description: extractTag(block, 'description'),
      source: extractTag(block, 'source') || sourceName,
    };
  }).filter(item => item.title && item.link);
  return { channel_title: channelTitle, items };
}

/**
 * Keyword-based sentiment scoring — token-aware. Tokenizes each item's
 * title + description on non-word boundaries and uses Set.has against
 * the keyword list. The previous substring `haystack.includes(kw)`
 * matched fragments inside unrelated words ("cut" inside "executive",
 * "miss" inside "commission", "beat" inside "heartbeat"), producing
 * inflated positive/negative counts on routine finance headlines.
 */
export function scoreHeadlines(items = []) {
  let positive = 0;
  let negative = 0;
  for (const item of items) {
    const haystack = `${item.title || ''} ${item.description || ''}`.toLowerCase();
    const tokens = new Set(haystack.split(/[^a-z0-9']+/).filter(Boolean));
    for (const kw of POSITIVE_KEYWORDS) if (tokens.has(kw)) positive += 1;
    for (const kw of NEGATIVE_KEYWORDS) if (tokens.has(kw)) negative += 1;
  }
  const score = positive - negative;
  const bias = score > 1 ? 'positive' : score < -1 ? 'negative' : 'mixed';
  return { positive_hits: positive, negative_hits: negative, score, bias };
}

// ── Symbol resolution ───────────────────────────────────────────────────

async function resolveSymbolAndTicker(symbol, evaluate) {
  if (symbol) {
    return { symbol, ticker: NEWS_SYMBOL_ALIASES.get(symbol) || normalizeTicker(symbol) };
  }
  const current = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var ext = {};
        try { ext = chart.symbolExt() || {}; } catch(e) {}
        return {
          symbol: chart.symbol(),
          type: ext.type || '',
          description: ext.description || '',
          exchange: ext.exchange || ''
        };
      } catch(e) { return { symbol: '', type: '', description: '', exchange: '' }; }
    })()
  `);
  const currentSymbol = current?.symbol || '';
  return {
    symbol: currentSymbol,
    ticker: NEWS_SYMBOL_ALIASES.get(currentSymbol) || normalizeTicker(currentSymbol),
    type: current?.type || '',
    description: current?.description || '',
    exchange: current?.exchange || '',
  };
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Fetch news headlines for `symbol` (or the current chart symbol).
 * Tries each source in order, returns the first that succeeds with items.
 * Returns { success, symbol, ticker, source, channel_title, headline_count, sentiment, headlines[] }.
 */
export async function getTickerNews({ symbol, limit, _deps } = {}) {
  const evaluate = _deps?.evaluate || _evaluate;
  const fetchImpl = _deps?.fetch || fetch;
  const maxItems = Math.min(Math.max(Number(limit || 10), 1), 25);
  const resolved = await resolveSymbolAndTicker(symbol, evaluate);
  if (!resolved.ticker) throw new Error('Could not determine ticker for news lookup.');
  // Constrain the ticker character set before it's interpolated into
  // upstream RSS URLs. encodeURIComponent stops URL-syntax injection
  // but the attacker still controls the query value; refuse anything
  // that doesn't look like a real exchange symbol so we never embed
  // operator-controlled data into a third-party request.
  if (!/^[A-Z0-9.\-^=!]{1,15}$/i.test(resolved.ticker)) {
    throw new Error(`Refusing news fetch for suspicious ticker "${resolved.ticker}" — expected exchange symbol matching /^[A-Z0-9.\\-^=!]{1,15}$/i.`);
  }

  const errors = [];
  for (const source of NEWS_SOURCES) {
    try {
      const response = await fetchImpl(source.buildUrl(resolved), {
        headers: {
          'Accept': 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
          'User-Agent': 'tradingview-mcp/1.0',
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const xml = await response.text();
      const parsed = parseRss(xml, source.name);
      const items = parsed.items.slice(0, maxItems);
      if (items.length === 0) throw new Error('Feed returned no news items');
      return {
        success: true,
        symbol: resolved.symbol || resolved.ticker,
        ticker: resolved.ticker,
        requested_symbol: resolved.symbol || resolved.ticker,
        news_symbol: resolved.ticker,
        source: source.name,
        channel_title: parsed.channel_title,
        headline_count: items.length,
        sentiment: scoreHeadlines(items),
        headlines: items,
      };
    } catch (error) {
      errors.push(`${source.name}: ${error.message}`);
    }
  }
  throw new Error(`Could not fetch ticker news for ${resolved.ticker}. Tried ${errors.join('; ')}`);
}

// ── Signal snapshot helpers ─────────────────────────────────────────────

function average(values) {
  if (!values.length) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}
function simpleMovingAverage(values, length) {
  if (values.length < length) return null;
  return average(values.slice(-length));
}
function averageTrueRange(bars, length = 14) {
  if (bars.length < 2) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    const bar = bars[i];
    const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prev), Math.abs(bar.low - prev));
    trs.push(tr);
  }
  return trs.length >= length ? average(trs.slice(-length)) : null;
}

/**
 * One-shot compact context bundle: quote + 100-bar price action + ATR/SMA
 * + visible indicators + recent headlines. Designed to fit in one tool
 * response without context bloat. Each section degrades gracefully if a
 * sub-fetch fails (snapshot still returns, with `available: false` on the
 * failing block).
 */
export async function getSignalSnapshot({ headline_limit, _deps } = {}) {
  const loadOhlcv = _deps?.getOhlcv || _getOhlcv;
  const loadQuote = _deps?.getQuote || _getQuote;
  const loadStudyValues = _deps?.getStudyValues || _getStudyValues;
  const loadTickerNews = _deps?.getTickerNews || getTickerNews;

  const barsResp = await loadOhlcv({ count: 100 });
  const bars = barsResp.bars || [];
  if (bars.length === 0) throw new Error('No bar data available for signal snapshot.');

  const quote = await loadQuote();
  let studies;
  try { studies = await loadStudyValues(); }
  catch { studies = { success: false, indicators: [] }; }

  let news;
  try { news = await loadTickerNews({ limit: headline_limit || 5, _deps }); }
  catch (e) { news = { success: false, error: e.message, headlines: [] }; }

  const closes = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume || 0);
  const first = bars[0];
  const last = bars[bars.length - 1];
  const last5 = bars.length >= 5 ? bars[bars.length - 5].close : first.close;
  const last20 = bars.length >= 20 ? bars[bars.length - 20].close : first.close;
  const sma20 = simpleMovingAverage(closes, 20);
  const sma50 = simpleMovingAverage(closes, 50);
  const atr14 = averageTrueRange(bars, 14);
  const avgVol20 = average(volumes.slice(-20)) || 0;
  const lastVol = last.volume || 0;
  const dailyRangePct = last.close ? ((last.high - last.low) / last.close) * 100 : null;

  return {
    success: true,
    symbol: quote.symbol,
    time: quote.time,
    quote: {
      last: quote.last, open: quote.open, high: quote.high, low: quote.low,
      close: quote.close, volume: quote.volume, bid: quote.bid, ask: quote.ask,
    },
    price_action: {
      period_from: first.time, period_to: last.time,
      close_change_pct_5: last5 ? +((((last.close - last5) / last5) * 100).toFixed(2)) : null,
      close_change_pct_20: last20 ? +((((last.close - last20) / last20) * 100).toFixed(2)) : null,
      range_pct_today: dailyRangePct != null ? +(dailyRangePct.toFixed(2)) : null,
      sma20: sma20 != null ? +sma20.toFixed(2) : null,
      sma50: sma50 != null ? +sma50.toFixed(2) : null,
      distance_from_sma20_pct: sma20 ? +((((last.close - sma20) / sma20) * 100).toFixed(2)) : null,
      distance_from_sma50_pct: sma50 ? +((((last.close - sma50) / sma50) * 100).toFixed(2)) : null,
      atr14: atr14 != null ? +atr14.toFixed(2) : null,
    },
    volume_context: {
      last_volume: lastVol,
      avg_volume_20: Math.round(avgVol20),
      volume_vs_avg_20: avgVol20 ? +(lastVol / avgVol20).toFixed(2) : null,
    },
    technical_context: studies.success === false ? { available: false, error: studies.error } : {
      available: true,
      indicator_count: studies.indicators?.length || 0,
      indicators: studies.indicators || [],
    },
    news_context: news.success === false ? { available: false, error: news.error } : {
      available: true,
      source: news.source,
      sentiment: news.sentiment,
      headlines: news.headlines,
    },
  };
}
