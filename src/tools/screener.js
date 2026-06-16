import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/screener.js';

export function registerScreenerTools(server) {
  server.tool(
    'screener_scan',
    'Scan TradingView market screeners (stocks, ETFs, crypto, forex, futures, indices) via the public scanner endpoint. More flexible than hotlist_get: supports market presets, search-by-keyword, explicit ticker hydration, exchange filters, and numeric range filters on price/volume/change. Returns rows with price, change%, volume, market cap.',
    {
      market: z.string().optional().describe('Market preset: stock, etf, crypto, forex, futures, index, america, global, or cfd (default: stock)'),
      asset_type: z.string().optional().describe('Override for `market` — same valid keys'),
      query: z.string().optional().describe('Search keyword to narrow the universe (e.g., "semiconductor", "bitcoin", "gold")'),
      tickers: z.string().optional().describe('Explicit symbols to hydrate, CSV or JSON array (e.g., "AAPL,MSFT,QQQ" or \'["NASDAQ:AAPL","NASDAQ:MSFT"]\')'),
      exchange: z.string().optional().describe('Exchange filter for query/ticker lookup (e.g., NASDAQ, NYSE, BINANCE)'),
      sort_by: z.enum(['symbol', 'price', 'change_pct', 'change_abs', 'volume', 'market_cap']).optional().describe('Sort field (default: change_pct)'),
      sort_order: z.enum(['asc', 'desc']).optional().describe('Sort direction (default: desc)'),
      limit: z.coerce.number().optional().describe('Max rows to return (1–100, default 20)'),
      min_price: z.coerce.number().optional().describe('Minimum last price'),
      max_price: z.coerce.number().optional().describe('Maximum last price'),
      min_volume: z.coerce.number().optional().describe('Minimum volume'),
      min_change_pct: z.coerce.number().optional().describe('Minimum daily % change'),
      max_change_pct: z.coerce.number().optional().describe('Maximum daily % change'),
    },
    async (args) => {
      try { return jsonResult(await core.screenerScan(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
