/**
 * Core chart control logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, safeString, requireFinite, getClient as _getClient, disconnect as _disconnect } from '../connection.js';
import { waitForChartReady as _waitForChartReady, waitForStudiesReady as _waitForStudiesReady } from '../wait.js';
import { dismissBlockingDialogs as _dismissBlockingDialogs } from './dialog.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    waitForChartReady: deps?.waitForChartReady || _waitForChartReady,
    waitForStudiesReady: deps?.waitForStudiesReady || _waitForStudiesReady,
    dismissBlockingDialogs: deps?.dismissBlockingDialogs || _dismissBlockingDialogs,
    getClient: deps?.getClient || _getClient,
    disconnect: deps?.disconnect || _disconnect,
  };
}

// Hard reload the TradingView tab. Last-resort recovery when setSymbol is
// stuck in a state that dialog dismissal can't break (cumulative replay
// side effects, half-applied symbol switches). Wipes all studies, drawings,
// and replay state — caller must re-add studies after this returns.
// Mirrors the pattern in core/health.js reconnect().
async function _hardReload({ getClient, disconnect, waitForChartReady }) {
  const c = await getClient();
  try { await c.Page.reload({ ignoreCache: false }); }
  catch { /* reload can drop the CDP WS — expected */ }
  await disconnect();
  // TV needs ~3s after reload before its CDP target re-accepts attaches;
  // a tighter wait races the renderer and surfaces as a connect retry storm.
  await new Promise(r => setTimeout(r, 3000));
  await getClient();
  // 20s ceiling — TV with many studies + a slow data feed can take >10s
  // to repaint after reload. waitForChartReady polls until the loading
  // spinner clears and bar count stabilizes.
  return await waitForChartReady(null, null, 20000);
}

/**
 * Compare a requested symbol against the actual chart symbol. TV resolves
 * 'AAPL' to 'NASDAQ:AAPL' or 'BATS:AAPL' depending on availability, so we
 * accept any actual that matches case-insensitively after stripping the
 * exchange prefix on either side.
 */
function _symbolMatches(requested, actual) {
  if (!actual) return false;
  const norm = (s) => String(s).split(':').pop().toUpperCase();
  return norm(actual) === norm(requested);
}

export async function getState({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const state = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var studies = [];
      try {
        var allStudies = chart.getAllStudies();
        studies = allStudies.map(function(s) {
          return { id: s.id, name: s.name || s.title || 'unknown' };
        });
      } catch(e) {}
      return {
        symbol: chart.symbol(),
        resolution: chart.resolution(),
        chartType: chart.chartType(),
        studies: studies,
      };
    })()
  `);
  return { success: true, ...state };
}

export async function setSymbol({ symbol, _deps }) {
  const { evaluate, evaluateAsync, waitForChartReady, waitForStudiesReady, dismissBlockingDialogs, getClient, disconnect } = _resolve(_deps);

  // Trigger the symbol switch; don't gate on DOM readiness here.
  // `waitForChartReady` does a DOM-legend substring match that fails when
  // the caller passes a prefixed symbol ("CME_MINI:NQU2026") while the
  // legend shows the bare form ("NQU2026") — surfaced as a false stuck
  // state on the first attempt. Authoritative check is the JS API
  // chart.symbol() poll below.
  async function _doSetSymbol() {
    await evaluateAsync(`
      (function() {
        var chart = ${CHART_API};
        return new Promise(function(resolve) {
          chart.setSymbol(${safeString(symbol)}, {});
          setTimeout(resolve, 500);
        });
      })()
    `);
  }

  // Poll chart.symbol() until it matches the requested symbol (with the
  // exchange-prefix normalization rules from _symbolMatches) or the
  // timeout elapses. Returns the final actual value either way.
  async function _waitForSymbolMatch(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let actual = await evaluate(`${CHART_API}.symbol()`);
    while (!_symbolMatches(symbol, actual) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 250));
      actual = await evaluate(`${CHART_API}.symbol()`);
    }
    return actual;
  }

  // Detect the "This symbol doesn't exist" / "No data here" overlay that
  // TV draws when the chart's data fetch failed but the JS API still
  // reports the requested symbol — chart.symbol() matches, yet the user
  // sees a broken chart. Bounded text scan (length-capped, narrow
  // selectors first) keeps it cheap. Returns the matched message or null.
  async function _detectSymbolErrorOverlay() {
    try {
      return await evaluate(`
        (function() {
          var patterns = [
            /This symbol doesn'?t exist/i,
            /Symbol not found/i,
            /No data (here|available for this symbol)/i,
            /Invalid symbol/i,
          ];
          // Narrow: TV's no-data overlay sits in the chart canvas area
          // under classes like "errorCard"/"noDataHere"/"emptyState". A
          // wider scan would flood with editor and tooltip text.
          var candidates = document.querySelectorAll(
            '[class*="errorCard"], [class*="noDataHere"], [class*="emptyState"], ' +
            '[class*="error-message"], [class*="errorMessage"], [class*="noData"]'
          );
          for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            if (el.offsetParent === null) continue;
            var text = el.textContent || '';
            if (text.length > 400) continue;
            for (var p = 0; p < patterns.length; p++) {
              if (patterns[p].test(text)) return text.trim().slice(0, 200);
            }
          }
          return null;
        })()
      `);
    } catch { return null; }
  }

  // Capture pre-switch state — if we end up hard-reloading, the caller
  // needs to know what was wiped to restore studies.
  let priorStudies = [];
  try {
    priorStudies = await evaluate(`
      (function() {
        try {
          var chart = ${CHART_API};
          return (chart.getAllStudies() || []).map(function(s) {
            return { id: s.id, name: s.name || s.title || 'unknown' };
          });
        } catch(e) { return []; }
      })()
    `) || [];
  } catch { /* best effort */ }

  // "Healthy load" = JS API matches AND no error overlay is visible. The
  // overlay case is the stuck state where chart.symbol() returns the
  // requested value but TV's data fetch failed — IDEAS line 92-101.
  async function _checkHealthy(timeoutMs) {
    const actualNow = await _waitForSymbolMatch(timeoutMs);
    const overlay = _symbolMatches(symbol, actualNow) ? await _detectSymbolErrorOverlay() : null;
    return { actual: actualNow, overlay };
  }

  // First attempt — 8s window covers a typical cold contract-data fetch.
  await _doSetSymbol();
  let { actual, overlay: errorOverlay } = await _checkHealthy(8000);
  let dismissedDialogs = [];
  let hardReloaded = false;

  // If the JS API didn't reflect the change, TV likely popped a blocking
  // modal (Leave current replay / Continue your last replay / Save script
  // / unsaved changes) that absorbed the change request. Dismiss whatever's
  // open and retry once. (An error overlay alone — JS API already matches —
  // skips this step because dismissing a dialog won't refetch the chart
  // data; hard reload is the only recovery for that case.)
  if (!_symbolMatches(symbol, actual)) {
    try { dismissedDialogs = await dismissBlockingDialogs({ evaluate }); } catch {}
    await _doSetSymbol();
    ({ actual, overlay: errorOverlay } = await _checkHealthy(8000));
  }

  // Last-resort: hard reload. Triggers on either (a) JS API still wrong,
  // or (b) JS API matches but chart shows the error overlay. Page.reload
  // is the only path that consistently breaks both stuck states. Wipes
  // studies and replay state — caller is told via hard_reloaded:true.
  if (!_symbolMatches(symbol, actual) || errorOverlay) {
    try {
      await _hardReload({ getClient, disconnect, waitForChartReady });
      hardReloaded = true;
      await _doSetSymbol();
      ({ actual, overlay: errorOverlay } = await _checkHealthy(12000)); // post-reload TV is slower
    } catch (reloadErr) {
      const err = new Error(
        `setSymbol failed: requested "${symbol}" but chart symbol is "${actual}"` +
        (errorOverlay ? ` (chart shows error: "${errorOverlay}")` : '') +
        `. Hard reload also failed: ${reloadErr.message}.`
      );
      err.code = 'SYMBOL_DID_NOT_CHANGE';
      err.requested = symbol;
      err.actual = actual;
      err.dismissed_dialogs = dismissedDialogs;
      err.error_overlay = errorOverlay;
      err.hard_reload_attempted = true;
      throw err;
    }
  }

  if (!_symbolMatches(symbol, actual) || errorOverlay) {
    const err = new Error(
      `setSymbol failed: requested "${symbol}" but chart symbol is "${actual}"` +
      (errorOverlay ? ` (chart shows error: "${errorOverlay}")` : '') +
      ` even after dialog dismissal${hardReloaded ? ' and hard reload' : ''}. ` +
      `TV may be unresponsive — try tv_health_check.`
    );
    err.code = errorOverlay ? 'SYMBOL_LOAD_ERROR' : 'SYMBOL_DID_NOT_CHANGE';
    err.requested = symbol;
    err.actual = actual;
    err.dismissed_dialogs = dismissedDialogs;
    err.error_overlay = errorOverlay;
    err.hard_reloaded = hardReloaded;
    throw err;
  }

  // Best-effort DOM settle for callers about to scrape the legend/studies.
  // Not gating — chart.symbol() already confirmed the switch landed.
  const ready = await waitForChartReady(symbol);
  const studies_ready = await waitForStudiesReady();

  // After a hard reload, user-saved Pine studies often stay "inert" — TV
  // restores their layout reference (id, inputs, scriptIdPart `USER;<hash>`)
  // but never re-fetches the source from pine-facade, so the study runs
  // forever with `isRestarting:true` and produces zero output. Callers
  // about to read drawing data (data_get_pine_lines etc.) will see empty
  // results; surface the inert studies so they know to re-add via Pine
  // editor instead of debugging the read path.
  let inertStudies;
  if (hardReloaded) {
    try {
      const probe = await evaluate(`
        (function() {
          try {
            var chart = ${CHART_API}._chartWidget;
            var sources = chart.model().model().dataSources();
            var inert = [];
            for (var i = 0; i < sources.length; i++) {
              var s = sources[i];
              if (!s.metaInfo) continue;
              var meta;
              try { meta = s.metaInfo(); } catch(e) { continue; }
              if (!meta || !meta.isTVScript) continue;
              // No bar-index entries = study never executed against the
              // main series. This is the only reliable inertness signal —
              // meta.pine.source is null even for working Pine studies
              // on TV 3.1 (verified empirically; TV doesn't expose the
              // compiled source client-side), so checking !sourcePresent
              // produces false positives on healthy studies.
              var idxCount = (s._graphics && s._graphics._indexes) ? s._graphics._indexes.length : 0;
              if (idxCount === 0) {
                inert.push({
                  id: typeof s.id === 'function' ? s.id() : (s.id || null),
                  name: meta.description || meta.shortDescription || 'unknown',
                  scriptIdPart: meta.scriptIdPart || null,
                  indexes_count: idxCount,
                });
              }
            }
            return inert;
          } catch(e) { return null; }
        })()
      `);
      if (Array.isArray(probe) && probe.length > 0) inertStudies = probe;
    } catch { /* best effort */ }
  }

  return {
    success: true,
    symbol: actual,
    requested: symbol,
    chart_ready: ready,
    studies_ready,
    dismissed_dialogs: dismissedDialogs.length ? dismissedDialogs : undefined,
    hard_reloaded: hardReloaded || undefined,
    prior_studies: hardReloaded ? priorStudies : undefined,
    inert_studies: inertStudies,
    inert_studies_hint: inertStudies
      ? 'TV restored these user-saved Pine studies from layout but did not refetch their source. Re-add them via the Pine editor (open the script, click "Add to chart") to make them compute again.'
      : undefined,
  };
}

export async function setTimeframe({ timeframe, _deps }) {
  const { evaluate, waitForChartReady, waitForStudiesReady } = _resolve(_deps);
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setResolution(${safeString(timeframe)}, {});
    })()
  `);
  const ready = await waitForChartReady(null, timeframe);
  const studies_ready = await waitForStudiesReady();
  return { success: true, timeframe, chart_ready: ready, studies_ready };
}

export async function setType({ chart_type, _deps }) {
  const { evaluate } = _resolve(_deps);
  const typeMap = {
    'Bars': 0, 'Candles': 1, 'Line': 2, 'Area': 3,
    'Renko': 4, 'Kagi': 5, 'PointAndFigure': 6, 'LineBreak': 7,
    'HeikinAshi': 8, 'HollowCandles': 9,
  };
  const typeNum = typeMap[chart_type] ?? Number(chart_type);
  if (isNaN(typeNum) || typeNum < 0 || typeNum > 9 || !Number.isInteger(typeNum)) {
    throw new Error(`Unknown chart type: ${chart_type}. Use a name (Candles, Line, etc.) or number (0-9).`);
  }
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setChartType(${typeNum});
    })()
  `);
  return { success: true, chart_type, type_num: typeNum };
}

export async function manageIndicator({ action, indicator, entity_id, inputs: inputsRaw, _deps }) {
  const { evaluate } = _resolve(_deps);
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;

  if (action === 'add') {
    const inputArr = inputs ? Object.entries(inputs).map(([k, v]) => ({ id: k, value: v })) : [];
    const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.createStudy(${safeString(indicator)}, false, false, ${JSON.stringify(inputArr)});
      })()
    `);
    await new Promise(r => setTimeout(r, 1500));
    const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    const newIds = (after || []).filter(id => !(before || []).includes(id));
    return { success: newIds.length > 0, action: 'add', indicator, entity_id: newIds[0] || null, new_study_count: newIds.length };
  } else if (action === 'remove') {
    if (!entity_id) throw new Error('entity_id required for remove action. Use chart_get_state to find study IDs.');
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.removeEntity(${safeString(entity_id)});
      })()
    `);
    return { success: true, action: 'remove', entity_id };
  } else {
    throw new Error('action must be "add" or "remove"');
  }
}

export async function removeStudiesByTitle({ title_match, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  if (!title_match || typeof title_match !== 'string') {
    throw new Error('title_match required (case-insensitive substring of study name)');
  }
  const result = await evaluate(`
    (function() {
      var target = ${safeString(title_match.toLowerCase())};
      var chart = ${CHART_API};
      var studies = (typeof chart.getAllStudies === 'function') ? (chart.getAllStudies() || []) : [];
      var matched = [];
      var removed = [];
      for (var i = 0; i < studies.length; i++) {
        var s = studies[i];
        var name = (s && s.name) ? String(s.name) : '';
        if (name.toLowerCase().indexOf(target) !== -1) {
          matched.push({ id: s.id, name: name });
          try {
            chart.removeEntity(s.id);
            removed.push({ id: s.id, name: name });
          } catch (e) { /* keep in matched but not removed */ }
        }
      }
      return { matched: matched, removed: removed };
    })()
  `);
  return {
    success: result.removed.length === result.matched.length,
    title_match,
    matched: result.matched,
    removed: result.removed,
  };
}

export async function getVisibleRange({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      return { visible_range: chart.getVisibleRange(), bars_range: chart.getVisibleBarsRange() };
    })()
  `);
  return { success: true, visible_range: result.visible_range, bars_range: result.bars_range };
}

export async function setVisibleRange({ from, to, _deps }) {
  const { evaluate } = _resolve(_deps);
  const f = requireFinite(from, 'from');
  const t = requireFinite(to, 'to');
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${f} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${t}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  const actual = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      try { var r = chart.getVisibleRange(); return { from: r.from || 0, to: r.to || 0 }; }
      catch(e) { return { from: 0, to: 0, error: e.message }; }
    })()
  `);
  return { success: true, requested: { from, to }, actual: actual || { from: 0, to: 0 } };
}

export async function scrollToDate({ date, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  let timestamp;
  if (/^\d+$/.test(date)) timestamp = Number(date);
  else timestamp = Math.floor(new Date(date).getTime() / 1000);
  if (isNaN(timestamp)) throw new Error(`Could not parse date: ${date}. Use ISO format (2024-01-15) or unix timestamp.`);

  const resolution = await evaluate(`${CHART_API}.resolution()`);
  let secsPerBar = 60;
  const res = String(resolution);
  if (res === 'D' || res === '1D') secsPerBar = 86400;
  else if (res === 'W' || res === '1W') secsPerBar = 604800;
  else if (res === 'M' || res === '1M') secsPerBar = 2592000;
  else { const mins = parseInt(res, 10); if (!isNaN(mins)) secsPerBar = mins * 60; }

  const halfWindow = 25 * secsPerBar;
  const from = timestamp - halfWindow;
  const to = timestamp + halfWindow;

  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${to}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  return { success: true, date, centered_on: timestamp, resolution, window: { from, to } };
}

export async function symbolInfo({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      // TV Desktop 3.1.0 removed chart.symbolExt(); fall back to symbolInfo()
      // (returns full info object), then symbol() as a last resort.
      var info = null;
      try { if (typeof chart.symbolExt === 'function') info = chart.symbolExt(); } catch(e) {}
      if (!info) {
        try { if (typeof chart.symbolInfo === 'function') info = chart.symbolInfo(); } catch(e) {}
      }
      var symbol = '';
      try { symbol = chart.symbol(); } catch(e) {}
      var resolution = '';
      try { resolution = chart.resolution(); } catch(e) {}
      var chart_type = null;
      try { chart_type = chart.chartType(); } catch(e) {}
      if (info) {
        return {
          symbol: info.symbol || symbol,
          full_name: info.full_name || info.fullName,
          exchange: info.exchange,
          description: info.description,
          type: info.type,
          pro_name: info.pro_name || info.proName,
          typespecs: info.typespecs,
          resolution: resolution,
          chart_type: chart_type,
          source: 'symbolExt_or_symbolInfo'
        };
      }
      // Minimal fallback — only the symbol string is reliably available on
      // TV 3.1.0 without the symbolExt API.
      return { symbol: symbol, resolution: resolution, chart_type: chart_type, source: 'symbol_only' };
    })()
  `);
  return { success: true, ...result };
}

export async function symbolSearch({ query, type }) {
  // Use TradingView's public symbol search REST API (works without auth)
  const params = new URLSearchParams({
    text: query,
    hl: '1',
    exchange: '',
    lang: 'en',
    search_type: type || '',
    domain: 'production',
  });

  const resp = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
    headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
  });
  if (!resp.ok) throw new Error(`Symbol search API returned ${resp.status}`);
  const data = await resp.json();

  const strip = s => (s || '').replace(/<\/?em>/g, '');
  const results = (data.symbols || data || []).slice(0, 15).map(r => ({
    symbol: strip(r.symbol),
    description: strip(r.description),
    exchange: r.exchange || r.prefix || '',
    type: r.type || '',
    full_name: r.exchange ? `${r.exchange}:${strip(r.symbol)}` : strip(r.symbol),
  }));

  return { success: true, query, source: 'rest_api', results, count: results.length };
}
