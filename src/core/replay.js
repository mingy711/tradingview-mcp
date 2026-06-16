/**
 * Core replay mode logic.
 */
import { evaluate as _evaluate, getReplayApi as _getReplayApi, getReplayUIController as _getReplayUIController, getClient as _getClient, safeString } from '../connection.js';
import { dismissBlockingDialogs } from './dialog.js';

export const VALID_AUTOPLAY_DELAYS = [100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000];

const REPLAY_RESOLUTION_LABELS = {
  '1T': '1 tick', '1S': '1 second',
  '1': '1 min', '3': '3 min', '5': '5 min', '10': '10 min', '15': '15 min', '30': '30 min',
  '1H': '1 hour', '2H': '2 hours', '3H': '3 hours', '4H': '4 hours',
  '1D': '1 day', auto: 'auto',
};

function wv(path) {
  return `(function(){ var v = ${path}; return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; })()`;
}

function resolveLabel(current, auto) {
  if (current === null) return `auto (${REPLAY_RESOLUTION_LABELS[auto] || auto})`;
  return REPLAY_RESOLUTION_LABELS[current] || current;
}

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    getReplayApi: deps?.getReplayApi || _getReplayApi,
    getReplayUIController: deps?.getReplayUIController || _getReplayUIController,
    getClient: deps?.getClient || _getClient,
  };
}

/**
 * Force TV to load historical bars backward so the buffer covers `targetTs`.
 *
 * TV's chart only fetches more historical bars when the user (or code)
 * scrolls past the current first loaded bar — there's no "fetch up to date X"
 * API. Once we engage replay (showReplayToolbar/selectDate), the data feed
 * is frozen and no further backward loads happen. So this must run BEFORE
 * selectDate; the caller pre-extends the buffer, then engages replay.
 *
 * Mechanism: dispatch synthesized mouseWheel events at the main chart pane
 * canvas. Each batch of wheel events loads a chunk of older bars (server
 * decides chunk size; typically 50-200 bars per batch on intraday TFs).
 * We loop until the buffer's first bar timestamp is ≤ targetTs, OR we hit
 * `maxAttempts`, OR two consecutive attempts make no progress (TV has run
 * out of history on this symbol/TF).
 *
 * Returns { loaded, attempts, firstTsBefore, firstTsAfter, reason }.
 */
async function _scrollBackToTarget(targetTs, _deps, opts = {}) {
  const { evaluate, getClient } = _resolve(_deps);
  const maxAttempts = opts.maxAttempts ?? 30;
  const wheelsPerAttempt = opts.wheelsPerAttempt ?? 40;
  const settleMs = opts.settleMs ?? 1200;

  const client = await getClient();

  async function readFirstTs() {
    return await evaluate(`(function() {
      try {
        var bars = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
        var v = bars.valueAt(bars.firstIndex());
        return v ? Number(v[0]) : null;
      } catch(e) { return null; }
    })()`);
  }

  async function readPaneRect() {
    return await evaluate(`(function() {
      // Prefer the canvas of the ACTIVE chart widget (multi-chart layouts
      // make "largest visible" unreliable). Fall back to largest visible
      // pane-canvas if widget DOM traversal fails.
      function fromActive() {
        try {
          var w = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
          var panes = (typeof w.paneWidgets === 'function') ? w.paneWidgets() : null;
          var container = (panes && panes[0] && panes[0].getElement) ? panes[0].getElement() : null;
          if (!container) return null;
          var c = container.querySelector('canvas[data-name="pane-canvas"]');
          return c || null;
        } catch(e) { return null; }
      }
      function fromLargest() {
        var list = Array.prototype.filter.call(
          document.querySelectorAll('canvas[data-name="pane-canvas"]'),
          function(c) { return c.offsetParent !== null; }
        );
        if (list.length === 0) return null;
        list.sort(function(a, b) {
          var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return (rb.width * rb.height) - (ra.width * ra.height);
        });
        return list[0];
      }
      var canvas = fromActive() || fromLargest();
      if (!canvas) return null;
      var r = canvas.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, dpr: window.devicePixelRatio || 1 };
    })()`);
  }

  const firstTsBefore = await readFirstTs();
  const targetSec = Math.floor(targetTs / 1000);

  if (firstTsBefore === null) {
    return { loaded: false, attempts: 0, firstTsBefore, firstTsAfter: null, reason: 'no_chart_data' };
  }
  if (firstTsBefore <= targetSec) {
    return { loaded: true, attempts: 0, firstTsBefore, firstTsAfter: firstTsBefore, reason: 'already_covered' };
  }

  let currentFirst = firstTsBefore;
  let consecutiveNoProgress = 0;
  let attempts = 0;

  for (let i = 0; i < maxAttempts; i++) {
    attempts++;
    const pane = await readPaneRect();
    if (!pane) {
      return { loaded: false, attempts, firstTsBefore, firstTsAfter: currentFirst, reason: 'no_canvas' };
    }
    const cx = (pane.x + pane.w / 2) * pane.dpr;
    const cy = (pane.y + pane.h / 2) * pane.dpr;

    for (let w = 0; w < wheelsPerAttempt; w++) {
      await client.Input.dispatchMouseEvent({
        type: 'mouseWheel', x: cx, y: cy,
        deltaX: -120, deltaY: 0, button: 'none',
      });
      await new Promise(r => setTimeout(r, 25));
    }
    await new Promise(r => setTimeout(r, settleMs));

    const newFirst = await readFirstTs();
    if (newFirst === null) {
      return { loaded: false, attempts, firstTsBefore, firstTsAfter: currentFirst, reason: 'data_unreadable' };
    }
    if (newFirst >= currentFirst) {
      consecutiveNoProgress++;
      if (consecutiveNoProgress >= 2) {
        return {
          loaded: newFirst <= targetSec, attempts,
          firstTsBefore, firstTsAfter: newFirst,
          reason: 'no_more_history',
        };
      }
    } else {
      consecutiveNoProgress = 0;
    }
    currentFirst = newFirst;
    if (currentFirst <= targetSec) {
      return { loaded: true, attempts, firstTsBefore, firstTsAfter: currentFirst, reason: 'reached_target' };
    }
  }

  return {
    loaded: currentFirst <= targetSec, attempts,
    firstTsBefore, firstTsAfter: currentFirst,
    reason: 'max_attempts',
  };
}

export async function start({ date, scrollBack, _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const available = await evaluate(wv(`${rp}.isReplayAvailable()`));
  if (!available) throw new Error('Replay is not available for the current symbol/timeframe');

  // Parse the date BEFORE clearing state, so a bad string doesn't strand
  // TV with a half-cleared replay session. `new Date(str).getTime()`
  // accepts both day-precision ("2026-05-08") and ISO-with-time
  // ("2026-05-08T09:33:00-04:00", "2026-05-08T13:33:00Z"). For intraday
  // targets (e.g., a specific bar at NY market open), the offset suffix
  // is required — bare "YYYY-MM-DD" is parsed as midnight UTC.
  let ts = null;
  if (date) {
    ts = new Date(date).getTime();
    if (isNaN(ts)) {
      throw new Error(
        `Invalid date: "${date}". Accepted formats: YYYY-MM-DD (lands at midnight UTC), ` +
        `YYYY-MM-DDTHH:MM:SS[+-]HH:MM (intraday with offset), or YYYY-MM-DDTHH:MM:SSZ (UTC).`
      );
    }
  }

  // If replay is already running, TV's selectDate is silently absorbed —
  // the cursor stays at the cached position even with _replaySessionState
  // nulled. Tear down the live session first (stopReplay + state clear),
  // then engage selectDate cleanly. The 'AllCharts' replay mode + linking
  // copy both need the reset; missing either leaves the cursor pinned.
  const alreadyStarted = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (alreadyStarted && ts !== null) {
    await evaluate(`
      (function() {
        var api = window.TradingViewApi && window.TradingViewApi._replayApi;
        if (api) { try { api.stopReplay(); } catch(e) {} }
      })()
    `);
    await evaluate(CLEAR_SESSION_STATE_JS);
    // Brief pause to let TV's replay engine settle the teardown before
    // we re-enter via showReplayToolbar + selectDate. Without this,
    // selectDate occasionally races the stopReplay callback and lands
    // on the pre-teardown cursor.
    await new Promise(r => setTimeout(r, 300));
  } else {
    // Cold start (or re-call without a date) — just nuke any cached state
    // so a "Continue your last replay?" dialog doesn't fight us.
    await evaluate(CLEAR_SESSION_STATE_JS);
  }

  // Pre-extend the bar buffer if requested. Must happen BEFORE
  // showReplayToolbar — once replay is engaged, the data feed freezes
  // and backward scrolls no longer trigger historical loads. See
  // _scrollBackToTarget for mechanism details.
  let scrollBackInfo = null;
  if (scrollBack && ts !== null) {
    scrollBackInfo = await _scrollBackToTarget(ts, _deps);
  }

  await evaluate(`${rp}.showReplayToolbar()`);

  // selectDate() is async — it calls enableReplayMode() then _onPointSelected()
  // which initializes the server-side replay session. Must be awaited inside the
  // page context, otherwise the promise is fire-and-forget and replay state says
  // "started" but stepping doesn't work (issue #26).
  if (ts !== null) {
    await evaluate(`${rp}.selectDate(${ts}).then(function() { return 'ok'; })`);
  } else {
    await evaluate(`${rp}.selectFirstAvailableDate()`);
  }

  // Poll until replay is fully initialized AND the cursor reflects the
  // requested target. selectDate()'s promise resolves before the data
  // series is ready. When re-jumping, currentDate is non-null immediately
  // (carrying the previous session's value), so a plain "non-null" exit
  // returns a stale cursor. With a target ts, wait until the cursor lands
  // within one minute of the target (covers the bar-snap quantization).
  // Without a target, wait for any non-null value.
  let started = false;
  let currentDate = null;
  const tsSec = ts !== null ? Math.floor(ts / 1000) : null;
  // 60s match window is intentionally tight — bar-snap quantization on
  // any reasonable timeframe stays under this. Wider would mask the
  // silent-clamp bug we just fixed.
  const targetMatchSec = 60;
  for (let i = 0; i < 40; i++) {
    started = await evaluate(wv(`${rp}.isReplayStarted()`));
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (started && currentDate !== null) {
      if (tsSec === null) break;
      if (Math.abs(currentDate - tsSec) <= targetMatchSec) break;
    }
    await new Promise(r => setTimeout(r, 250));
  }

  if (!started) {
    try { await evaluate(`${rp}.stopReplay()`); } catch {}
    throw new Error('Replay failed to start. The selected date may not have data for this timeframe. Try a more recent date or a higher timeframe (e.g., Daily).');
  }

  // Verify the cursor landed near the requested target. TV's selectDate
  // silently clamps backward jumps when the target date isn't in the
  // currently loaded bar buffer — the cursor stays at the previously-loaded
  // last bar instead of fetching the older data. We can't fix this from
  // CDP (no API to force a backward load), but we can surface it so the
  // caller knows the jump didn't reach the target.
  let driftSeconds = null;
  let warning = null;
  if (ts !== null && currentDate !== null) {
    driftSeconds = Math.abs(currentDate - Math.floor(ts / 1000));
    // 5 min tolerance — enough for the cursor to snap to the bar containing
    // the requested instant (e.g., 1m chart: cursor lands at bar open,
    // up to 60s earlier; 5m chart: up to 300s earlier). Anything beyond
    // that almost certainly means TV silently clamped to the previous
    // cursor or the requested time fell outside the loaded buffer.
    if (driftSeconds > 300) {
      const wanted = new Date(ts).toISOString();
      const got = new Date(currentDate * 1000).toISOString();
      warning = (
        `Cursor landed at ${got} but you requested ${wanted} ` +
        `(drift: ${driftSeconds}s). TV may have silently clamped a backward jump ` +
        `to unloaded historical data, or the requested date falls outside the ` +
        `current bar buffer. Try scrolling the chart back manually first, or use ` +
        `a higher timeframe to load more history.`
      );
    }
  }

  return {
    success: true,
    replay_started: true,
    date: date || '(first available)',
    current_date: currentDate,
    requested_ts: ts ? Math.floor(ts / 1000) : null,
    drift_seconds: driftSeconds,
    warning,
    scroll_back: scrollBackInfo,
  };
}

export async function step({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  const before = await evaluate(wv(`${rp}.currentDate()`));
  await evaluate(`${rp}.doStep()`);
  // doStep() is async internally — currentDate takes ~500ms to update.
  // Poll until it changes or timeout after 3s.
  let currentDate = before;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 250));
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (currentDate !== before) break;
  }
  return { success: true, action: 'step', current_date: currentDate };
}

export async function autoplay({ speed, _deps } = {}) {
  // Validate BEFORE any CDP calls — invalid values corrupt cloud account state permanently
  if (speed > 0 && !VALID_AUTOPLAY_DELAYS.includes(speed))
    throw new Error(`Invalid autoplay delay ${speed}ms. Valid values: ${VALID_AUTOPLAY_DELAYS.join(', ')}`);

  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  const wasAutoplay = await evaluate(wv(`${rp}.isAutoplayStarted()`));
  if (speed > 0) {
    // Adjust speed and ensure autoplay is ON. toggleAutoplay() flips state,
    // so only toggle when it isn't already running — otherwise passing a
    // speed to a running autoplay would stop it.
    await evaluate(`${rp}.changeAutoplayDelay(${speed})`);
    if (!wasAutoplay) await evaluate(`${rp}.toggleAutoplay()`);
  } else {
    // No speed → plain toggle (start if stopped, pause if running).
    await evaluate(`${rp}.toggleAutoplay()`);
  }
  const isAutoplay = await evaluate(wv(`${rp}.isAutoplayStarted()`));
  const currentDelay = await evaluate(wv(`${rp}.autoplayDelay()`));
  return { success: true, autoplay_active: !!isAutoplay, delay_ms: currentDelay };
}

// Wipes TV's saved-replay-state holders. Idempotent — the state may be null
// already, may be populated from a prior session, or may be re-populated by
// TV's internal callbacks. We always set it to null because the only path to
// avoid 'Continue your last replay?' on next restart is empty state at exit.
// On TV 3.1, the cached session state lives at two paths: the top-level
// _chartWidgetCollection AND the linking namespace at
// chartWidget._linking._chartWidgetCollection. The linking copy is what
// survives a TV process restart, so nulling only the top-level leaves the
// 'Continue your last replay?' dialog primed for the next launch.
const CLEAR_SESSION_STATE_JS = `
  (function() {
    try {
      var col = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
      if (col) col._replaySessionState = null;
      var linking = window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV
        && window.TradingViewApi._activeChartWidgetWV.value()
        && window.TradingViewApi._activeChartWidgetWV.value()._chartWidget
        && window.TradingViewApi._activeChartWidgetWV.value()._chartWidget._linking;
      if (linking && linking._chartWidgetCollection) linking._chartWidgetCollection._replaySessionState = null;
    } catch(e) {}
  })()
`;

export async function stop({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) {
    // Already stopped, but TV may still have saved state set from before
    // (e.g. when this run inherited state from a prior session). Wipe it
    // and dismiss any lingering 'Leave current replay?' dialog.
    await evaluate(CLEAR_SESSION_STATE_JS);
    const dismissed = await dismissBlockingDialogs({ evaluate });
    return { success: true, action: 'already_stopped', dismissed_dialogs: dismissed };
  }
  // TV 3.1.0 needs both stopReplay and goToRealtime to fully exit replay
  // and clear the saved-replay state that triggers a 'Leave current replay?'
  // dialog on subsequent setSymbol/setResolution. Run both inside one IIFE
  // with try/catch — TV's replay engine sometimes treats them as a sequence
  // (stopReplay runs, goToRealtime throws 'Replay is not started' because
  // the engine already cleaned up). Both succeeding-and-no-opping is fine,
  // both running cleanly is fine, only one running is fine. The combined
  // effect is what matters: by the time this returns, replay is off and
  // saved state is cleared.
  await evaluate(`
    (function() {
      var api = window.TradingViewApi && window.TradingViewApi._replayApi;
      if (api) {
        try { api.stopReplay(); } catch(e) {}
        try { api.goToRealtime(); } catch(e) {}
      }
    })()
  `);
  await evaluate(CLEAR_SESSION_STATE_JS);
  const dismissed = await dismissBlockingDialogs({ evaluate });
  return { success: true, action: 'replay_stopped', dismissed_dialogs: dismissed };
}

export async function trade({ action, _deps }) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');

  if (action === 'buy') await evaluate(`${rp}.buy()`);
  else if (action === 'sell') await evaluate(`${rp}.sell()`);
  else if (action === 'close') await evaluate(`${rp}.closePosition()`);
  else throw new Error('Invalid action. Use: buy, sell, or close');

  const position = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, action, position, realized_pnl: pnl };
}

export async function setResolution({ interval, _deps } = {}) {
  // Resolve "auto" or empty to null (TV's internal representation).
  const value = (!interval || interval === 'auto') ? null : interval;
  const { evaluate, getReplayApi, getReplayUIController } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');

  const ctrl = await getReplayUIController();

  // Valid resolutions are dynamic per chart timeframe. Validate BEFORE the
  // change call to prevent cloud state corruption from invalid values.
  const available = await evaluate(wv(`${ctrl}._allReplayResolutions.value()`));
  if (!Array.isArray(available)) {
    throw new Error('Could not retrieve available replay resolutions from TradingView.');
  }
  if (value !== null && !available.includes(value)) {
    throw new Error(`Invalid replay resolution "${interval}". Available for current timeframe: ${available.join(', ')}, auto. Note: 1T and 1S may require a paid TradingView plan.`);
  }

  await evaluate(`${ctrl}.changeReplayResolution(${value === null ? 'null' : safeString(value)})`);

  const current = await evaluate(wv(`${ctrl}._currentReplayResolution.value()`));
  const auto = await evaluate(wv(`${ctrl}._autoReplayResolution.value()`));
  return { success: true, resolution: current, resolution_label: resolveLabel(current, auto), auto_resolution: auto };
}

export async function status({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const st = await evaluate(`
    (function() {
      var r = ${rp};
      function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
      return {
        is_replay_available: unwrap(r.isReplayAvailable()),
        is_replay_started: unwrap(r.isReplayStarted()),
        is_autoplay_started: unwrap(r.isAutoplayStarted()),
        replay_mode: unwrap(r.replayMode()),
        current_date: unwrap(r.currentDate()),
        autoplay_delay: unwrap(r.autoplayDelay()),
      };
    })()
  `);
  const pos = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, ...st, position: pos, realized_pnl: pnl };
}
