import { z } from 'zod';
import { boolish } from './_validation.js';
import { jsonResult } from './_format.js';
import * as core from '../core/ui.js';
import { dismissBlockingDialogs } from '../core/dialog.js';

export function registerUiTools(server) {
  server.tool('ui_dismiss_dialogs', 'Detect and dismiss any blocking modal dialogs (e.g. "Leave current replay?", unsaved-changes prompts). Safe to call when no dialog is open — returns an empty list.', {}, async () => {
    try { return jsonResult({ success: true, dismissed: await dismissBlockingDialogs() }); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_click', 'Click a UI element by aria-label, data-name, text content, or class substring', {
    by: z.enum(['aria-label', 'data-name', 'text', 'class-contains']).describe('Selector strategy'),
    value: z.string().describe('Value to match against the chosen selector strategy'),
  }, async ({ by, value }) => {
    try { return jsonResult(await core.click({ by, value })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_open_panel', 'Open, close, or toggle TradingView panels (pine-editor, strategy-tester, watchlist, alerts, trading)', {
    panel: z.enum(['pine-editor', 'strategy-tester', 'watchlist', 'alerts', 'trading']).describe('Panel name'),
    action: z.enum(['open', 'close', 'toggle']).describe('Action to perform'),
  }, async ({ panel, action }) => {
    try { return jsonResult(await core.openPanel({ panel, action })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_fullscreen', 'Toggle TradingView fullscreen mode', {}, async () => {
    try { return jsonResult(await core.fullscreen()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('layout_list', 'List saved chart layouts', {}, async () => {
    try { return jsonResult(await core.layoutList()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('layout_switch', 'Switch to a saved chart layout by name or ID. If the current layout has unsaved changes (Pine code, drawings, indicator settings), the call returns {success:false, unsaved_dialog_present:true} unless discard_unsaved=true is passed. discard_unsaved=true loses those changes irrevocably.', {
    name: z.string().describe('Name or ID of the layout to switch to'),
    discard_unsaved: z.boolean().optional().describe('Set true to proceed past the unsaved-changes dialog and lose any unsaved work on the current layout. Default false (safe).'),
  }, async ({ name, discard_unsaved }) => {
    try { return jsonResult(await core.layoutSwitch({ name, discard_unsaved })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_keyboard', 'Press keyboard keys or shortcuts (e.g., Enter, Escape, Alt+S, Ctrl+Z)', {
    key: z.string().describe('Key to press (e.g., "Enter", "Escape", "Tab", "a", "ArrowUp")'),
    modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).optional().describe('Modifier keys to hold (e.g., ["ctrl", "shift"])'),
  }, async ({ key, modifiers }) => {
    try { return jsonResult(await core.keyboard({ key, modifiers })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_type_text', 'Type text into the currently focused input/textarea element', {
    text: z.string().describe('Text to type into the focused element'),
  }, async ({ text }) => {
    try { return jsonResult(await core.typeText({ text })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_hover', 'Hover over a UI element by aria-label, data-name, or text content', {
    by: z.enum(['aria-label', 'data-name', 'text', 'class-contains']).describe('Selector strategy'),
    value: z.string().describe('Value to match'),
  }, async ({ by, value }) => {
    try { return jsonResult(await core.hover({ by, value })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_scroll', 'Scroll the chart or page up/down/left/right', {
    direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
    amount: z.coerce.number().optional().describe('Scroll amount in pixels (default 300)'),
  }, async ({ direction, amount }) => {
    try { return jsonResult(await core.scroll({ direction, amount })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_mouse_click', 'Click at specific x,y coordinates OR on a DOM-matched element. Pass selector to side-step the WSL2 / HiDPI devicePixelRatio mismatch (CSS-pixel coords from ui_find_element land on adjacent elements when sent raw to dispatchMouseEvent). Selector path computes the element center in CSS pixels then multiplies by devicePixelRatio internally.', {
    x: z.coerce.number().optional().describe('X coordinate in DEVICE pixels (pre-scaled by devicePixelRatio). Omit when using selector.'),
    y: z.coerce.number().optional().describe('Y coordinate in DEVICE pixels (pre-scaled by devicePixelRatio). Omit when using selector.'),
    selector: z.string().optional().describe('CSS selector to click. Element\'s center is computed and devicePixelRatio-scaled internally. Preferred over raw coords.'),
    button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default left)'),
    double_click: boolish.optional().describe('Double click (default false)'),
  }, async ({ x, y, selector, button, double_click }) => {
    try { return jsonResult(await core.mouseClick({ x, y, selector, button, double_click })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_find_element', 'Find UI elements by text, aria-label, or CSS selector and return their positions', {
    query: z.string().describe('Text content, aria-label value, or CSS selector to search for'),
    strategy: z.enum(['text', 'aria-label', 'css']).optional().describe('Search strategy (default: text)'),
  }, async ({ query, strategy }) => {
    try { return jsonResult(await core.findElement({ query, strategy })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

}
