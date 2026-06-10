import { register } from '../router.js';
import * as core from '../../core/watchlist.js';

register('watchlist', {
  description: 'Watchlist tools (get, add, upload, delete, share)',
  subcommands: new Map([
    ['get', {
      description: 'Get watchlist symbols',
      handler: () => core.get(),
    }],
    ['add', {
      description: 'Add a symbol to the watchlist',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Symbol required. Usage: tv watchlist add AAPL');
        return core.add({ symbol: positionals[0] });
      },
    }],
    ['upload', {
      description: 'Upload/import a TradingView watchlist text file',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('File path required. Usage: tv watchlist upload ./symbols.txt');
        return core.upload({ filePath: positionals[0] });
      },
    }],
    ['delete', {
      description: 'Delete a watchlist by name',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Watchlist name required. Usage: tv watchlist delete "My Watchlist"');
        return core.delete_({ watchlistName: positionals.join(' ') });
      },
    }],
    ['share', {
      description: 'Get a shareable link for a watchlist (enables sharing if needed)',
      handler: (_opts, positionals) => {
        return core.getShareLink({ watchlistName: positionals.length ? positionals.join(' ') : undefined });
      },
    }],
  ]),
});
