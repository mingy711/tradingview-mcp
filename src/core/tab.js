/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP and Electron keyboard shortcuts.
 */
import CDP from 'chrome-remote-interface';
import { getClient, connectToTarget, getTargetInfo, claimAndPin, releaseAndUnpin, getPin } from '../connection.js';
import * as registry from './pin_registry.js';

// See src/connection.js for why IPv4 is the safer default than 'localhost'.
const CDP_HOST = process.env.TV_CDP_HOST || '127.0.0.1';
const CDP_PORT = Number(process.env.TV_CDP_PORT) || 9222;

// Per-target Pine read timeout. A single hung target (e.g., one that's
// mid-navigation) would otherwise stall the whole `tab list` fan-out.
const PINE_READ_TIMEOUT_MS = 2000;

/**
 * Open a short-lived CDP client for a specific target and read its Pine
 * editor's currently-active script name (if any). Returns null when the
 * Pine editor isn't open in that tab, the read fails, or the read takes
 * longer than PINE_READ_TIMEOUT_MS.
 *
 * Walks the title-button DOM rather than a JS API since the latter requires
 * the React fiber dance our FIND_MONACO does, which is slow per-tab. The
 * title button is a single querySelector; we grab its h2 textContent.
 *
 * cdpFactory is injectable for tests — defaults to chrome-remote-interface's
 * CDP() function.
 */
async function _readActivePineScript(targetId, cdpFactory = CDP) {
  const sentinel = Symbol('timeout');
  let client = null;
  let timer = null;

  // Capture the client into the outer scope the instant cdpFactory
  // resolves — not after `await` completes — so the timeout path can
  // close it once the slow connect finally lands. Without this, every
  // hung-target read (the scenario this function exists for) leaked
  // a CDP socket.
  const connectAndRead = (async () => {
    client = await cdpFactory({ host: CDP_HOST, port: CDP_PORT, target: targetId });
    await client.Runtime.enable();
    const { result } = await client.Runtime.evaluate({
      expression: `
        (function() {
          var btn = document.querySelector('[data-qa-id="pine-script-title-button"]');
          if (!btn) return null;
          var h2 = btn.querySelector('h2') || btn;
          var name = (h2.textContent || '').trim();
          return name || null;
        })()
      `,
      returnByValue: true,
    });
    return result?.value || null;
  })();
  const safeWork = connectAndRead.catch(() => null);

  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(sentinel), PINE_READ_TIMEOUT_MS);
  });

  try {
    const winner = await Promise.race([safeWork, timeout]);
    if (winner === sentinel) {
      // Schedule cleanup for the late-arriving client. safeWork never
      // rejects, so this can't add an unhandled rejection.
      safeWork.then(() => { if (client) { try { client.close(); } catch {} } });
      return null;
    }
    return winner;
  } finally {
    if (timer) clearTimeout(timer);
    if (client) { try { await client.close(); } catch {} }
  }
}

/**
 * List all open chart tabs (CDP page targets). Each entry includes the
 * tab's currently-active Pine script name when readable; null when the
 * Pine editor isn't open in that tab.
 *
 * @param {object} opts
 * @param {boolean} [opts.include_pine_script=true] - probe each tab's Pine
 *   title button. Adds ~50ms per tab; pass false for a faster bare list.
 */
export async function list({ include_pine_script = true, _deps } = {}) {
  const cdpFactory = _deps?.cdpFactory || CDP;
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();

  const baseTabs = targets
    .filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    .map((t, i) => ({
      index: i,
      id: t.id,
      title: t.title.replace(/^Live stock.*charts on /, ''),
      url: t.url,
      chart_id: t.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
    }));

  let tabs = baseTabs;
  if (include_pine_script && baseTabs.length > 0) {
    // Fan out per-tab Pine reads in parallel — each is its own
    // short-lived CDP connection so they don't serialize.
    const pineNames = await Promise.all(baseTabs.map(t => _readActivePineScript(t.id, cdpFactory)));
    tabs = baseTabs.map((t, i) => ({ ...t, pine_script: pineNames[i] }));
  }

  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Open a new chart tab by invoking the tab-strip `+` button's React onClick
 * handler in TV Desktop's Electron shell page.
 *
 * Background: Ctrl+T via `Input.dispatchKeyEvent` doesn't work — the chart
 * canvas captures the keystroke before the Electron window sees it. The `+`
 * button lives in a separate Electron shell page (file:///.../index.html)
 * with class `.create-new-tab-button`. DOM `.click()` and CDP
 * `Input.dispatchMouseEvent` don't fire its handler, but reaching through
 * React's `__reactProps` key and calling `onClick` directly DOES work —
 * the handler delegates to `getWindowControl().createAndAddTab({})`.
 *
 * The new tab opens on TV's layout-picker page (NOT a real chart yet). It
 * stays as an empty-URL CDP target until the user picks a saved layout in
 * TV (or until we add a programmatic layout-selection step). We return the
 * picker tab's ID so callers can switch to it or clean it up later via
 * `tab_close({ id })`.
 *
 * @returns {Promise<object>} { success, picker_tab_id, new_target, hint }
 */
async function _findShellPagesAndTrigger(cdpFactory) {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const shells = targets.filter(t => t.type === 'page' && /file:\/\/.*index\.html/i.test(t.url));
  for (const shell of shells) {
    let c;
    try {
      c = await cdpFactory({ host: CDP_HOST, port: CDP_PORT, target: shell.id });
      const { result } = await c.Runtime.evaluate({
        expression: `
          (function() {
            var btn = document.querySelector('.create-new-tab-button');
            if (!btn || btn.offsetParent === null) return { no_btn: true };
            var key = Object.keys(btn).find(function(k) { return k.indexOf('__reactProps') === 0; });
            if (!key) return { no_react_key: true };
            var props = btn[key];
            if (!props || typeof props.onClick !== 'function') return { no_onclick: true };
            try {
              props.onClick({
                preventDefault: function(){}, stopPropagation: function(){},
                currentTarget: btn, target: btn, type: 'click', button: 0,
              });
              return { invoked: true };
            } catch(e) { return { call_err: e.message }; }
          })()
        `,
        returnByValue: true,
      });
      if (result?.value?.invoked) return { ok: true, shell_id: shell.id };
    } catch { /* try next shell */ }
    finally { if (c) try { await c.close(); } catch {} }
  }
  return { ok: false };
}

export async function newTab({ _deps } = {}) {
  const cdpFactory = _deps?.cdpFactory || CDP;
  const fetchFn = _deps?.fetch || globalThis.fetch;

  // Snapshot CDP targets so we can identify the newly-opened tab via diff.
  // Include ALL pages (not just chart tabs) because the new tab starts with
  // an empty URL until TV's layout picker loads.
  const respBefore = await fetchFn(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const beforeAll = await respBefore.json();
  const beforeIds = new Set(beforeAll.filter(t => t.type === 'page').map(t => t.id));

  const trig = await _findShellPagesAndTrigger(cdpFactory);
  if (!trig.ok) {
    return {
      success: false,
      action: 'no_shell_found',
      hint: 'Could not find a TV Desktop Electron shell page with the .create-new-tab-button. Either TV is not running or its UI has changed; open a new tab manually in TV.',
    };
  }

  // Poll for the new tab. TV typically registers the picker page within
  // ~1 s; cap at 5 s for slow boxes.
  let newTarget = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
    const respAfter = await fetchFn(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
    const afterAll = await respAfter.json();
    const fresh = afterAll.filter(t => t.type === 'page' && !beforeIds.has(t.id));
    if (fresh.length > 0) {
      // Prefer empty-URL (picker) over chart pages — the picker is what +
      // produces; any chart page that snuck in was created by something else.
      newTarget = fresh.find(t => !t.url) || fresh[0];
      break;
    }
  }

  if (!newTarget) {
    return {
      success: false,
      action: 'triggered_but_no_new_tab',
      hint: 'Triggered the + button via React but no new tab appeared within 5s. May indicate Electron sandbox restrictions; open a new tab manually in TV.',
    };
  }

  return {
    success: true,
    action: 'picker_tab_opened',
    picker_tab_id: newTarget.id,
    new_target: { id: newTarget.id, url: newTarget.url || '', title: newTarget.title || '' },
    hint: 'New tab is on TV\'s layout picker. To complete: pick a layout in TV manually, OR call tab_close with this picker_tab_id to discard. tab_list will show the tab once a layout is chosen and the URL becomes /chart/<id>/.',
  };
}

/**
 * Close a tab via CDP's `/json/close/<id>` HTTP endpoint. This works
 * for any page target, including the empty-URL picker tabs that
 * `tab_new` leaves behind when the user hasn't picked a layout. The
 * Ctrl+W keyboard shortcut (previous implementation) has the same
 * Electron user-gesture problem Ctrl+T does and proved unreliable.
 *
 * @param {object} opts
 * @param {string} [opts.id] - target ID to close. If omitted, closes the
 *   tab the MCP client is currently attached to (via getTargetInfo).
 */
export async function closeTab({ id, _deps } = {}) {
  const fetchFn = _deps?.fetch || globalThis.fetch;
  const targetInfoFn = _deps?.getTargetInfo || getTargetInfo;

  let targetId = id;
  if (!targetId) {
    // Default: close whatever tab the MCP client is attached to.
    const info = await targetInfoFn();
    targetId = info?.id;
    if (!targetId) throw new Error('No tab id provided and no current CDP target attached.');
  }

  // Don't close the last chart tab — leaves the user with nothing visible.
  // Picker tabs (empty URL) don't count for this check; closing them is the
  // intended cleanup path.
  const respAll = await fetchFn(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const all = await respAll.json();
  const chartTabs = all.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
  const target = all.find(t => t.id === targetId);
  if (!target) {
    throw new Error(`No CDP target found with id ${targetId}. It may already be closed.`);
  }
  const targetIsChart = target.url && /tradingview\.com\/chart/i.test(target.url);
  if (targetIsChart && chartTabs.length <= 1) {
    throw new Error('Cannot close the last chart tab. Use tv_launch to restart TradingView instead.');
  }

  const closeResp = await fetchFn(`http://${CDP_HOST}:${CDP_PORT}/json/close/${targetId}`);
  const closeBody = closeResp && closeResp.text ? await closeResp.text() : '';
  if (closeResp && closeResp.status && closeResp.status >= 400) {
    throw new Error(`CDP close failed (${closeResp.status}): ${closeBody}`);
  }

  // Re-list to report post-close state.
  await new Promise(r => setTimeout(r, 500));
  const after = await list({ include_pine_script: false });
  return {
    success: true,
    action: 'tab_closed',
    closed_id: targetId,
    closed_url: target.url || '',
    chart_tabs_remaining: after.tab_count,
  };
}

/**
 * Switch to a tab by index OR id. Reconnects CDP to the new target.
 *
 * Prefer `id` when calling from another function that already resolved
 * a tab — passing index forces a second list() round-trip and races
 * against tab opens/closes that happen between the two calls.
 */
export async function switchTab({ index, id }) {
  let target;
  if (id) {
    const tabs = await list({ include_pine_script: false });
    target = tabs.tabs.find(t => t.id === id);
    if (!target) {
      throw new Error(`Tab id ${id} not found (have ${tabs.tab_count} tabs)`);
    }
  } else {
    const tabs = await list({ include_pine_script: false });
    const idx = Number(index);
    if (idx >= tabs.tab_count) {
      throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
    }
    target = tabs.tabs[idx];
  }

  // Activate the tab visually and reconnect CDP client to the new target.
  // Use CDP Target.activateTarget rather than the /json/activate REST hook —
  // Electron honors the CDP method but ignores the REST call for visual focus
  // changes, so the user sees the tab "switch" but the active widget stays
  // on the previous one until reload.
  try {
    const currentClient = await getClient();
    await currentClient.Target.activateTarget({ targetId: target.id });
    await new Promise(r => setTimeout(r, 500));
    await connectToTarget(target.id);
    return { success: true, action: 'switched', index: target.index, tab_id: target.id, chart_id: target.chart_id };
  } catch (e) {
    throw new Error(`Failed to activate tab ${target.id}: ${e.message}`);
  }
}

/**
 * Switch to a tab by Pine script name. Useful when tab indices shift across
 * sessions but the user knows the script title in the editor.
 *
 * Strategy: list all tabs (with Pine script reads), find the first whose
 * pine_script matches `name` exactly (case-insensitive), then delegate to
 * switchTab(index). Falls back to substring match if no exact hit. Throws
 * with the available script names when nothing matches.
 */
export async function switchTabByName({ name, _deps } = {}) {
  if (!name || typeof name !== 'string') {
    throw new Error('name (string) is required');
  }
  const tabs = await list({ include_pine_script: true, _deps });
  const target = name.toLowerCase();

  // Exact match first
  let match = tabs.tabs.find(t => (t.pine_script || '').toLowerCase() === target);
  // Fuzzy fallback: substring
  if (!match) {
    match = tabs.tabs.find(t => (t.pine_script || '').toLowerCase().includes(target));
  }

  if (!match) {
    const available = tabs.tabs
      .map(t => t.pine_script)
      .filter(Boolean);
    throw new Error(
      `No tab found with Pine script "${name}". ` +
      (available.length
        ? `Available scripts: ${available.join(', ')}.`
        : `No tabs have a Pine script open.`),
    );
  }

  return switchTab({ id: match.id });
}

// ── Pin / unpin / registry ───────────────────────────────────────────────
//
// Pin one TV tab as the deterministic CDP target for this process. The
// in-process pin lives in connection.js; the cross-instance registry
// (~/.tv-mcp-registry.json) makes two parallel Claude sessions safe by
// refusing double-claims of the same targetId.
//
// Match-by-symbol is implemented through tab `list()` — which already
// reads the active Pine script name + chart symbol per tab — so callers
// can target "the GC1! tab" without knowing the CDP target id.

/**
 * Pin to one tab by id | title | symbol | url. Exactly one must be set.
 * Returns { success, action, target_id, matched_by, force, displaced? }
 * on success; throws (with `err.code === 'PIN_CONFLICT'` + `err.owner`)
 * if another live process owns the tab and `force=false`.
 */
export async function pin({ id, title, symbol, url, force = false, _deps } = {}) {
  const provided = [id, title, symbol, url].filter(v => v !== undefined && v !== null && v !== '');
  if (provided.length !== 1) {
    throw new Error('tab_pin requires exactly one of: id, title, symbol, url');
  }

  const tabs = (await list({ _deps })).tabs || [];
  let match = null;
  let matchedBy = null;
  if (id) {
    match = tabs.find(t => t.id === id);
    matchedBy = 'id';
    if (!match) throw new Error(`No tab with id=${id}. Use tab_list to enumerate.`);
  } else if (title) {
    const needle = title.toLowerCase();
    match = tabs.find(t => (t.title || '').toLowerCase().includes(needle));
    matchedBy = 'title';
    if (!match) throw new Error(`No tab title matches "${title}"`);
  } else if (symbol) {
    const needle = symbol.toLowerCase();
    match = tabs.find(t => (t.symbol || '').toLowerCase().includes(needle));
    matchedBy = 'symbol';
    if (!match) throw new Error(`No tab symbol matches "${symbol}"`);
  } else if (url) {
    const needle = url.toLowerCase();
    match = tabs.find(t => (t.url || '').toLowerCase().includes(needle));
    matchedBy = 'url';
    if (!match) throw new Error(`No tab url matches "${url}"`);
  }

  let claim;
  try {
    claim = await claimAndPin(match.id, { force });
  } catch (err) {
    if (err.code === 'PIN_CONFLICT') {
      return {
        success: false, conflict: true,
        target_id: match.id, matched_by: matchedBy,
        owner: err.owner,
        hint: 'Pass force=true to take over the pin.',
      };
    }
    throw err;
  }

  return {
    success: true,
    action: 'pinned',
    target_id: match.id,
    matched_by: matchedBy,
    force,
    displaced: claim.displaced,
  };
}

export async function unpin() {
  const prev = getPin();
  const result = await releaseAndUnpin();
  return { success: true, action: 'unpinned', previous_pin: prev, released: result.released };
}

/** Read-only view of the cross-instance pin registry. */
export async function registryList() {
  return registry.list();
}
