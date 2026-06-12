import { register } from '../router.js';
import * as core from '../../core/screener.js';

register('screener', {
  description: 'Scan TradingView screener (stocks/etfs/crypto/forex/futures/index) with filters',
  options: {
    market:        { type: 'string', short: 'm', description: 'stock | etf | crypto | forex | futures | index | america | global | cfd' },
    'asset-type':  { type: 'string',              description: 'Asset class override' },
    query:         { type: 'string', short: 'q', description: 'Search keyword (e.g. semiconductor)' },
    tickers:       { type: 'string', short: 't', description: 'CSV symbol list (AAPL,MSFT) or JSON array' },
    exchange:      { type: 'string', short: 'e', description: 'Exchange filter (NASDAQ, NYSE, BINANCE)' },
    'sort-by':     { type: 'string',              description: 'symbol | price | change_pct | change_abs | volume | market_cap' },
    'sort-order':  { type: 'string',              description: 'asc | desc' },
    limit:         { type: 'string', short: 'n', description: 'Max rows (1–100, default 20)' },
    'min-price':   { type: 'string', description: 'Min last price' },
    'max-price':   { type: 'string', description: 'Max last price' },
    'min-volume':  { type: 'string', description: 'Min volume' },
    'min-change':  { type: 'string', description: 'Min daily % change' },
    'max-change':  { type: 'string', description: 'Max daily % change' },
  },
  handler: (opts) => core.screenerScan({
    market: opts.market,
    asset_type: opts['asset-type'],
    query: opts.query,
    tickers: opts.tickers,
    exchange: opts.exchange,
    sort_by: opts['sort-by'],
    sort_order: opts['sort-order'],
    limit: opts.limit ? Number(opts.limit) : undefined,
    min_price: opts['min-price'] ? Number(opts['min-price']) : undefined,
    max_price: opts['max-price'] ? Number(opts['max-price']) : undefined,
    min_volume: opts['min-volume'] ? Number(opts['min-volume']) : undefined,
    min_change_pct: opts['min-change'] ? Number(opts['min-change']) : undefined,
    max_change_pct: opts['max-change'] ? Number(opts['max-change']) : undefined,
  }),
});
