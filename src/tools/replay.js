import { z } from 'zod';
import { boolish } from './_validation.js';
import { jsonResult } from './_format.js';
import * as core from '../core/replay.js';

export function registerReplayTools(server) {
  server.tool('replay_start', 'Start bar replay mode, optionally at a specific date or intraday timestamp. Clears any cached replay session state before jumping so a re-call always moves the cursor to the new target. Returns warning if cursor drifted >5min from requested (TV silently clamps backward jumps to unloaded data — use scroll_back to pre-extend the buffer).', {
    date: z.string().optional().describe('Replay target. Day-precision "YYYY-MM-DD" lands at midnight UTC. For intraday (e.g., NY market open at 09:33 ET), pass ISO with offset: "2026-05-08T09:33:00-04:00" or "2026-05-08T13:33:00Z". If omitted, selects first available date.'),
    scroll_back: boolish.optional().describe('Pre-scroll the chart backward before engaging replay to force TV to load historical bars covering the target date. Required for backward jumps outside the current bar buffer (TV silently clamps otherwise). Adds 1-30s depending on how far back the jump is.'),
  }, async ({ date, scroll_back }) => {
    try { return jsonResult(await core.start({ date, scrollBack: scroll_back })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_step', 'Advance one bar in replay mode', {}, async () => {
    try { return jsonResult(await core.step()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_autoplay', 'Toggle autoplay in replay mode, optionally set speed', {
    speed: z.coerce.number().optional().describe('Autoplay delay in ms (lower = faster). Valid values: 100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000. Leave empty to just toggle.'),
  }, async ({ speed }) => {
    try { return jsonResult(await core.autoplay({ speed })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_stop', 'Stop replay and return to realtime', {}, async () => {
    try { return jsonResult(await core.stop()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_set_resolution', 'Set replay update interval (tick granularity). Valid values depend on chart timeframe — e.g. on a 5m chart: "1T" (tick), "1S" (second), "1" (1 min), "5" (5 min). On daily: "1H", "2H", "3H", "4H", "1D". Use "auto" to reset. 1T/1S may require a paid TradingView plan.', {
    interval: z.string().optional().describe('Update interval (e.g. 1T, 1S, 1, 5, 1H, 1D, auto)'),
  }, async ({ interval }) => {
    try { return jsonResult(await core.setResolution({ interval })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_trade', 'Execute a trade action in replay mode (buy, sell, or close position)', {
    action: z.string().describe('Trade action: buy, sell, or close'),
  }, async ({ action }) => {
    try { return jsonResult(await core.trade({ action })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_status', 'Get current replay mode status', {}, async () => {
    try { return jsonResult(await core.status()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
