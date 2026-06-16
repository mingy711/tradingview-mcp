import CDP from 'chrome-remote-interface';
import { claim as _registryClaim, release as _registryRelease, releaseAllSync as _registryReleaseAllSync } from './core/pin_registry.js';

let client = null;
let targetInfo = null;
// 127.0.0.1, not 'localhost' — some Windows/WSL/Node setups resolve
// 'localhost' to ::1 (IPv6) first, while Chrome's CDP listens only on
// 0.0.0.0 (IPv4). The resulting ETIMEDOUT or ECONNREFUSED looks like a
// missing port even though Chrome is running. Explicit IPv4 avoids it.
// Override with TV_CDP_HOST when targeting a remote / container CDP.
const CDP_HOST = process.env.TV_CDP_HOST || '127.0.0.1';
const CDP_PORT = Number(process.env.TV_CDP_PORT) || 9222;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

export { CDP_HOST, CDP_PORT };

// ── Test-mode overrides ─────────────────────────────────────────────────
// Unit tests (tests/smoke/*) install mocks via __setTestOverrides so core/*
// modules don't need a live CDP. Production code never touches this —
// overrides default to null. Each gated export below short-circuits to its
// override when one is installed for that key.
let _testOverrides = null;

/** Install test mocks. Pass null to reset. */
export function __setTestOverrides(mocks) {
  _testOverrides = mocks;
}
export function __getTestOverrides() { return _testOverrides; }

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

/**
 * Sanitize a string for safe interpolation into JavaScript code evaluated via CDP.
 * Uses JSON.stringify to produce a properly escaped JS string literal (with quotes).
 * Prevents injection via quotes, backticks, template literals, or control chars.
 */
export function safeString(str) {
  return JSON.stringify(String(str));
}

/**
 * Escape a string for safe interpolation inside a JavaScript backtick template
 * body. Defends against `${...}` interpolation, backtick-termination, and
 * trailing backslashes that would escape the closing backtick. For full string
 * literals (with quotes), use safeString. For values pasted into a `...` body
 * to be evaluated remotely, use this.
 */
export function safeBacktickBody(str) {
  return String(str).replace(/[`\\$]/g, (c) => '\\' + c);
}

/**
 * Dispatch a real mouse click at viewport coordinates.
 * Browser-gated actions such as file choosers and clipboard writes need a
 * user-activation style input event; synthetic element.click() is not enough.
 */
export async function dispatchClick(c, x, y) {
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/**
 * Dispatch an Escape key press to close menus and dialogs.
 */
export async function dispatchEscape(c) {
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}

/**
 * Validate that a value is a finite number. Throws if NaN, Infinity, or non-numeric.
 * Prevents corrupt values from reaching TradingView APIs that persist to cloud state.
 */
export function requireFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

export async function getClient() {
  if (_testOverrides?.getClient) return _testOverrides.getClient();
  if (client) {
    let timer;
    try {
      // Quick liveness check with a hard timeout — a half-dead WS will
      // accept the request but never respond, hanging the entire MCP call.
      // Clear the timer on resolution to avoid an unhandled rejection 2s
      // later when the loser promise is no longer awaited.
      const livenessProbe = client.Runtime.evaluate({ expression: '1', returnByValue: true });
      // If the timeout wins the race, this probe is abandoned; a later
      // client.close() rejects all pending callbacks, which would surface as
      // an unhandledRejection (and can kill the process). Swallow it.
      livenessProbe.catch(() => {});
      await Promise.race([
        livenessProbe,
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('liveness timeout')), 2000); }),
      ]);
      clearTimeout(timer);
      return client;
    } catch {
      clearTimeout(timer);
      try { await client.close(); } catch {}
      client = null;
      targetInfo = null;
    }
  }
  return connect();
}

// Errors that should trigger an automatic CDP reconnect rather than bubble
// up. Observed when the TradingView Desktop process restarts, a tab is
// closed, or the network blip drops the WebSocket mid-call.
const RECONNECT_ERR_RE = /connection closed|websocket|ECONNREFUSED|target closed|liveness timeout|socket hang up|disconnected/i;

/**
 * Run a CDP operation with automatic reconnect on transient connection
 * failures. Use this for direct `client.Page.*`, `client.DOM.*`,
 * `client.Input.*` calls — those bypass the cached-client liveness path
 * inside getClient(), so a stale WS surfaces as an unhandled error.
 *
 * Operations passed to `withReconnect` must be idempotent: the runner may
 * invoke them up to `maxRetries` times after force-resetting the cached
 * client.
 */
export async function withReconnect(operation, maxRetries = 3) {
  if (_testOverrides?.withReconnect) return _testOverrides.withReconnect(operation, maxRetries);
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const c = await getClient();
      return await operation(c);
    } catch (err) {
      lastError = err;
      const msg = err?.message || String(err);
      if (!RECONNECT_ERR_RE.test(msg)) throw err;
      try { if (client) await client.close(); } catch {}
      client = null;
      targetInfo = null;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 5000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP operation failed after ${maxRetries} reconnect attempts: ${lastError?.message || lastError}`);
}

let _connecting = null;
export async function connect() {
  // Serialize concurrent connects. Without this, two calls that arrive while
  // client===null each open a CDP socket; the last assignment to the module
  // `client` wins and the earlier socket leaks with no reference to close it.
  if (_connecting) return _connecting;
  _connecting = _doConnect();
  try { return await _connecting; }
  finally { _connecting = null; }
}

async function _doConnect() {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = await findChartTarget();
      if (!target) {
        throw new Error('No TradingView chart target found. Is TradingView open with a chart?');
      }
      targetInfo = target;
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      // Deliberately NOT calling Runtime.enable / Page.enable / DOM.enable.
      //
      // None of our tools subscribe to events from these domains — every
      // call goes through Runtime.evaluate, Input.dispatchKeyEvent, or
      // Page.captureScreenshot, all of which work without the domain
      // being "enabled".
      //
      // Crucially, Runtime.enable instructs TradingView to forward every
      // console.debug() through the CDP WebSocket as Runtime.consoleAPICalled
      // events. When the user closes TradingView the renderer's logger
      // fires final messages through that pipe while the socket is half-
      // closed; Socket._write throws EPIPE, TV doesn't catch it, and the
      // user sees a "Critical Error" dialog every time they close the app.
      //
      // If event subscriptions become necessary later (DOM mutations, frame
      // navigation, console relay), enable per-tool around the operation
      // and disable on cleanup. Do NOT enable globally here.

      // Drop the cached client immediately when TV closes the connection.
      // Without this hook, the next request waits for its own socket error
      // before discovering the connection is dead.
      client.on('disconnect', () => { client = null; targetInfo = null; });

      // Force the chart canvas to keep painting even when this CDP target's
      // tab is in the background. Background tabs report visibilityState
      // 'hidden' which pauses requestAnimationFrame — capture_screenshot
      // returns a blank canvas (HTML overlays render, candles do not).
      // Per-target setting; must re-apply on every (re)attach.
      try { await client.Emulation.setFocusEmulationEnabled({ enabled: true }); } catch {}

      return client;
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

// ── Tab pinning (per-process) + startup filter (env-driven) ─────────────
//
// Both knobs let multi-tab TV setups deterministically route MCP calls.
//   - `setPin(targetId)` is in-process: subsequent CDP calls bind to that
//     tab regardless of which is "active" in TV.
//   - `TV_MCP_TARGET_FILTER=symbol=ES1!` (or title/url/id) is read once at
//     startup and narrows the auto-pick candidate set when no pin is set.
// Cross-instance coordination (so two Claude sessions don't fight over
// the same tab) is layered on via core/pin_registry.js — see
// `claimAndPin` / `releaseAndUnpin` below.
let pinnedTargetId = null;
const activeFilter = parseFilter(process.env.TV_MCP_TARGET_FILTER);

function parseFilter(raw) {
  if (!raw) return null;
  const m = String(raw).match(/^(symbol|title|url|id)\s*([=~])\s*(.+)$/i);
  if (!m) throw new Error(`Invalid TV_MCP_TARGET_FILTER: ${raw}. Expected <field><op><value> where field is symbol|title|url|id and op is = or ~.`);
  return { field: m[1].toLowerCase(), op: m[2], value: m[3].trim() };
}

function targetMatchesFilter(target, filter) {
  if (!filter) return true;
  const { field, value } = filter;
  if (field === 'id') return target.id === value;
  // symbol/title/url all live in title or URL on TV chart targets;
  // URL is the reliable signal for symbol since the title is generic.
  const haystack = field === 'title' ? (target.title || '') : (target.url || '');
  return haystack.toLowerCase().includes(value.toLowerCase());
}

export function setPin(targetId) {
  pinnedTargetId = targetId;
  // Drop the cached client so the next call rebinds to the new pin.
  if (client) { try { client.close(); } catch {} client = null; targetInfo = null; }
}
export function clearPin() { setPin(null); }
export function getPin() { return pinnedTargetId; }
export function getActiveFilter() { return activeFilter; }

/**
 * Claim a target in the cross-instance registry, then pin it in-process.
 * Throws with `err.code === 'PIN_CONFLICT'` if another live process owns
 * it (unless `force: true`). Registers the exit-time cleanup hook the
 * first time it's called so this process's claims don't outlive it.
 */
export async function claimAndPin(targetId, { force = false, lane = null } = {}) {
  ensureRegistryExitHandler();
  const prev = pinnedTargetId;
  const result = await _registryClaim(targetId, { force, lane });
  setPin(targetId);
  // Release any prior pin we held — moving to a new tab.
  if (prev && prev !== targetId) {
    try { await _registryRelease(prev); } catch {}
  }
  return result;
}

/** Release the cross-instance claim AND clear the in-process pin. */
export async function releaseAndUnpin() {
  const prev = pinnedTargetId;
  setPin(null);
  if (prev) return _registryRelease(prev);
  return { released: false };
}

let _registryExitRegistered = false;
let _gracefulShutdownOwner = false;

// Marked by a long-lived host (the MCP server) that installs its own async
// SIGINT/SIGTERM handler to flush the CDP socket cleanly before exit. When
// set, the registry's signal handlers do their synchronous release but do
// NOT call process.exit — letting the owner's async teardown finish instead
// of racing it to process.exit (which would skip the CDP flush and trigger
// TV's EPIPE "Critical Error" dialog).
export function setGracefulShutdownOwner() { _gracefulShutdownOwner = true; }

function ensureRegistryExitHandler() {
  if (_registryExitRegistered) return;
  _registryExitRegistered = true;
  // releaseAllSync is best-effort and swallows its own errors — safe to
  // attach to multiple signals without double-cleanup concerns. The 'exit'
  // event does NOT fire on a raw signal kill, so the signal handlers below
  // do the synchronous release themselves (and exit only when nobody else
  // owns graceful shutdown).
  process.on('exit', _registryReleaseAllSync);
  process.on('SIGINT', () => { _registryReleaseAllSync(); if (!_gracefulShutdownOwner) process.exit(130); });
  process.on('SIGTERM', () => { _registryReleaseAllSync(); if (!_gracefulShutdownOwner) process.exit(143); });
}

async function findChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const pages = targets.filter(t => t.type === 'page');

  // 1. In-process pin wins. Hard-fail if the pinned tab is gone, so
  //    callers learn immediately rather than silently drifting onto a
  //    different chart.
  if (pinnedTargetId) {
    const pinned = pages.find(t => t.id === pinnedTargetId);
    if (!pinned) {
      throw new Error(`Pinned target ${pinnedTargetId} not found. Tab may have been closed — call tab_unpin or tab_pin <new-id>.`);
    }
    return pinned;
  }

  // 2. Startup filter narrows the candidate set; empty = error.
  const tvPages = pages.filter(t => /tradingview\.com\/chart/i.test(t.url) || /tradingview/i.test(t.url));
  const candidates = activeFilter ? tvPages.filter(t => targetMatchesFilter(t, activeFilter)) : tvPages;
  if (activeFilter && candidates.length === 0) {
    throw new Error(`No TradingView tab matches filter ${activeFilter.field}${activeFilter.op}${activeFilter.value}. Open the tab or change TV_MCP_TARGET_FILTER.`);
  }

  // 3. Default: prefer /chart over generic TradingView pages.
  return candidates.find(t => /tradingview\.com\/chart/i.test(t.url))
    || candidates.find(t => /tradingview/i.test(t.url))
    || null;
}

export async function getTargetInfo() {
  if (_testOverrides?.getTargetInfo) return _testOverrides.getTargetInfo();
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  if (_testOverrides?.evaluate) return _testOverrides.evaluate(expression, opts);
  const c = await getClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  if (_testOverrides?.evaluateAsync) return _testOverrides.evaluateAsync(expression);
  
  const token = `__evaluateAsyncPromise_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  const wrappedExpression = `
    (function() {
      try {
        window.${token} = Promise.resolve().then(async () => {
          return ${expression}
          ;
        });
        window.${token}.finally(function() {
          setTimeout(function() {
            try { delete window.${token}; } catch(e) {}
          }, 1000);
        });
        return window.${token};
      } catch (e) {
        return Promise.reject(e);
      }
    })()
  `;
  return evaluate(wrappedExpression, { awaitPromise: true });
}

/**
 * Defensive evaluate that survives two CDP failure modes plain `evaluate`
 * doesn't handle:
 *
 *  1. **"Object reference chain is too long"** — CDP's `returnByValue:true`
 *     serializer walks the object graph. Rich page objects (Monaco editor
 *     refs, React fibers, chart-widget internals) blow past its depth limit
 *     and CDP rejects the whole call. Fix: serialize on the page side with
 *     `JSON.stringify` and ship a string instead — CDP only sees a flat
 *     primitive and is happy.
 *
 *  2. **Silent truncation** — CDP can quietly drop bytes from very large
 *     payloads (~1+ MB). We compute the string length on the page side and
 *     verify it round-trips intact on the client side; mismatch throws.
 *
 * Side benefits: cyclic / unserializable values fail fast on the page side
 * (page-side `JSON.stringify` throws with a clear message instead of CDP
 * returning a half-serialized blob); page-side exceptions are surfaced as
 * Error messages rather than half-formed objects.
 *
 * Use this in place of `evaluate()` whenever you're returning a value that
 * (a) walks any internal TV object graph (monaco, react fibers, chartWidget,
 * model, dataSources) or (b) may exceed a few hundred KB. For plain
 * primitives and small flat objects, `evaluate()` is fine and cheaper.
 *
 * @param expression  Same expression syntax as evaluate(). Must produce a
 *                    JSON-serializable value (or throw on the page side).
 * @param opts.label  Optional label for error messages (default 'evaluate').
 * @param opts.awaitPromise  Same semantics as evaluate().
 */
export async function evaluateChecked(expression, opts = {}) {
  if (_testOverrides?.evaluateChecked) return _testOverrides.evaluateChecked(expression, opts);
  const label = opts.label || 'evaluate';
  const wrapped = `(async function() {
    var __d;
    try { __d = await (${expression}); }
    catch (__e) { return { __err: 'page-side eval: ' + String(__e && __e.message || __e) }; }
    var __s;
    try { __s = JSON.stringify(__d); }
    catch (__e) { return { __err: 'page-side JSON.stringify: ' + String(__e && __e.message || __e) }; }
    if (__s === undefined) return { __s: 'undefined', __sz: 9, __isUndef: true };
    return { __s: __s, __sz: __s.length };
  })()`;
  // awaitPromise so a promise-returning expression is resolved page-side; the
  // async wrapper makes `await` of a plain value a no-op, so sync reads work too.
  const result = await evaluate(wrapped, { ...opts, awaitPromise: true });
  if (!result) throw new Error(`${label}: no result from page`);
  if (result.__err) throw new Error(`${label}: ${result.__err}`);
  if (result.__isUndef) return undefined;
  if (typeof result.__s !== 'string') throw new Error(`${label}: malformed wrapper response`);
  if (result.__s.length !== result.__sz) {
    throw new Error(`${label}: CDP truncated response (page-side ${result.__sz} bytes, client-side ${result.__s.length} bytes)`);
  }
  try { return JSON.parse(result.__s); }
  catch (e) { throw new Error(`${label}: client-side JSON.parse failed: ${e.message}`); }
}

export async function disconnect() {
  if (!client) return;
  // Send disable defensively before closing the WebSocket. Even though we
  // never enable these domains ourselves, a TV-side V8 inspector with
  // implicit forwarding will stop sending late console events that would
  // hit a half-closed socket and trigger EPIPE on TV's renderer at exit.
  // disable on a not-enabled domain is a no-op.
  try {
    await Promise.allSettled([
      client.Runtime?.disable?.(),
      client.Page?.disable?.(),
      client.DOM?.disable?.(),
      client.Console?.disable?.(),
      client.Log?.disable?.(),
      client.Inspector?.disable?.(),
    ]);
  } catch { /* best effort */ }
  try { await client.close(); } catch { /* ignore */ }
  // chrome-remote-interface's close() resolves when the close frame was
  // sent, not when the peer ack'd it. Give the socket time to flush so TV
  // sees a clean teardown before our process exits.
  await new Promise((r) => setTimeout(r, 250));
  client = null;
  targetInfo = null;
}

export async function connectToTarget(targetId) {
  await disconnect();
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
      // No domain enables — see connect() for the EPIPE-on-TV-close rationale.
      client.on('disconnect', () => { client = null; targetInfo = null; });
      // Re-apply per-target focus emulation. See connect() for rationale.
      try { await client.Emulation.setFocusEmulationEnabled({ enabled: true }); } catch {}
      targetInfo = { id: targetId };
      return client;
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connect to target ${targetId} failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  if (_testOverrides?.getChartApi) return _testOverrides.getChartApi();
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  if (_testOverrides?.getChartCollection) return _testOverrides.getChartCollection();
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  if (_testOverrides?.getBottomBar) return _testOverrides.getBottomBar();
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  if (_testOverrides?.getReplayApi) return _testOverrides.getReplayApi();
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getReplayUIController() {
  if (_testOverrides?.getReplayUIController) return _testOverrides.getReplayUIController();
  return verifyAndReturn(KNOWN_PATHS.replayApi + '._replayUIController', 'Replay UI Controller');
}

export async function getMainSeriesBars() {
  if (_testOverrides?.getMainSeriesBars) return _testOverrides.getMainSeriesBars();
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
