/**
 * Core screenshot/capture logic.
 */
import { getClient as _getClient, evaluate as _evaluate, getChartCollection as _getChartCollection, withReconnect as _withReconnect } from '../connection.js';
import { waitForChartRender as _waitForChartRender } from '../wait.js';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { resolveScreenshotDir } from './paths.js';

function _resolve(deps) {
  return {
    getClient: deps?.getClient || _getClient,
    evaluate: deps?.evaluate || _evaluate,
    getChartCollection: deps?.getChartCollection || _getChartCollection,
    withReconnect: deps?.withReconnect || _withReconnect,
    waitForChartRender: deps?.waitForChartRender || _waitForChartRender,
  };
}

export async function captureScreenshot({ region, filename, method, output_dir, wait_for_render, _deps } = {}) {
  const { evaluate, getChartCollection, withReconnect, waitForChartRender } = _resolve(_deps);

  // Opt-in stabilizer for callers that just changed symbol/timeframe and
  // would otherwise capture the previous frame. Default off because most
  // callers shoot a known-stable chart and don't want the extra latency.
  // renderStable: null = not requested, true = stabilized, false = timed out.
  let renderStable = null;
  if (wait_for_render) {
    renderStable = await waitForChartRender();
  }
  const renderTimedOut = renderStable === false;

  if (method === 'api') {
    try {
      const colPath = await getChartCollection();
      await evaluate(`${colPath}.takeScreenshot()`);
      return {
        success: true, method: 'api',
        waited_for_render: !!wait_for_render,
        ...(renderTimedOut && { render_stabilized: false, render_note: 'wait_for_render timed out before the chart stabilized; the frame may be mid-repaint' }),
        note: 'takeScreenshot() triggered — TradingView will save/show the screenshot via its own UI',
      };
    } catch {
      // Fall through to CDP method
    }
  }

  // Resolve the save path only on the CDP path — the api path above never
  // writes a file, so it shouldn't create (or fail validating) a directory.
  const targetDir = resolveScreenshotDir(output_dir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fname = (filename || `tv_${region || 'full'}_${ts}`).replace(/[/\\]/g, '_');
  const filePath = join(targetDir, `${fname}.png`);

  let clip = undefined;

  if (region === 'chart') {
    const bounds = await evaluate(`
      (function() {
        var el = document.querySelector('[data-name="pane-canvas"]')
          || document.querySelector('[class*="chart-container"]')
          || document.querySelector('canvas');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `);
    // A present-but-collapsed element has a zero-dimension rect; a zero-size
    // clip makes Page.captureScreenshot throw. Fall back to a full capture.
    if (bounds && bounds.width > 0 && bounds.height > 0) clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 };
  } else if (region === 'strategy_tester') {
    const bounds = await evaluate(`
      (function() {
        var el = document.querySelector('[data-name="backtesting"]')
          || document.querySelector('[class*="strategyReport"]');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `);
    if (bounds && bounds.width > 0 && bounds.height > 0) clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 };
  }

  const params = { format: 'png' };
  if (clip) params.clip = clip;

  const { data } = await withReconnect(c => c.Page.captureScreenshot(params));
  writeFileSync(filePath, Buffer.from(data, 'base64'));

  return {
    success: true, method: 'cdp', file_path: filePath, region,
    waited_for_render: !!wait_for_render,
    ...(renderTimedOut && { render_stabilized: false, render_note: 'wait_for_render timed out before the chart stabilized; the frame may be mid-repaint' }),
    size_bytes: Buffer.from(data, 'base64').length,
  };
}
