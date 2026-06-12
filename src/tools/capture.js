import { z } from 'zod';
import { boolish } from './_validation.js';
import { jsonResult } from './_format.js';
import * as core from '../core/capture.js';

export function registerCaptureTools(server) {
  server.tool('capture_screenshot', 'Take a screenshot of the TradingView chart', {
    region: z.string().optional().describe('Region to capture: full, chart, strategy_tester (default full)'),
    filename: z.string().optional().describe('Custom filename (without extension)'),
    method: z.string().optional().describe('Capture method: cdp (Page.captureScreenshot) or api (chartWidgetCollection.takeScreenshot) (default cdp)'),
    output_dir: z.string().optional().describe('Absolute path to save directory (default: screenshots/ in project root)'),
    wait_for_render: boolish.optional().describe('Wait for the chart canvas to stabilize (same symbol/resolution/size across consecutive polls, no loading spinner) before capturing. Use after chart_set_symbol or chart_set_timeframe to avoid stale frames. Default false.'),
  }, async ({ region, filename, method, output_dir, wait_for_render }) => {
    try { return jsonResult(await core.captureScreenshot({ region, filename, method, output_dir, wait_for_render })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
