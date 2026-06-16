import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/watchlist.js';

export function registerWatchlistTools(server) {
  server.tool('watchlist_get', 'Get all symbols from the current TradingView watchlist with last price, change, and change%', {}, async () => {
    try { return jsonResult(await core.get()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_add', 'Add a symbol to the TradingView watchlist', {
    symbol: z.string().describe('Symbol to add (e.g., AAPL, BTCUSD, ES1!, NYMEX:CL1!)'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.add({ symbol })); }
    catch (err) {
      // Try to close any open search/input on error
      try {
        const { getClient } = await import('../connection.js');
        const c = await getClient();
        await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      } catch {}
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('watchlist_remove', 'Remove one or more symbols from the TradingView watchlist', {
    symbols: z.array(z.string()).describe('Symbols to remove (e.g., ["AAPL", "NASDAQ:MSFT"]). Bare tickers auto-resolve.'),
  }, async ({ symbols }) => {
    try { return jsonResult(await core.remove({ symbols })); }
    catch (err) {
      try {
        const { getClient } = await import('../connection.js');
        const c = await getClient();
        await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
      } catch {}
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('watchlist_add_bulk', 'Add multiple symbols to the TradingView watchlist in one batch', {
    symbols: z.array(z.string()).describe('Array of symbols to add (e.g., ["AAPL", "MSFT", "GOOGL"])'),
  }, async ({ symbols }) => {
    try { return jsonResult(await core.addBulk({ symbols })); }
    catch (err) {
      try {
        const { getClient } = await import('../connection.js');
        const c = await getClient();
        await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      } catch {}
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('watchlist_upload', 'Upload/import a local TradingView watchlist text file using the Watchlist Upload list UI', {
    filePath: z.string().describe('Path to a TradingView watchlist .txt file to import/upload'),
  }, async ({ filePath }) => {
    try { return jsonResult(await core.upload({ filePath })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_delete', 'Delete a watchlist by name', {
    watchlistName: z.string().describe('Name of the watchlist to delete (e.g., "sniper_master_watchlist")'),
  }, async ({ watchlistName }) => {
    try { return jsonResult(await core.delete_({ watchlistName })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_get_share_link', 'Get a shareable link (URL) for a watchlist, enabling sharing for it if not already on', {
    watchlistName: z.string().optional().describe('Name of the watchlist to share. Defaults to the currently active watchlist.'),
  }, async ({ watchlistName }) => {
    try { return jsonResult(await core.getShareLink({ watchlistName })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
