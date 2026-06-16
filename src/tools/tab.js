import { z } from 'zod';
import { boolish } from './_validation.js';
import { jsonResult } from './_format.js';
import * as core from '../core/tab.js';

export function registerTabTools(server) {
  server.tool('tab_list', 'List all open TradingView chart tabs. Includes the active Pine script per tab unless include_pine_script is false.', {
    include_pine_script: boolish.optional().describe('Probe each tab for its active Pine script name (adds ~50ms per tab). Default true.'),
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

  server.tool('tab_pin', 'Pin the MCP to one specific TV tab so every subsequent call deterministically targets it (even when multiple chart tabs are open). Pass exactly one of: id, title, symbol, url. Claims the tab in the cross-instance registry at ~/.tv-mcp-registry.json — if another live Claude session already owns it, returns {success:false, conflict:true, owner:{...}} unless force=true. Cleared on tab_unpin or process exit.', {
    id: z.string().optional().describe('Exact CDP target id (from tab_list)'),
    title: z.string().optional().describe('Substring of tab title (case-insensitive)'),
    symbol: z.string().optional().describe('Substring of chart symbol (e.g. "GC1!", "NVDA")'),
    url: z.string().optional().describe('Substring of tab URL (e.g. "chart/BdrFz9HL")'),
    force: boolish.optional().describe('Take over an existing claim. Use only when you know the other process is stuck or you intend to displace it.'),
  }, async ({ id, title, symbol, url, force }) => {
    try { return jsonResult(await core.pin({ id, title, symbol, url, force })); }
    catch (err) {
      if (err.code === 'PIN_CONFLICT') return jsonResult({ success: false, conflict: true, owner: err.owner, error: err.message }, true);
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('tab_unpin', 'Clear the tab pin and release the cross-instance registry claim. Subsequent calls revert to default-tab selection (first /chart page, optionally narrowed by TV_MCP_TARGET_FILTER env).', {}, async () => {
    try { return jsonResult(await core.unpin()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tab_registry', 'Read-only view of the cross-instance pin registry. Lists every tab currently claimed by any live tradingview-mcp process. Use BEFORE tab_pin to check whether another session already owns a tab.', {}, async () => {
    try { return jsonResult(await core.registryList()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
