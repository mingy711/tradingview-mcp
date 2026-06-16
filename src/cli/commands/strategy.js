import { register } from '../router.js';
import * as core from '../../core/strategy.js';

register('strategy', {
  description: 'Strategy Tester controls',
  subcommands: new Map([
    ['set-deep-bt-range', {
      description: 'Set Deep Backtesting date range (YYYY-MM-DD from to)',
      handler: (opts, positionals) => {
        const [from, to] = positionals;
        if (!from || !to) throw new Error('Usage: tv strategy set-deep-bt-range YYYY-MM-DD YYYY-MM-DD');
        return core.setDeepBacktestRange({ from, to });
      },
    }],
  ]),
});
