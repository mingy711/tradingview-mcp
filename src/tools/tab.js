import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/tab.js';

export function registerTabTools(server) {
  server.tool('tab_list', 'List all open TradingView chart tabs. Includes the active Pine script per tab unless include_pine_script is false.', {
    include_pine_script: z.coerce.boolean().optional().describe('Probe each tab for its active Pine script name (adds ~50ms per tab). Default true.'),
  }, async ({ include_pine_script }) => {
    try { return jsonResult(await core.list({ include_pine_script })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_new', 'Open a new chart tab by triggering the tab-strip "+" button via React onClick. The new tab lands on TV\'s layout-picker page (URL stays empty until a layout is chosen). Returns picker_tab_id so callers can switch into it OR clean it up via tab_close({ id }). Selecting a layout still requires user action in TV.', {}, async () => {
    try { return jsonResult(await core.newTab()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_close', 'Close a chart tab (or picker tab) via CDP. Defaults to the tab the MCP client is currently attached to; pass id to close a specific tab (e.g., a picker_tab_id from tab_new). Refuses to close the last chart tab.', {
    id: z.string().optional().describe('CDP target ID of the tab to close. Omit to close the currently-attached tab.'),
  }, async ({ id }) => {
    try { return jsonResult(await core.closeTab({ id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_switch', 'Switch to a chart tab by index', {
    index: z.coerce.number().describe('Tab index (0-based, from tab_list)'),
  }, async ({ index }) => {
    try { return jsonResult(await core.switchTab({ index })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_switch_by_name', 'Switch to a chart tab by the Pine script name open in its editor. Exact match first, then substring fallback. Throws with available names when no match.', {
    name: z.string().describe('Pine script name to match against the editor title in each tab'),
  }, async ({ name }) => {
    try { return jsonResult(await core.switchTabByName({ name })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
