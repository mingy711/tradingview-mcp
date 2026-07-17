/**
 * Core watchlist logic.
 * Uses TradingView's internal widget API with DOM fallback.
 */
import { realpath } from 'node:fs/promises';
import {
  dispatchClick,
  dispatchEscape,
  evaluate as _evaluate,
  evaluateAsync as _evaluateAsync,
  getClient as _getClient,
  safeString,
} from '../connection.js';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    getClient: deps?.getClient || _getClient,
  };
}

/**
 * Ensure the right-hand Watchlist/details/news panel is open.
 */
export async function ensureWatchlistPanelOpen({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const panelState = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[aria-label*="Watchlist"]');
      if (!btn) return { error: 'Watchlist button not found' };
      var isActive = btn.getAttribute('aria-pressed') === 'true'
        || /(?:^|\\s)(?:is)?[Aa]ctive-/.test(btn.className)
        || btn.classList.toString().indexOf('Active') !== -1
        || btn.classList.toString().indexOf('active') !== -1;
      if (!isActive) { btn.click(); return { opened: true }; }
      return { opened: false };
    })()
  `);

  if (panelState?.error) throw new Error(panelState.error);
  if (panelState?.opened) await new Promise(r => setTimeout(r, 500));
  return panelState;
}

/**
 * Open the Watchlist dropdown menu at the top of the watchlist panel.
 */
export async function openWatchlistMenu({ _deps } = {}) {
  const { evaluate, getClient } = _resolve(_deps);
  const c = await getClient();

  // Locate the dropdown button's center. A programmatic btn.click() does NOT
  // reliably open TradingView's React dropdown — only a real CDP pointer click
  // (dispatchClick) does — so we click by coordinate below.
  const rect = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="watchlists-button"]');
      if (!btn) return { error: 'Watchlist menu button not found' };
      var r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()
  `);
  if (rect?.error) throw new Error(rect.error);

  // Detect the open dropdown by its stable action items ("Upload list…",
  // "Create new list…", "Open list…") rather than TradingView's rotating
  // hashed menu-container class (e.g. .menuBox-XktvVkFF), which drifts.
  const menuVisible = async () => {
    const res = await evaluate(`
      (function() {
        var nodes = document.querySelectorAll('[role="row"], [role="menuitem"], button, div, span');
        for (var i = 0; i < nodes.length; i++) {
          var t = (nodes[i].textContent || '').trim().replace(/\\u2026/g, '...');
          if (/^(Upload list|Create new list|Open list)\\.\\.\\.$/i.test(t)) return { open: true };
        }
        return { open: false };
      })()
    `);
    return !!res?.open;
  };

  // The dropdown is a toggle: re-check before every click so an already-open
  // menu is never clicked shut. Retry a few times for a slow render.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await menuVisible()) return { opened: true };
    await dispatchClick(c, rect.x, rect.y);
    await new Promise(r => setTimeout(r, 350));
  }
  if (await menuVisible()) return { opened: true };
  return { opened: false, warning: 'watchlist dropdown did not render after 3 attempts' };
}

/**
 * Switch to the named watchlist if it is not already active.
 */
export async function switchToWatchlist(watchlistName, { _deps } = {}) {
  if (!watchlistName) return { switched: false };
  const { evaluate } = _resolve(_deps);

  const switched = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="watchlists-button"]');
      if (btn && btn.textContent.trim() === ${safeString(watchlistName)}) return { active: true };
      // Scan the whole document, not the hashed menu-container class
      // (.menuBox-XktvVkFF), which drifts and matches nothing — see
      // openWatchlistMenu. The distinctive menu-item text below disambiguates.
      var rows = document.querySelectorAll('[role="row"]');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].textContent.trim() === ${safeString(watchlistName)}) {
          rows[i].click();
          return { switched: true };
        }
      }
      return { error: 'Watchlist "' + ${safeString(watchlistName)} + '" not found in menu' };
    })()
  `);

  if (switched?.error) throw new Error(switched.error);
  if (switched?.switched) {
    await new Promise(r => setTimeout(r, 500));
    await openWatchlistMenu({ _deps });
  }
  return switched;
}

/**
 * Read the currently active watchlist name from the dropdown button.
 */
export async function getActiveWatchlistName({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  return evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="watchlists-button"]');
      return btn ? btn.textContent.trim() : null;
    })()
  `);
}

export async function get({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  // Try internal API first — reads from the active watchlist widget
  const symbols = await evaluate(`
    (function() {
      // Method 1: Try the watchlist widget's internal data
      try {
        var rightArea = document.querySelector('[class*="layout__area--right"]');
        if (!rightArea || rightArea.offsetWidth < 50) return { symbols: [], source: 'panel_closed' };
      } catch(e) {}

      // Method 2: Read data-symbol-full attributes from watchlist rows
      var results = [];
      var seen = {};
      var container = document.querySelector('[class*="layout__area--right"]');
      if (!container) return { symbols: [], source: 'no_container' };

      // Find all elements with symbol data attributes
      var symbolEls = container.querySelectorAll('[data-symbol-full]');
      for (var i = 0; i < symbolEls.length; i++) {
        var sym = symbolEls[i].getAttribute('data-symbol-full');
        if (!sym || seen[sym]) continue;
        seen[sym] = true;

        // Find the row and extract price data
        var row = symbolEls[i].closest('[class*="row"]') || symbolEls[i].parentElement;
        var cells = row ? row.querySelectorAll('[class*="cell"], [class*="column"]') : [];
        var nums = [];
        for (var j = 0; j < cells.length; j++) {
          var t = cells[j].textContent.trim();
          if (t && /^[\\-+]?[\\d,]+\\.?\\d*%?$/.test(t.replace(/[\\s,]/g, ''))) nums.push(t);
        }
        results.push({ symbol: sym, last: nums[0] || null, change: nums[1] || null, change_percent: nums[2] || null });
      }

      if (results.length > 0) return { symbols: results, source: 'data_attributes' };

      // Method 3: Scan for ticker-like text in the right panel
      var items = container.querySelectorAll('[class*="symbolName"], [class*="tickerName"], [class*="symbol-"]');
      for (var k = 0; k < items.length; k++) {
        var text = items[k].textContent.trim();
        if (text && /^[A-Z][A-Z0-9.:!]{0,20}$/.test(text) && !seen[text]) {
          seen[text] = true;
          results.push({ symbol: text, last: null, change: null, change_percent: null });
        }
      }

      return { symbols: results, source: results.length > 0 ? 'text_scan' : 'empty' };
    })()
  `);

  return {
    success: true,
    count: symbols?.symbols?.length || 0,
    source: symbols?.source || 'unknown',
    symbols: symbols?.symbols || [],
  };
}

export async function add({ symbol, _deps }) {
  const { evaluate, getClient } = _resolve(_deps);
  const c = await getClient();

  // Ensure watchlist panel is open
  const panelState = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[aria-label*="Watchlist"]');
      if (!btn) return { error: 'Watchlist button not found' };
      var isActive = btn.getAttribute('aria-pressed') === 'true'
        || btn.classList.toString().indexOf('Active') !== -1
        || btn.classList.toString().indexOf('active') !== -1;
      if (!isActive) {
        var r = btn.getBoundingClientRect();
        var x = r.x + r.width/2, y = r.y + r.height/2;
        ['mousedown','mouseup','click'].forEach(function(t) {
          btn.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window, clientX:x, clientY:y }));
        });
        return { opened: true };
      }
      return { opened: false };
    })()
  `);

  if (panelState?.error) throw new Error(panelState.error);
  if (panelState?.opened) await new Promise(r => setTimeout(r, 500));

  // Click "Add symbol" button with real mouse events
  const addClicked = await evaluate(`
    (function() {
      var selectors = [
        '[data-name="add-symbol-button"]',
        '[aria-label="Add symbol"]',
        '[aria-label*="Add symbol"]',
        'button[class*="addSymbol"]',
      ];
      for (var s = 0; s < selectors.length; s++) {
        var btn = document.querySelector(selectors[s]);
        if (btn && btn.offsetParent !== null) {
          var r = btn.getBoundingClientRect();
          var x = r.x + r.width/2, y = r.y + r.height/2;
          ['mousedown','mouseup','click'].forEach(function(t) {
            btn.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window, clientX:x, clientY:y }));
          });
          return { found: true, selector: selectors[s] };
        }
      }
      return { found: false };
    })()
  `);

  if (!addClicked?.found) throw new Error('Add symbol button not found in watchlist panel');
  await new Promise(r => setTimeout(r, 500));

  // Type the symbol
  await c.Input.insertText({ text: symbol });
  await new Promise(r => setTimeout(r, 800));

  // Confirm the symbol-search dropdown surfaced at least one match
  // before committing with Enter. Typos / delisted tickers would
  // otherwise be silently reported as success because we always sent
  // Enter regardless of dropdown state.
  const dropdownHasMatch = await evaluate(`
    (function() {
      var items = document.querySelectorAll('[data-name="symbol-search-items"] [role="option"], [data-name="symbol-search-items"] [class*="item-"]');
      if (items && items.length > 0) return { count: items.length };
      var fallback = document.querySelectorAll('[class*="symbol-search-listbox"] [class*="item"]');
      return { count: fallback ? fallback.length : 0 };
    })()
  `);
  if (!dropdownHasMatch || !dropdownHasMatch.count) {
    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
    return { success: false, symbol, action: 'not_added', reason: 'no_match' };
  }

  // Press Enter to select first result
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  await new Promise(r => setTimeout(r, 500));

  // Press Escape to close search dialog
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });

  return { success: true, symbol, action: 'added' };
}

/**
 * Remove symbols from the active watchlist via TradingView REST API.
 * Strategy: read watchlist metadata from React fiber, extract HttpOnly
 * session cookies via CDP Network.getCookies, then call the /remove/
 * endpoint from Node.js (server-side) with proper authentication.
 * Falls back to UI-based delete (click row + Delete key) if REST fails.
 */
export async function remove({ symbols, _deps }) {
  const { evaluate, getClient } = _resolve(_deps);
  const c = await getClient();

  // Get the active watchlist metadata from the React fiber tree
  const listInfo = await evaluate(`
    (function() {
      var panel = document.querySelector('[class*="layout__area--right"]');
      if (!panel) return null;
      var rows = panel.querySelectorAll('[data-symbol-full]');
      if (!rows.length) return null;
      var row = rows[0];
      var reactKey = Object.keys(row).find(function(k) { return k.indexOf('__reactFiber') === 0; });
      if (!reactKey) return null;
      var fiber = row[reactKey];
      var count = 0;
      while (fiber && count < 45) {
        if (fiber.memoizedProps && fiber.memoizedProps.current && fiber.memoizedProps.current.id) {
          var cur = fiber.memoizedProps.current;
          return { id: cur.id, name: cur.name, symbols: cur.symbols };
        }
        fiber = fiber.return;
        count++;
      }
      return null;
    })()
  `);

  if (!listInfo) throw new Error('Cannot read active watchlist — is the watchlist panel open?');

  // Normalise input symbols to EXCHANGE:SYMBOL format.
  // TradingView stores entries upper-case ("NASDAQ:AAPL"). Comparing
  // case-sensitively silently dropped lower-case prefixed input — match
  // case-insensitively so "nasdaq:aapl" resolves to the stored entry.
  const toRemove = [];
  const skipped = [];
  const stored = listInfo.symbols || [];
  const storedLower = stored.map(s => String(s).toLowerCase());
  for (const sym of symbols) {
    if (sym.includes(':')) {
      const i = storedLower.indexOf(String(sym).toLowerCase());
      if (i >= 0) toRemove.push(stored[i]);
      else skipped.push(sym);
    } else {
      const match = stored.find(s => s.split(':')[1] === String(sym).toUpperCase());
      if (match) toRemove.push(match);
      else skipped.push(sym);
    }
  }

  if (toRemove.length === 0) {
    return { success: true, removed: [], skipped, message: 'No matching symbols in watchlist' };
  }

  // --- Strategy 1: Node.js-side REST API call with CDP-extracted cookies ---
  try {
    await c.Network.enable();
    const { cookies } = await c.Network.getCookies({ urls: ['https://www.tradingview.com'] });
    const cookieHeader = cookies.map(ck => `${ck.name}=${ck.value}`).join('; ');

    const resp = await fetch(`https://www.tradingview.com/api/v1/symbols_list/custom/${listInfo.id}/remove/?source=web-tvd`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Language': 'en',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': 'https://www.tradingview.com',
        'Referer': 'https://www.tradingview.com/',
        'Cookie': cookieHeader,
      },
      body: JSON.stringify(toRemove),
    });

    if (resp.ok) {
      // Refresh the watchlist UI so it reflects the removal
      await evaluate(`
        (function() {
          // Trigger a re-render by toggling the panel
          var evt = new Event('resize');
          window.dispatchEvent(evt);
        })()
      `);
      return { success: true, removed: toRemove, skipped, api: 'rest', listId: listInfo.id, listName: listInfo.name };
    }

    // If REST failed, log and fall through to UI method
    const errBody = await resp.text().catch(() => '');
    console.error(`REST remove failed (${resp.status}): ${errBody}`);
  } catch (err) {
    console.error(`REST remove error: ${err.message}`);
  }

  // --- Strategy 2: UI-based delete (click row + Delete key) ---
  return _removeViaUI({ symbols: toRemove, skipped, _deps });
}

/**
 * Fallback: remove symbols by selecting each row and pressing Delete.
 * Slower but reliable — uses CDP native Input events.
 */
async function _removeViaUI({ symbols, skipped = [], _deps }) {
  const { evaluate, getClient } = _resolve(_deps);
  const c = await getClient();
  const results = [];

  for (const sym of symbols) {
    // Find the row in the DOM and get its coordinates
    const rowInfo = await evaluate(`
      (function() {
        var panel = document.querySelector('[class*="layout__area--right"]');
        if (!panel) return null;
        var rows = panel.querySelectorAll('[data-symbol-full]');
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].getAttribute('data-symbol-full') === ${JSON.stringify(sym)}) {
            var el = rows[i].closest('[class*="row"]') || rows[i];
            var r = el.getBoundingClientRect();
            return { x: r.x + r.width/2, y: r.y + r.height/2, found: true };
          }
        }
        return { found: false };
      })()
    `);

    if (!rowInfo || !rowInfo.found) {
      results.push({ symbol: sym, removed: false, reason: 'not_visible_in_scroll' });
      continue;
    }

    // Click the row using CDP native mouse events (not JS dispatchEvent)
    await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: rowInfo.x, y: rowInfo.y, button: 'left', clickCount: 1 });
    await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: rowInfo.x, y: rowInfo.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 200));

    // Press Delete key
    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Delete', code: 'Delete' });
    await new Promise(r => setTimeout(r, 300));

    results.push({ symbol: sym, removed: true });
  }

  return {
    success: true,
    removed: results.filter(r => r.removed).map(r => r.symbol),
    skipped,
    results,
    api: 'ui',
  };
}

export async function addBulk({ symbols, _deps }) {
  const { evaluate, getClient } = _resolve(_deps);
  // Add multiple symbols in one "Add symbol" dialog session.
  // TradingView keeps the dialog open between adds — just clear and retype.
  const c = await getClient();

  // Ensure watchlist panel is open
  await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[aria-label*="Watchlist"]');
      if (!btn) return;
      var isActive = btn.getAttribute('aria-pressed') === 'true'
        || btn.classList.toString().indexOf('Active') !== -1;
      if (!isActive) {
        var r = btn.getBoundingClientRect();
        ['mousedown','mouseup','click'].forEach(function(t) {
          btn.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window, clientX:r.x+r.width/2, clientY:r.y+r.height/2 }));
        });
      }
    })()
  `);
  await new Promise(r => setTimeout(r, 500));

  // Open the Add symbol dialog once
  const addClicked = await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Add symbol"]')
        || document.querySelector('[data-name="add-symbol-button"]');
      if (!btn || btn.offsetParent === null) return { found: false };
      var r = btn.getBoundingClientRect();
      ['mousedown','mouseup','click'].forEach(function(t) {
        btn.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window, clientX:r.x+r.width/2, clientY:r.y+r.height/2 }));
      });
      return { found: true };
    })()
  `);

  if (!addClicked?.found) throw new Error('Add symbol button not found');
  await new Promise(r => setTimeout(r, 500));

  // Snapshot the panel's current symbols so we can diff after each
  // Enter and report honest per-symbol success. The previous version
  // pushed { added: true } unconditionally — misspelled or delisted
  // tickers silently dropped.
  async function snapshot() {
    const snap = await evaluate(`
      (function() {
        var panel = document.querySelector('[class*="layout__area--right"]');
        if (!panel) return [];
        var out = [];
        var rows = panel.querySelectorAll('[data-symbol-full]');
        for (var i = 0; i < rows.length; i++) {
          var s = rows[i].getAttribute('data-symbol-full');
          if (s) out.push(String(s).toUpperCase());
        }
        return out;
      })()
    `);
    return new Set(Array.isArray(snap) ? snap : []);
  }

  let before = await snapshot();
  const results = [];
  // CDP modifier bits: 4 = meta (macOS Cmd), 2 = ctrl (Linux/Win Ctrl).
  const selectAllMod = process.platform === 'darwin' ? 4 : 2;
  for (const sym of symbols) {
    // Select all text in input and replace with new symbol
    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: selectAllMod });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA' });
    await new Promise(r => setTimeout(r, 100));

    await c.Input.insertText({ text: sym });
    await new Promise(r => setTimeout(r, 800));

    // Bail if the dropdown has no match — pressing Enter without one
    // closes the dialog but adds nothing.
    const dropdownHasMatch = await evaluate(`
      (function() {
        var items = document.querySelectorAll('[data-name="symbol-search-items"] [role="option"], [data-name="symbol-search-items"] [class*="item-"]');
        if (items && items.length > 0) return items.length;
        var fallback = document.querySelectorAll('[class*="symbol-search-listbox"] [class*="item"]');
        return fallback ? fallback.length : 0;
      })()
    `);
    if (!dropdownHasMatch) {
      results.push({ symbol: sym, added: false, reason: 'no_match' });
      continue;
    }

    // Enter to select first result
    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
    await new Promise(r => setTimeout(r, 500));

    const after = await snapshot();
    let landed = null;
    for (const entry of after) {
      if (!before.has(entry)) { landed = entry; break; }
    }
    if (landed) {
      results.push({ symbol: sym, resolved_as: landed, added: true });
      before = after;
    } else {
      results.push({ symbol: sym, added: false, reason: 'not_in_panel_after_enter' });
    }
  }

  // Close dialog
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });

  const addedCount = results.filter(r => r.added).length;
  return {
    success: addedCount === symbols.length,
    count: addedCount,
    failed: symbols.length - addedCount,
    symbols: results,
  };
}

export async function upload({ filePath, _deps } = {}) {
  if (!filePath) throw new Error('filePath is required');

  const absolutePath = await realpath(filePath);
  const { evaluate, getClient } = _resolve(_deps);
  const c = await getClient();

  await ensureWatchlistPanelOpen({ _deps });

  // Page/DOM domains are not enabled globally (see connection.js) — enable
  // them here so fileChooserOpened fires and the native OS file picker
  // doesn't open (which would block the Electron main process).
  await c.Page.enable();
  await c.DOM.enable();
  await c.Page.setInterceptFileChooserDialog({ enabled: true });

  const fileChooserPromise = new Promise(resolve => {
    c.Page.fileChooserOpened(params => resolve(params));
  });

  try {
    await openWatchlistMenu({ _deps });

    // Scan the whole document for the "Upload list…" item rather than scoping
    // to the hashed menu-container class (.menuBox-XktvVkFF), which drifts and
    // now matches nothing — the same reason openWatchlistMenu was rewritten.
    // Prefer the deepest (smallest) matching node so we click the real leaf
    // menu item, not an oversized wrapper div that also contains the text.
    const importRow = await evaluate(`
      (function() {
        var nodes = document.querySelectorAll('[role="row"], [role="menuitem"], button, div, span');
        var best = null;
        for (var i = 0; i < nodes.length; i++) {
          var text = (nodes[i].textContent || '').trim().replace(/\\u2026/g, '...');
          if (/^(Import|Upload)( list| watchlist)?(\\.\\.\\.)?$/i.test(text)) {
            var r = nodes[i].getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            var area = r.width * r.height;
            if (!best || area < best.area) {
              best = { found: true, text: text, x: r.x + r.width / 2, y: r.y + r.height / 2, area: area };
            }
          }
        }
        if (best) return best;
        return { error: 'Upload/Import list menu item not found' };
      })()
    `);

    if (importRow?.error) throw new Error(importRow.error);

    await dispatchClick(c, importRow.x, importRow.y);

    const fileChooser = await Promise.race([
      fileChooserPromise,
      new Promise(resolve => setTimeout(() => resolve(null), 2000)),
    ]);

    if (fileChooser?.backendNodeId) {
      await c.DOM.setFileInputFiles({ files: [absolutePath], backendNodeId: fileChooser.backendNodeId });
    } else {
      const doc = await c.DOM.getDocument({ depth: -1, pierce: true });
      const input = await c.DOM.querySelector({ nodeId: doc.root.nodeId, selector: 'input[type="file"]' });
      if (!input?.nodeId) throw new Error('Watchlist file input not found after clicking Upload/Import list');
      await c.DOM.setFileInputFiles({ nodeId: input.nodeId, files: [absolutePath] });
    }

    await new Promise(r => setTimeout(r, 500));
  } finally {
    try { await c.Page.setInterceptFileChooserDialog({ enabled: false }); } catch {}
    try { await c.DOM.disable(); } catch {}
    try { await c.Page.disable(); } catch {}
  }

  return {
    success: true,
    action: 'uploaded',
    filePath,
    absolutePath,
    method: 'tradingview_import_list',
  };
}

export async function delete_({ watchlistName, _deps } = {}) {
  const { evaluate, getClient } = _resolve(_deps);
  const c = await getClient();

  await ensureWatchlistPanelOpen({ _deps });
  await openWatchlistMenu({ _deps });

  const openListClicked = await evaluate(`
    (function() {
      // Scan the whole document, not the hashed menu-container class
      // (.menuBox-XktvVkFF), which drifts and matches nothing — see
      // openWatchlistMenu. The distinctive menu-item text below disambiguates.
      var rows = document.querySelectorAll('[role="row"]');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].textContent.trim().indexOf('Open list') === 0) {
          rows[i].click();
          return { found: true };
        }
      }
      return { error: '"Open list" menu item not found' };
    })()
  `);

  if (openListClicked?.error) throw new Error(openListClicked.error);
  await new Promise(r => setTimeout(r, 400));

  const removeClicked = await evaluate(`
    (function() {
      var targetTitle = ${safeString(watchlistName)};
      var items = document.querySelectorAll('[data-role="list-item"]');
      var target = null;
      for (var i = 0; i < items.length; i++) {
        if (items[i].getAttribute('data-title') === targetTitle) { target = items[i]; break; }
      }
      if (!target) return { error: 'Watchlist "' + targetTitle + '" not found in Watchlists manager' };

      var removeBtn = target.querySelector('[data-name="remove-button"]');
      if (!removeBtn) return { error: 'Remove button not found for watchlist' };
      removeBtn.click();
      return { found: true };
    })()
  `);

  if (removeClicked?.error) {
    await dispatchEscape(c);
    throw new Error(removeClicked.error);
  }

  await new Promise(r => setTimeout(r, 300));

  const confirmed = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].textContent.trim() === 'Delete' && btns[i].offsetParent !== null) {
          btns[i].click();
          return { confirmed: true };
        }
      }
      return { error: 'Delete confirmation dialog not found' };
    })()
  `);

  if (confirmed?.error) throw new Error(confirmed.error);
  await new Promise(r => setTimeout(r, 300));
  await dispatchEscape(c);

  return { success: true, watchlistName, action: 'deleted' };
}

export async function getShareLink({ watchlistName, _deps } = {}) {
  const { evaluate, evaluateAsync, getClient } = _resolve(_deps);
  const c = await getClient();

  await ensureWatchlistPanelOpen({ _deps });
  await openWatchlistMenu({ _deps });
  await switchToWatchlist(watchlistName, { _deps });

  const shareState = await evaluate(`
    (function() {
      // Scan the whole document, not the hashed menu-container class
      // (.menuBox-XktvVkFF), which drifts and matches nothing — see
      // openWatchlistMenu. The distinctive menu-item text below disambiguates.
      var rows = document.querySelectorAll('[role="row"]');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].textContent.trim() === 'Share list') {
          var r = rows[i].getBoundingClientRect();
          return { found: true, checked: rows[i].getAttribute('aria-checked') === 'true', x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return { error: '"Share list" menu item not found' };
    })()
  `);

  if (shareState?.error) throw new Error(shareState.error);

  let sharingEnabled = false;
  if (!shareState.checked) {
    await dispatchClick(c, shareState.x, shareState.y);
    await new Promise(r => setTimeout(r, 600));
    sharingEnabled = true;
  }

  const copyRow = await evaluate(`
    (function() {
      // Scan the whole document, not the hashed menu-container class
      // (.menuBox-XktvVkFF), which drifts and matches nothing — see
      // openWatchlistMenu. The distinctive menu-item text below disambiguates.
      var rows = document.querySelectorAll('[role="row"]');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].textContent.trim().replace(/\\u2026/g, '...') === 'Copy link...') {
          var r = rows[i].getBoundingClientRect();
          return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return { error: '"Copy link..." menu item not found' };
    })()
  `);

  if (copyRow?.error) throw new Error(copyRow.error);

  await dispatchClick(c, copyRow.x, copyRow.y);
  await new Promise(r => setTimeout(r, 500));

  await c.Browser.grantPermissions({ permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  const shareLink = await evaluateAsync('navigator.clipboard.readText()');
  await dispatchEscape(c);

  if (!shareLink || !/^https?:\/\//.test(shareLink)) {
    throw new Error('Failed to read share link from clipboard');
  }

  const activeName = await getActiveWatchlistName({ _deps });
  return { success: true, watchlistName: activeName, shareLink, sharingEnabled };
}
