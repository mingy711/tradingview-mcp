import { register } from '../router.js';
import * as core from '../../core/news.js';

register('news', {
  description: 'Fetch ticker news (RSS from Nasdaq + Yahoo Finance) with keyword sentiment',
  options: {
    symbol: { type: 'string', short: 's', description: 'Ticker (blank = current chart symbol)' },
    limit: { type: 'string', short: 'n', description: 'Max headlines (1–25, default 10)' },
  },
  handler: (opts) => core.getTickerNews({
    symbol: opts.symbol,
    limit: opts.limit ? Number(opts.limit) : undefined,
  }),
});

register('snapshot', {
  description: 'Compact trading-context snapshot (quote + price action + indicators + news)',
  options: {
    headlines: { type: 'string', short: 'n', description: 'Headlines to include (default 5)' },
  },
  handler: (opts) => core.getSignalSnapshot({
    headline_limit: opts.headlines ? Number(opts.headlines) : undefined,
  }),
});
