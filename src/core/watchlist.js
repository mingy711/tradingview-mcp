/**
 * Core watchlist logic.
 * Uses TradingView's internal widget API with DOM fallback.
 */
import { evaluate, evaluateAsync, getClient, safeString } from '../connection.js';
import { realpath } from 'node:fs/promises';

export async function get() {
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

export async function add({ symbol }) {
  // Use keyboard shortcut to open symbol search in watchlist, type symbol, press Enter
  const c = await getClient();

  // First ensure watchlist panel is open
  const panelState = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[aria-label*="Watchlist"]');
      if (!btn) return { error: 'Watchlist button not found' };
      var isActive = btn.getAttribute('aria-pressed') === 'true'
        || btn.classList.toString().indexOf('Active') !== -1
        || btn.classList.toString().indexOf('active') !== -1;
      if (!isActive) { btn.click(); return { opened: true }; }
      return { opened: false };
    })()
  `);

  if (panelState?.error) throw new Error(panelState.error);
  if (panelState?.opened) await new Promise(r => setTimeout(r, 500));

  // Click the "Add symbol" button (various selectors)
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
        if (btn && btn.offsetParent !== null) { btn.click(); return { found: true, selector: selectors[s] }; }
      }
      // Fallback: find + button in right panel
      var container = document.querySelector('[class*="layout__area--right"]');
      if (container) {
        var buttons = container.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
          var ariaLabel = buttons[i].getAttribute('aria-label') || '';
          if (/add.*symbol/i.test(ariaLabel) || buttons[i].textContent.trim() === '+') {
            buttons[i].click();
            return { found: true, method: 'fallback' };
          }
        }
      }
      return { found: false };
    })()
  `);

  if (!addClicked?.found) throw new Error('Add symbol button not found in watchlist panel');
  await new Promise(r => setTimeout(r, 300));

  // Type the symbol into the search input
  await c.Input.insertText({ text: symbol });
  await new Promise(r => setTimeout(r, 500));

  // Press Enter to select the first result
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  await new Promise(r => setTimeout(r, 300));

  // Press Escape to close search
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });

  return { success: true, symbol, action: 'added' };
}

export async function upload({ filePath }) {
  if (!filePath) throw new Error('filePath is required');

  const absolutePath = await realpath(filePath);
  const c = await getClient();

  // Ensure watchlist panel is open.
  const panelState = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[aria-label*="Watchlist"]');
      if (!btn) return { error: 'Watchlist button not found' };
      var isActive = btn.getAttribute('aria-pressed') === 'true'
        || btn.classList.toString().indexOf('Active') !== -1
        || btn.classList.toString().indexOf('active') !== -1;
      if (!isActive) { btn.click(); return { opened: true }; }
      return { opened: false };
    })()
  `);

  if (panelState?.error) throw new Error(panelState.error);
  if (panelState?.opened) await new Promise(r => setTimeout(r, 500));

  await c.Page.setInterceptFileChooserDialog({ enabled: true });
  let fileChooser;
  const fileChooserPromise = new Promise(resolve => {
    c.Page.fileChooserOpened(params => resolve(params));
  });

  try {
    const menuOpened = await evaluate(`
      (function() {
        var btn = document.querySelector('[data-name="watchlists-button"]');
        if (!btn) return { error: 'Watchlist menu button not found' };
        btn.click();
        return { opened: true };
      })()
    `);

    if (menuOpened?.error) throw new Error(menuOpened.error);
    await new Promise(r => setTimeout(r, 300));

    const importRow = await evaluate(`
      (function() {
        var menu = document.querySelector('.menuBox-XktvVkFF')
          || document.querySelector('[role="menu"]')
          || document.body;
        var rows = menu.querySelectorAll('[role="row"], [role="menuitem"], button, div');
        for (var i = 0; i < rows.length; i++) {
          var text = (rows[i].textContent || '').trim().replace(/\\u2026/g, '...');
          if (/^(Import|Upload)( list| watchlist)?(\\.\\.\\.)?$/i.test(text)) {
            var r = rows[i].getBoundingClientRect();
            return { found: true, text: text, x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
        return { error: 'Upload/Import list menu item not found' };
      })()
    `);

    if (importRow?.error) throw new Error(importRow.error);

    // Dispatch a real (trusted) mouse click so the browser treats it as a user
    // gesture — a synthetic element.click() does not have enough activation to
    // open the file chooser, so Page.fileChooserOpened never fires.
    const { x, y } = importRow;
    await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
    await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });

    fileChooser = await Promise.race([
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
    try { await c.Page.setInterceptFileChooserDialog({ enabled: false }); } catch (_) {}
  }

  return {
    success: true,
    action: 'uploaded',
    filePath,
    absolutePath,
    method: 'tradingview_import_list',
  };
}

export async function delete_({ watchlistName }) {
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
      if (!isActive) { btn.click(); return { opened: true }; }
      return { opened: false };
    })()
  `);

  if (panelState?.error) throw new Error(panelState.error);
  if (panelState?.opened) await new Promise(r => setTimeout(r, 500));

  // Open the "Watchlist" dropdown menu (top-right of the watchlist panel)
  const menuOpened = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="watchlists-button"]');
      if (!btn) return { error: 'Watchlist menu button not found' };
      btn.click();
      return { opened: true };
    })()
  `);

  if (menuOpened?.error) throw new Error(menuOpened.error);
  await new Promise(r => setTimeout(r, 300));

  // Click "Open list..." to bring up the Watchlists manager dialog
  const openListClicked = await evaluate(`
    (function() {
      var menu = document.querySelector('.menuBox-XktvVkFF');
      if (!menu) return { error: 'Watchlist dropdown menu not found' };
      var rows = menu.querySelectorAll('[role="row"]');
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

  // Find the matching list item in the manager dialog and click its remove button
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
    // Close the manager dialog before surfacing the error
    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    throw new Error(removeClicked.error);
  }

  await new Promise(r => setTimeout(r, 300));

  // Confirm deletion in the "Delete this watchlist?" dialog
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

  // Close the Watchlists manager dialog
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  return { success: true, watchlistName, action: 'deleted' };
}

export async function getShareLink({ watchlistName } = {}) {
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
      if (!isActive) { btn.click(); return { opened: true }; }
      return { opened: false };
    })()
  `);

  if (panelState?.error) throw new Error(panelState.error);
  if (panelState?.opened) await new Promise(r => setTimeout(r, 500));

  // Open the "Watchlist" dropdown menu (top-right of the watchlist panel)
  const menuOpened = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="watchlists-button"]');
      if (!btn) return { error: 'Watchlist menu button not found' };
      btn.click();
      return { opened: true };
    })()
  `);

  if (menuOpened?.error) throw new Error(menuOpened.error);
  await new Promise(r => setTimeout(r, 300));

  // Switch to the requested watchlist if it isn't already the active one
  if (watchlistName) {
    const switched = await evaluate(`
      (function() {
        var btn = document.querySelector('[data-name="watchlists-button"]');
        if (btn && btn.textContent.trim() === ${safeString(watchlistName)}) return { active: true };
        var menu = document.querySelector('.menuBox-XktvVkFF');
        if (!menu) return { error: 'Watchlist dropdown menu not found' };
        var rows = menu.querySelectorAll('[role="row"]');
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
      // Switching closes the menu — reopen it for the now-active watchlist
      await evaluate(`document.querySelector('[data-name="watchlists-button"]').click()`);
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // "Copy link..." only appears once "Share list" is toggled on
  const shareState = await evaluate(`
    (function() {
      var menu = document.querySelector('.menuBox-XktvVkFF');
      if (!menu) return { error: 'Watchlist dropdown menu not found' };
      var rows = menu.querySelectorAll('[role="row"]');
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
    await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: shareState.x, y: shareState.y });
    await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: shareState.x, y: shareState.y, button: 'left', clickCount: 1 });
    await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: shareState.x, y: shareState.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 600));
    sharingEnabled = true;
  }

  // Find "Copy link..." now that sharing is on
  const copyRow = await evaluate(`
    (function() {
      var menu = document.querySelector('.menuBox-XktvVkFF');
      if (!menu) return { error: 'Watchlist dropdown menu not found' };
      var rows = menu.querySelectorAll('[role="row"]');
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

  // Dispatch a real (trusted) mouse click — clipboard writes require user
  // activation, so a synthetic element.click() silently does nothing.
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: copyRow.x, y: copyRow.y });
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: copyRow.x, y: copyRow.y, button: 'left', clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: copyRow.x, y: copyRow.y, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 500));

  await c.Browser.grantPermissions({ permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  const shareLink = await evaluateAsync('navigator.clipboard.readText()');

  // Close the dropdown menu
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  if (!shareLink || !/^https?:\/\//.test(shareLink)) {
    throw new Error('Failed to read share link from clipboard');
  }

  const activeName = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="watchlists-button"]');
      return btn ? btn.textContent.trim() : null;
    })()
  `);

  return { success: true, watchlistName: activeName, shareLink, sharingEnabled };
}
