import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/news.js';

export function registerNewsTools(server) {
  server.tool(
    'news_get_ticker',
    'Get the latest ticker-specific news headlines for the current chart symbol or a provided ticker. Pulls RSS from Nasdaq + Yahoo Finance with keyword sentiment scoring. Index symbols (SP:SPX, NDX, DJI, RUT, VIX) auto-route to their tracking ETF for news lookup.',
    {
      symbol: z.string().optional().describe('Ticker or TradingView symbol (blank = current chart symbol). Examples: "AAPL", "NASDAQ:NVDA", "SPY".'),
      limit: z.coerce.number().optional().describe('Max headlines to return (default 10, max 25)'),
    },
    async ({ symbol, limit }) => {
      try { return jsonResult(await core.getTickerNews({ symbol, limit })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'signal_get_snapshot',
    'Compact trading-context bundle from the current chart: quote, 100-bar price action (SMA20/50, ATR14, %change), volume vs 20-bar avg, visible indicator values, latest ticker news with sentiment. One-shot context for decision-making. Each section degrades gracefully — snapshot still returns if news or indicators fail.',
    {
      headline_limit: z.coerce.number().optional().describe('How many news headlines to include (default 5)'),
    },
    async ({ headline_limit }) => {
      try { return jsonResult(await core.getSignalSnapshot({ headline_limit })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
