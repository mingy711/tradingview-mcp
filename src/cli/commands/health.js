import { register } from '../router.js';
import * as core from '../../core/health.js';

register('status', {
  description: 'Check CDP connection to TradingView',
  handler: () => core.healthCheck(),
});

register('network', {
  description: 'Check connectivity to TradingView data endpoints',
  options: {
    timeout: { type: 'string', short: 't', description: 'Per-request timeout in milliseconds (default 5000)' },
  },
  handler: (opts) => core.networkCheck({
    timeout_ms: opts.timeout ? Number(opts.timeout) : undefined,
  }),
});

register('launch', {
  description: 'Launch TradingView with CDP enabled',
  options: {
    port: { type: 'string', short: 'p', description: 'CDP port (default 9222)' },
    'no-kill': { type: 'boolean', description: 'Do not kill existing instances' },
  },
  handler: (opts) => core.launch({
    port: opts.port ? Number(opts.port) : undefined,
    kill_existing: !opts['no-kill'],
  }),
});
