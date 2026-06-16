/**
 * Core alert logic.
 *
 * Both create() and deleteAlerts() POST to pricealerts.tradingview.com — the
 * same endpoint list() already uses. Earlier versions of this file scraped
 * the alert dialog via DOM/keystroke automation; that approach was brittle
 * across TV UI revisions and locales, didn't return the assigned alert_id,
 * and couldn't bulk-delete. The REST path is locale-proof and aligns with
 * createIndicator() (Pine `alertcondition()` alerts).
 *
 * CORS gotcha: do NOT add a Content-Type header — a custom Content-Type
 * triggers a preflight OPTIONS that pricealerts.tradingview.com rejects.
 * We embed the body via JSON.stringify so it lands as a JS string literal.
 */
import {
  dispatchClick,
  evaluate as _evaluate,
  evaluateAsync as _evaluateAsync,
  getClient as _getClient,
  safeString,
} from '../connection.js';
import { ensureWatchlistPanelOpen, getActiveWatchlistName, openWatchlistMenu, switchToWatchlist } from './watchlist.js';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    getClient: deps?.getClient || _getClient,
  };
}

async function selectOpenDropdownOption(c, optionMatch, label, { _deps } = {}) {
  const { evaluate } = _resolve(_deps);
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

async function selectDropdownOption(c, triggerSelector, optionMatch, label, { _deps } = {}) {
  const { evaluate } = _resolve(_deps);
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

  return selectOpenDropdownOption(c, optionMatch, label, { _deps });
}

async function selectTriggerFrequency(c, trigger, { _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const field = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-qa-id="trigger-dropdown-button"]');
      if (!btn) return { error: 'Trigger frequency field not found' };
      var r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: btn.textContent.trim() };
    })()
  `);
  if (field?.error) throw new Error(field.error);

  if (field.text.trim().toLowerCase() === trigger.trim().toLowerCase()) return field.text;

  await dispatchClick(c, field.x, field.y);
  await new Promise(r => setTimeout(r, 400));

  return selectOpenDropdownOption(c, trigger, 'trigger frequency', { _deps });
}

// Map user-friendly names to TV's internal alert condition types.
//   cross       — fires on either direction
//   cross_up    — fires only when price crosses up through the level
//   cross_down  — fires only when price crosses down through the level
// Returns null for unknown values so the caller can surface the error
// instead of silently defaulting to bidirectional 'cross' (previous
// behavior masked typos like "greather_than" by treating them as 'cross').
function _normalizeCondition(condition) {
  if (!condition) return 'cross';
  const c = String(condition).toLowerCase().trim();
  if (c === 'cross' || c === 'crossing') return 'cross';
  if (c === 'greater_than' || c === 'above' || c === 'cross_above' || c === 'cross_up') return 'cross_up';
  if (c === 'less_than' || c === 'below' || c === 'cross_below' || c === 'cross_down') return 'cross_down';
  return null;
}

const PRICE_ALERT_DEFAULT_EXPIRATION_DAYS = 30;

export async function create({ condition, price, message, _deps } = {}) {
  const { evaluate, evaluateAsync } = _resolve(_deps);
  if (price == null || isNaN(Number(price))) {
    return { success: false, error: 'price is required and must be a number', source: 'rest_api' };
  }
  const numericPrice = Number(price);

  const symbolInfo = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
        var model = chart.model();
        var sym = model.mainSeries().symbol();
        var info = model.mainSeries().symbolInfo ? model.mainSeries().symbolInfo() : null;
        return {
          symbol: sym,
          currency: (info && info.currency_code) || 'USD',
          resolution: model.mainSeries().properties().interval.value() || '1'
        };
      } catch(e) { return { error: e.message }; }
    })()
  `);
  if (!symbolInfo || symbolInfo.error || !symbolInfo.symbol) {
    return { success: false, error: 'Could not read active chart symbol: ' + (symbolInfo?.error || 'unknown'), source: 'rest_api' };
  }

  const symbolMarker = '=' + JSON.stringify({
    symbol: symbolInfo.symbol,
    adjustment: 'dividends',
    'currency-id': symbolInfo.currency,
  });

  const condType = _normalizeCondition(condition);
  if (condType === null) {
    return {
      success: false,
      error: `Unknown condition "${condition}". Use one of: crossing, greater_than/above/cross_up, less_than/below/cross_down.`,
      source: 'rest_api',
    };
  }
  const bareTicker = String(symbolInfo.symbol).split(':').pop();
  const defaultMessage = message || `${bareTicker} ${condition ? String(condition).toLowerCase() : 'crossing'} ${numericPrice}`;
  const expiration = new Date(Date.now() + PRICE_ALERT_DEFAULT_EXPIRATION_DAYS * 86400 * 1000).toISOString();

  const payload = {
    symbol: symbolMarker,
    resolution: String(symbolInfo.resolution || '1'),
    message: defaultMessage,
    sound_file: null,
    sound_duration: 0,
    popup: true,
    expiration,
    auto_deactivate: true,
    email: false,
    sms_over_email: false,
    mobile_push: true,
    web_hook: null,
    name: null,
    conditions: [{
      type: condType,
      frequency: 'on_first_fire',
      series: [{ type: 'barset' }, { type: 'value', value: numericPrice }],
      resolution: String(symbolInfo.resolution || '1'),
    }],
    active: true,
    ignore_warnings: true,
  };

  const body = JSON.stringify({ payload });
  const response = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/create_alert', {
      method: 'POST',
      credentials: 'include',
      body: ${JSON.stringify(body)}
    }).then(function(r) { return r.text().then(function(t) { return { status: r.status, body: t }; }); })
      .catch(function(e) { return { error: e.message }; })
  `);

  if (!response || response.error) {
    return { success: false, error: response?.error || 'no response', source: 'rest_api' };
  }

  let parsed = null;
  try { parsed = JSON.parse(response.body); } catch { /* not JSON */ }

  if (parsed?.s === 'ok' && parsed?.r) {
    const created = parsed.r;
    return {
      success: true,
      alert_id: created.alert_id || null,
      symbol: symbolInfo.symbol,
      price: numericPrice,
      condition: condType,
      message: defaultMessage,
      expiration: created.expiration || expiration,
      source: 'rest_api',
    };
  }

  return {
    success: false,
    error: parsed?.errmsg || parsed?.err?.code || (response.body ? String(response.body).substring(0, 200) : 'unknown'),
    http_status: response.status,
    source: 'rest_api',
  };
}

export async function list({ _deps } = {}) {
  const { evaluateAsync } = _resolve(_deps);
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
 * driven by a custom Pine indicator's alertcondition() instead of Price.
 */
export async function createForWatchlist({ watchlistName, study, alertCondition, message, alertName, trigger, _deps } = {}) {
  const { evaluate, getClient } = _resolve(_deps);
  const c = await getClient();

  await ensureWatchlistPanelOpen({ _deps });
  await openWatchlistMenu({ _deps });
  await switchToWatchlist(watchlistName, { _deps });

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

  if (study) {
    await selectDropdownOption(c, '.select-VfhgWFqC', study, 'condition source', { _deps });
  }

  if (alertCondition) {
    const current = await evaluate(`
      (function() {
        var dd = document.querySelector('.dropdownButton-lFPR_Qij');
        return dd ? dd.textContent.trim() : null;
      })()
    `);
    if (current === null) throw new Error('Alert condition selector not found (study may not expose alertcondition() options)');
    if (current.toLowerCase().indexOf(alertCondition.toLowerCase()) === -1) {
      await selectDropdownOption(c, '.dropdownButton-lFPR_Qij', alertCondition, 'alert condition', { _deps });
    }
  }

  if (trigger) {
    await selectTriggerFrequency(c, trigger, { _deps });
  }

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

  const activeWatchlistName = await getActiveWatchlistName({ _deps });

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

/**
 * Delete one or more alerts via TV's REST API.
 *
 *   POST https://pricealerts.tradingview.com/delete_alerts
 *   Body: { payload: { alert_ids: [...] } }
 *
 * Accepts:
 *   - { alert_id: 12345 }       — single
 *   - { alert_ids: [1, 2, 3] }  — bulk in one call (TV supports natively)
 *   - { delete_all: true }      — list() first, then delete every id
 */
export async function deleteAlerts({ alert_id, alert_ids, delete_all, _deps } = {}) {
  const { evaluateAsync } = _resolve(_deps);
  let ids = [];
  let invalidInputs = [];

  if (delete_all) {
    const listed = await list({ _deps });
    ids = (listed?.alerts || []).map(a => a.alert_id).filter(x => x != null);
    if (ids.length === 0) {
      return { success: true, deleted_count: 0, note: 'No alerts to delete', source: 'rest_api' };
    }
  } else if (Array.isArray(alert_ids) && alert_ids.length > 0) {
    // Partition: keep valid numerics, surface invalids so the caller sees
    // typos instead of getting a silent partial-success.
    for (const raw of alert_ids) {
      const n = Number(raw);
      if (Number.isFinite(n)) ids.push(n);
      else invalidInputs.push(raw);
    }
    if (ids.length === 0) {
      return {
        success: false,
        error: `No valid alert_ids in input (got ${alert_ids.length}, all non-numeric).`,
        invalid_ids: invalidInputs,
        source: 'rest_api',
      };
    }
  } else if (alert_id != null) {
    const n = Number(alert_id);
    if (isNaN(n)) throw new Error('alert_id must be a number');
    ids = [n];
  } else {
    throw new Error('Pass one of: alert_id (number), alert_ids (array), or delete_all: true');
  }

  const body = JSON.stringify({ payload: { alert_ids: ids } });
  const response = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/delete_alerts', {
      method: 'POST',
      credentials: 'include',
      body: ${JSON.stringify(body)}
    }).then(function(r) { return r.text().then(function(t) { return { status: r.status, body: t }; }); })
      .catch(function(e) { return { error: e.message }; })
  `);

  if (!response || response.error) {
    return { success: false, error: response?.error || 'no response', attempted_ids: ids, source: 'rest_api' };
  }

  let parsed = null;
  try { parsed = JSON.parse(response.body); } catch { /* not JSON */ }

  if (parsed?.s === 'ok') {
    return {
      success: true,
      deleted_count: ids.length,
      deleted_ids: ids,
      invalid_ids: invalidInputs.length > 0 ? invalidInputs : undefined,
      source: 'rest_api',
    };
  }

  return {
    success: false,
    error: parsed?.errmsg || parsed?.err?.code || (response.body ? String(response.body).substring(0, 200) : 'unknown'),
    http_status: response.status,
    attempted_ids: ids,
    source: 'rest_api',
  };
}

const INDICATOR_DEFAULT_EXPIRATION_DAYS = 30;
const INDICATOR_MAX_EXPIRATION_DAYS = 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Create an *indicator* alert that fires on a Pine `alertcondition()` signal.
 *
 * Companion to `create()` — where `create()` produces a price-level alert via
 * the TV alert dialog, this posts directly to TV's REST endpoint with an
 * `alert_cond` condition referencing a saved Pine script's plot index. The
 * intended use is automating strategy-style Pine alerts (BUY/SELL signals
 * piped to a webhook URL) without clicking through the UI for each one.
 *
 * Determining `alert_cond_id` (gotcha): TV counts plot-emitting calls in
 * source order — `plot()`, `plotshape()`, `bgcolor()`, AND `alertcondition()`.
 * `hline()` is NOT counted. So a script with 10 `plot()` + 2 `plotshape()` +
 * 2 `alertcondition()` (BUY then SELL) yields BUY = `plot_12`, SELL = `plot_13`.
 * Easiest discovery: create one alert manually in the TV UI, then call
 * `alert_list` and read the resulting `alert_cond_id` plus the `inputs` /
 * `offsets_by_plot` shape from the response.
 *
 * CORS note: do NOT add a Content-Type header on the fetch — a custom
 * Content-Type triggers a preflight OPTIONS that pricealerts.tradingview.com
 * rejects. The server happily parses the body without an explicit Content-Type.
 */
// Reject webhook URLs that aren't plain http(s) or that target loopback /
// link-local / private hosts. TradingView's servers POST to this URL when the
// alert fires; an attacker-shaped value (e.g. a cloud metadata endpoint) would
// turn alert creation into a server-side request the user never intended.
function _assertSafeWebhook(web_hook) {
  if (!web_hook) return;
  let u;
  try { u = new URL(web_hook); } catch { throw new Error(`web_hook is not a valid URL: ${web_hook}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`web_hook must be an http(s) URL, got "${u.protocol}".`);
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // Note: URL() already canonicalizes decimal/hex IPv4 (2130706433, 0x7f000001)
  // to dotted form, so the IPv4 regexes below catch those obfuscations. The
  // gap is IPv4-mapped IPv6 (::ffff:169.254.169.254 → ::ffff:a9fe:a9fe), which
  // no legitimate public webhook uses — reject the whole ::ffff: class.
  const isPrivate =
    host === 'localhost' || host === '0.0.0.0' || host === '::1' ||
    host.startsWith('::ffff:') ||
    /^127\./.test(host) || /^169\.254\./.test(host) ||
    /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^(fc|fd)[0-9a-f]{2}:/.test(host) || /^fe80:/.test(host);
  if (isPrivate) {
    throw new Error(`web_hook host "${u.hostname}" is loopback/link-local/private — not a valid public webhook target.`);
  }
}

export async function createIndicator({
  pine_id,
  pine_version,
  alert_cond_id,
  inputs,
  offsets_by_plot,
  symbol,
  currency,
  resolution,
  message,
  web_hook,
  frequency,
  expiration_days,
  active,
  _deps,
} = {}) {
  _assertSafeWebhook(web_hook);
  const { evaluate, evaluateAsync } = _resolve(_deps);

  if (!pine_id || typeof pine_id !== 'string') {
    return { success: false, error: 'pine_id is required (e.g. "USER;abc123..." from pine_list_scripts)', source: 'rest_api' };
  }
  if (!alert_cond_id || typeof alert_cond_id !== 'string') {
    return { success: false, error: 'alert_cond_id is required (e.g. "plot_12")', source: 'rest_api' };
  }
  if (!inputs || typeof inputs !== 'object') {
    return { success: false, error: 'inputs is required (object matching the script\'s input.X order)', source: 'rest_api' };
  }
  if (!offsets_by_plot || typeof offsets_by_plot !== 'object') {
    return { success: false, error: 'offsets_by_plot is required (e.g. { plot_0: 0, plot_1: 0, ... })', source: 'rest_api' };
  }

  let resolvedSymbol = symbol;
  let resolvedCurrency = currency;
  let resolvedResolution = resolution;

  if (!resolvedSymbol || !resolvedCurrency || !resolvedResolution) {
    const symbolInfo = await evaluate(`
      (function() {
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
          var model = chart.model();
          var sym = model.mainSeries().symbol();
          var info = model.mainSeries().symbolInfo ? model.mainSeries().symbolInfo() : null;
          return {
            symbol: sym,
            currency: (info && info.currency_code) || 'USD',
            resolution: model.mainSeries().properties().interval.value() || '1'
          };
        } catch(e) { return { error: e.message }; }
      })()
    `);
    if (!symbolInfo || symbolInfo.error || !symbolInfo.symbol) {
      return { success: false, error: 'Could not read active chart symbol: ' + (symbolInfo?.error || 'unknown') + ' — pass symbol/currency/resolution explicitly', source: 'rest_api' };
    }
    resolvedSymbol = resolvedSymbol || symbolInfo.symbol;
    resolvedCurrency = resolvedCurrency || symbolInfo.currency;
    resolvedResolution = resolvedResolution || String(symbolInfo.resolution || '1');
  }

  const symbolMarker = '=' + JSON.stringify({
    symbol: resolvedSymbol,
    adjustment: 'dividends',
    'currency-id': resolvedCurrency,
  });

  const days = Number.isFinite(Number(expiration_days)) && Number(expiration_days) > 0
    ? Math.min(Math.floor(Number(expiration_days)), INDICATOR_MAX_EXPIRATION_DAYS)
    : INDICATOR_DEFAULT_EXPIRATION_DAYS;
  const expiration = new Date(Date.now() + days * MS_PER_DAY).toISOString();

  const payload = {
    symbol: symbolMarker,
    resolution: String(resolvedResolution),
    message: message || '',
    sound_file: null,
    sound_duration: 0,
    popup: false,
    expiration,
    auto_deactivate: false,
    email: false,
    sms_over_email: false,
    mobile_push: false,
    web_hook: web_hook || null,
    name: null,
    conditions: [{
      type: 'alert_cond',
      frequency: frequency || 'on_bar_close',
      alert_cond_id,
      series: [{
        type: 'study',
        study: 'Script@tv-scripting-101',
        offsets_by_plot,
        inputs,
        pine_id,
        pine_version: pine_version || '1.0',
      }],
      resolution: String(resolvedResolution),
    }],
    active: active !== false,
    ignore_warnings: true,
  };

  const body = JSON.stringify({ payload });
  const response = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/create_alert', {
      method: 'POST',
      credentials: 'include',
      body: ${JSON.stringify(body)}
    }).then(function(r) { return r.text().then(function(t) { return { status: r.status, body: t }; }); })
      .catch(function(e) { return { error: e.message }; })
  `);

  if (!response || response.error) {
    return { success: false, error: response?.error || 'no response', source: 'rest_api' };
  }

  let parsed = null;
  try { parsed = JSON.parse(response.body); } catch { /* not JSON */ }

  if (parsed?.s === 'ok' && parsed?.r) {
    const created = parsed.r;
    return {
      success: true,
      alert_id: created.alert_id || null,
      symbol: resolvedSymbol,
      pine_id,
      alert_cond_id,
      resolution: String(resolvedResolution),
      message: payload.message,
      web_hook: payload.web_hook,
      expiration: created.expiration || expiration,
      source: 'rest_api',
    };
  }

  return {
    success: false,
    error: parsed?.errmsg || parsed?.err?.code || (response.body ? String(response.body).substring(0, 200) : 'unknown'),
    http_status: response.status,
    hint: 'Common cause: alert_cond_id off-by-one (try plot_N+/-1) or inputs schema mismatch. Create one alert manually in the TV UI and call alert_list to compare.',
    source: 'rest_api',
  };
}
