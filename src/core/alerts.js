/**
 * Core alert logic.
 */
import { evaluate, evaluateAsync, getClient, safeString, dispatchClick } from '../connection.js';
import { ensureWatchlistPanelOpen, openWatchlistMenu, switchToWatchlist, getActiveWatchlistName } from './watchlist.js';

/**
 * With a custom dropdown already open, select the option whose text contains
 * `optionMatch` (case-insensitive).
 */
async function selectOpenDropdownOption(c, optionMatch, label) {
  const option = await evaluate(`
    (function() {
      var target = ${safeString(optionMatch)}.toLowerCase();
      var options = document.querySelectorAll('[role="option"]');
      for (var i = 0; i < options.length; i++) {
        if (options[i].textContent.trim().toLowerCase().indexOf(target) !== -1) {
          var r = options[i].getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: options[i].textContent.trim() };
        }
      }
      return { error: 'No ' + ${safeString(label)} + ' option matching "' + ${safeString(optionMatch)} + '"' };
    })()
  `);
  if (option?.error) throw new Error(option.error);

  await dispatchClick(c, option.x, option.y);
  await new Promise(r => setTimeout(r, 400));
  return option.text;
}

/**
 * Open a custom dropdown (real click — these widgets don't react to a
 * synthetic element.click()) and select the option whose text contains
 * `optionMatch` (case-insensitive).
 */
async function selectDropdownOption(c, triggerSelector, optionMatch, label) {
  const trigger = await evaluate(`
    (function() {
      var el = document.querySelector(${safeString(triggerSelector)});
      if (!el) return { error: ${safeString(label)} + ' selector not found' };
      var r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()
  `);
  if (trigger?.error) throw new Error(trigger.error);

  await dispatchClick(c, trigger.x, trigger.y);
  await new Promise(r => setTimeout(r, 400));

  return selectOpenDropdownOption(c, optionMatch, label);
}

/**
 * Open the alert "Trigger" (frequency) dropdown — e.g. "Once only",
 * "Once per bar", "Once per bar close", "Once per minute" — and select the
 * option matching `trigger` (case-insensitive substring).
 */
async function selectTriggerFrequency(c, trigger) {
  const field = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-qa-id="trigger-dropdown-button"]');
      if (!btn) return { error: 'Trigger frequency field not found' };
      var r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: btn.textContent.trim() };
    })()
  `);
  if (field?.error) throw new Error(field.error);

  // Exact match — "Once Per Bar" is a substring of "Once Per Bar Close",
  // so a substring check here could false-positive and skip switching.
  if (field.text.trim().toLowerCase() === trigger.trim().toLowerCase()) return field.text;

  await dispatchClick(c, field.x, field.y);
  await new Promise(r => setTimeout(r, 400));

  return selectOpenDropdownOption(c, trigger, 'trigger frequency');
}

export async function create({ condition, price, message }) {
  const opened = await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Create Alert"]')
        || document.querySelector('[data-name="alerts"]');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `);

  if (!opened) {
    const client = await getClient();
    await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 1, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA' });
  }

  await new Promise(r => setTimeout(r, 1000));

  const priceSet = await evaluate(`
    (function() {
      var inputs = document.querySelectorAll('[class*="alert"] input[type="text"], [class*="alert"] input[type="number"]');
      for (var i = 0; i < inputs.length; i++) {
        var label = inputs[i].closest('[class*="row"]')?.querySelector('[class*="label"]');
        if (label && /value|price/i.test(label.textContent)) {
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSet.call(inputs[i], ${safeString(String(price))});
          inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      if (inputs.length > 0) {
        var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSet.call(inputs[0], ${safeString(String(price))});
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    })()
  `);

  if (message) {
    await evaluate(`
      (function() {
        var textarea = document.querySelector('[class*="alert"] textarea')
          || document.querySelector('textarea[placeholder*="message"]');
        if (textarea) {
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          nativeSet.call(textarea, ${JSON.stringify(message)});
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()
    `);
  }

  await new Promise(r => setTimeout(r, 500));
  const created = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button[data-name="submit"], button');
      for (var i = 0; i < btns.length; i++) {
        if (/^create$/i.test(btns[i].textContent.trim())) { btns[i].click(); return true; }
      }
      return false;
    })()
  `);

  return { success: !!created, price, condition, message: message || '(none)', price_set: !!priceSet, source: 'dom_fallback' };
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

/**
 * Create an alert that applies to every symbol on a watchlist, optionally
 * driven by a custom Pine indicator's alertcondition() instead of "Price".
 */
export async function createForWatchlist({ watchlistName, study, alertCondition, message, alertName, trigger } = {}) {
  const c = await getClient();

  await ensureWatchlistPanelOpen();
  await openWatchlistMenu();
  await switchToWatchlist(watchlistName);

  // Click "Add alert on the list..."
  const addAlertRow = await evaluate(`
    (function() {
      var menu = document.querySelector('.menuBox-XktvVkFF');
      if (!menu) return { error: 'Watchlist dropdown menu not found' };
      var rows = menu.querySelectorAll('[role="row"]');
      for (var i = 0; i < rows.length; i++) {
        var text = rows[i].textContent.trim().replace(/\\u2026/g, '...');
        if (/^Add alert on the list/i.test(text)) {
          rows[i].click();
          return { found: true };
        }
      }
      return { error: '"Add alert on the list..." menu item not found' };
    })()
  `);

  if (addAlertRow?.error) throw new Error(addAlertRow.error);
  await new Promise(r => setTimeout(r, 700));

  // Pick the condition source (defaults to "Price" if left untouched)
  if (study) {
    await selectDropdownOption(c, '.select-VfhgWFqC', study, 'condition source');
  }

  // Pick the alertcondition() exposed by the chosen study (if it differs
  // from the default that gets selected automatically)
  if (alertCondition) {
    const current = await evaluate(`
      (function() {
        var dd = document.querySelector('.dropdownButton-lFPR_Qij');
        return dd ? dd.textContent.trim() : null;
      })()
    `);
    if (current === null) throw new Error('Alert condition selector not found (study may not expose alertcondition() options)');
    if (current.toLowerCase().indexOf(alertCondition.toLowerCase()) === -1) {
      await selectDropdownOption(c, '.dropdownButton-lFPR_Qij', alertCondition, 'alert condition');
    }
  }

  // Pick the trigger frequency (defaults to "Only Once" if left untouched)
  if (trigger) {
    await selectTriggerFrequency(c, trigger);
  }

  // Open "Edit message" to set a custom message and/or alert name
  if (message || alertName) {
    const opened = await evaluate(`
      (function() {
        var field = document.querySelector('[data-qa-id="alert-message-button"]');
        if (!field) return { error: 'Message field not found' };
        field.click();
        return { found: true };
      })()
    `);
    if (opened?.error) throw new Error(opened.error);
    await new Promise(r => setTimeout(r, 400));

    if (message) {
      const set = await evaluate(`
        (function() {
          var textarea = document.querySelector('textarea');
          if (!textarea) return { error: 'Message textarea not found' };
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          nativeSet.call(textarea, ${safeString(message)});
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          return { found: true };
        })()
      `);
      if (set?.error) throw new Error(set.error);
    }

    if (alertName) {
      const set = await evaluate(`
        (function() {
          var input = document.querySelector('input[type="text"]');
          if (!input) return { error: 'Alert name input not found' };
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSet.call(input, ${safeString(alertName)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return { found: true };
        })()
      `);
      if (set?.error) throw new Error(set.error);
    }

    const applied = await evaluate(`
      (function() {
        var btns = document.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          if (/^apply$/i.test(btns[i].textContent.trim())) { btns[i].click(); return { found: true }; }
        }
        return { error: 'Apply button not found in Edit message dialog' };
      })()
    `);
    if (applied?.error) throw new Error(applied.error);
    await new Promise(r => setTimeout(r, 300));
  }

  // Submit the alert
  const created = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        if (/^create$/i.test(btns[i].textContent.trim()) && btns[i].offsetParent !== null) {
          btns[i].click();
          return { found: true };
        }
      }
      return { error: 'Create button not found' };
    })()
  `);
  if (created?.error) throw new Error(created.error);
  await new Promise(r => setTimeout(r, 500));

  const activeWatchlistName = await getActiveWatchlistName();

  return {
    success: true,
    watchlistName: activeWatchlistName,
    study: study || 'Price',
    alertCondition: alertCondition || null,
    message: message || null,
    alertName: alertName || null,
    trigger: trigger || 'Only Once',
    action: 'alert_created_for_watchlist',
  };
}

export async function deleteAlerts({ delete_all }) {
  if (delete_all) {
    const result = await evaluate(`
      (function() {
        var alertBtn = document.querySelector('[data-name="alerts"]');
        if (alertBtn) alertBtn.click();
        var header = document.querySelector('[data-name="alerts"]');
        if (header) {
          header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
          return { context_menu_opened: true };
        }
        return { context_menu_opened: false };
      })()
    `);
    return { success: true, note: 'Alert deletion requires manual confirmation in the context menu.', context_menu_opened: result?.context_menu_opened || false, source: 'dom_fallback' };
  }
  throw new Error('Individual alert deletion not yet supported. Use delete_all: true.');
}
