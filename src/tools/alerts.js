import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create a price alert via the TradingView alert dialog', {
    condition: z.string().describe('Alert condition (e.g., "crossing", "greater_than", "less_than")'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message'),
  }, async ({ condition, price, message }) => {
    try { return jsonResult(await core.create({ condition, price, message })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_create_for_watchlist', 'Create an alert that applies to every symbol on a watchlist, optionally driven by a custom Pine indicator alertcondition() instead of "Price"', {
    watchlistName: z.string().optional().describe('Watchlist name (defaults to the currently active watchlist)'),
    study: z.string().optional().describe('Condition source — substring of an indicator name on the chart (defaults to "Price")'),
    alertCondition: z.string().optional().describe('alertcondition() option to select — substring match (e.g., "Entry Zone")'),
    message: z.string().optional().describe('Custom alert message'),
    alertName: z.string().optional().describe('Custom alert name'),
    trigger: z.string().optional().describe('Trigger frequency: "Only Once", "Once Per Bar", "Once Per Bar Close", or "Every time" (defaults to "Only Once")'),
  }, async ({ watchlistName, study, alertCondition, message, alertName, trigger }) => {
    try { return jsonResult(await core.createForWatchlist({ watchlistName, study, alertCondition, message, alertName, trigger })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'Delete all alerts or open context menu for deletion', {
    delete_all: z.coerce.boolean().optional().describe('Delete all alerts'),
  }, async ({ delete_all }) => {
    try { return jsonResult(await core.deleteAlerts({ delete_all })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
