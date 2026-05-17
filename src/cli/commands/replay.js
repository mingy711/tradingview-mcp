import { register } from '../router.js';
import * as core from '../../core/replay.js';

register('replay', {
  description: 'Replay mode controls',
  subcommands: new Map([
    ['start', {
      description: 'Start replay mode (clears stale session state before jumping)',
      options: {
        date: { type: 'string', short: 'd', description: 'Replay target. YYYY-MM-DD = midnight UTC. For intraday: YYYY-MM-DDTHH:MM:SS+HH:MM (e.g., 2026-05-08T09:33:00-04:00 for 09:33 ET) or YYYY-MM-DDTHH:MM:SSZ' },
        'scroll-back': { type: 'boolean', description: 'Pre-scroll the chart backward to force TV to load historical bars covering the target date. Required for backward jumps outside the current bar buffer (TV silently clamps otherwise).' },
      },
      handler: (opts) => core.start({ date: opts.date, scrollBack: opts['scroll-back'] }),
    }],
    ['step', {
      description: 'Advance one bar in replay',
      handler: () => core.step(),
    }],
    ['stop', {
      description: 'Stop replay and return to realtime',
      handler: () => core.stop(),
    }],
    ['status', {
      description: 'Get current replay state',
      handler: () => core.status(),
    }],
    ['autoplay', {
      description: 'Toggle autoplay in replay mode',
      options: {
        speed: { type: 'string', short: 's', description: 'Autoplay delay in ms (lower = faster)' },
      },
      handler: (opts) => core.autoplay({ speed: opts.speed ? Number(opts.speed) : undefined }),
    }],
    ['trade', {
      description: 'Execute a trade in replay mode (buy, sell, close)',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Action required. Usage: tv replay trade buy');
        return core.trade({ action: positionals[0] });
      },
    }],
  ]),
});
