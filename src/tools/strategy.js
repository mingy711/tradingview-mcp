import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/strategy.js';

export function registerStrategyTools(server) {
  server.tool(
    'strategy_set_deep_bt_range',
    'Set the Deep Backtesting date range in the Strategy Tester header via the calendar picker. Opens the date-range modal, fills both YYYY-MM-DD inputs via React-friendly setter, clicks the locale-appropriate submit button (Select / Sélectionner / Apply / OK), verifies the displayed range updated. Requires the Strategy Tester panel to be open and a strategy to be loaded on the chart.',
    {
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Start date YYYY-MM-DD (e.g., "2024-01-01")'),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('End date YYYY-MM-DD (e.g., "2024-12-31")'),
    },
    async ({ from, to }) => {
      try { return jsonResult(await core.setDeepBacktestRange({ from, to })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
