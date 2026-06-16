import { register } from '../router.js';
import * as core from '../../core/alerts.js';

register('alert', {
  description: 'Alert tools (list, create, create-for-list, delete)',
  subcommands: new Map([
    ['list', {
      description: 'List active alerts',
      handler: () => core.list(),
    }],
    ['create', {
      description: 'Create a price alert',
      options: {
        price: { type: 'string', short: 'p', description: 'Price level' },
        condition: { type: 'string', short: 'c', description: 'Condition: crossing, greater_than, less_than' },
        message: { type: 'string', short: 'm', description: 'Alert message' },
      },
      handler: (opts) => core.create({
        price: Number(opts.price),
        condition: opts.condition || 'crossing',
        message: opts.message,
      }),
    }],
    ['create-for-list', {
      description: 'Create an alert that applies to every symbol on a watchlist, optionally driven by a custom Pine indicator condition',
      options: {
        watchlist: { type: 'string', short: 'w', description: 'Watchlist name (defaults to the active watchlist)' },
        study: { type: 'string', short: 's', description: 'Condition source — substring of an indicator name on the chart (defaults to "Price")' },
        condition: { type: 'string', short: 'c', description: 'alertcondition() option — substring match (e.g., "Entry Zone")' },
        message: { type: 'string', short: 'm', description: 'Custom alert message' },
        name: { type: 'string', short: 'n', description: 'Custom alert name' },
        trigger: { type: 'string', short: 't', description: 'Trigger frequency: "Only Once", "Once Per Bar", "Once Per Bar Close", or "Every time" (defaults to "Only Once")' },
      },
      handler: (opts) => core.createForWatchlist({
        watchlistName: opts.watchlist,
        study: opts.study,
        alertCondition: opts.condition,
        message: opts.message,
        alertName: opts.name,
        trigger: opts.trigger,
      }),
    }],
    ['delete', {
      description: 'Delete alerts',
      options: {
        all: { type: 'boolean', description: 'Delete all alerts' },
      },
      handler: (opts) => core.deleteAlerts({ delete_all: opts.all }),
    }],
  ]),
});
