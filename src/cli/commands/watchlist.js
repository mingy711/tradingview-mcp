import { register } from '../router.js';
import * as core from '../../core/watchlist.js';

register('watchlist', {
  description: 'Watchlist tools (get, add, remove, add-bulk, upload, delete, share)',
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
    ['remove', {
      description: 'Remove one or more symbols from the watchlist',
      handler: (opts, positionals) => {
        if (!positionals.length) throw new Error('Symbols required. Usage: tv watchlist remove AAPL MSFT');
        return core.remove({ symbols: positionals });
      },
    }],
    ['add-bulk', {
      description: 'Add multiple symbols to the watchlist',
      handler: (opts, positionals) => {
        if (!positionals.length) throw new Error('Symbols required. Usage: tv watchlist add-bulk AAPL MSFT GOOGL');
        return core.addBulk({ symbols: positionals });
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
      description: 'Get a shareable link for a watchlist, enabling sharing if needed',
      handler: (_opts, positionals) => {
        return core.getShareLink({ watchlistName: positionals.length ? positionals.join(' ') : undefined });
      },
    }],
  ]),
});
