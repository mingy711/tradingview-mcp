import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
const CDP_HOST = process.env.TV_CDP_HOST || 'localhost';
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
      await Promise.race([
        client.Runtime.evaluate({ expression: '1', returnByValue: true }),
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

export async function connect() {
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

async function findChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  // Prefer targets with tradingview.com/chart in the URL
  return targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url))
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
  return evaluate(expression, { awaitPromise: true });
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
