/**
 * Strategy Tester controls beyond what data.js / chart.js expose.
 *
 * Currently: setDeepBacktestRange — drive the Deep Backtesting calendar
 * picker in the Strategy Tester header. Used by historical-replay sweeps
 * that need to scope a backtest to a specific date window before the
 * tester re-runs.
 *
 * Ported from jacktradesnq fork (commit 7c5b6c2, May 2026). Adapted to
 * our _deps DI pattern + safeString interpolation. Locale tolerant
 * (English / French / generic "OK" / "Apply" submit labels).
 */
import { evaluate as _evaluate } from '../connection.js';

function _resolve(deps) {
  return { evaluate: deps?.evaluate || _evaluate };
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export async function setDeepBacktestRange({ from, to, _deps } = {}) {
  if (!YMD.test(String(from || '')) || !YMD.test(String(to || ''))) {
    throw new Error('from and to must be YYYY-MM-DD strings.');
  }
  const { evaluate } = _resolve(_deps);

  // Step 1 — open the date-range picker in the Strategy Tester header.
  // The match shape is intentionally narrow: TWO year-shaped tokens
  // (19xx/20xx) separated by an en/em/hyphen dash. Previous loose match
  // (one 4-digit run + any dash) could click any P&L/drawdown cell that
  // happened to contain a negative number — e.g. "Net profit: -1234.56"
  // matched and Step 2 timed out with a misleading message. The new
  // regex also requires the strategy-tester container to exist (no
  // document-wide fallback) so we never wander into another panel.
  const opened = await evaluate(`
    (function() {
      function visible(el) { return el && el.offsetParent !== null; }
      var st = document.querySelector('[class*="strategy-tester" i], [data-name*="strategy-tester" i], [class*="strategyTester" i]');
      if (!st) return { ok: false, error: 'strategy-tester container not found — is the panel open?' };
      var btns = st.querySelectorAll('button, [role="button"]');
      // Two year-shaped tokens (19xx or 20xx) + dash separator.
      var rangeShape = /\\b(19|20)\\d{2}\\b[\\s\\S]{1,40}[—\\-–][\\s\\S]{1,40}\\b(19|20)\\d{2}\\b/;
      for (var i = 0; i < btns.length; i++) {
        if (!visible(btns[i])) continue;
        var t = (btns[i].textContent || '').trim();
        if (t.length > 80) continue;
        if (rangeShape.test(t)) {
          btns[i].click();
          return { ok: true, text: t };
        }
      }
      return { ok: false, error: 'date range button not found in strategy tester' };
    })()
  `);
  if (!opened || !opened.ok) {
    return { success: false, error: opened?.error || 'could not open Deep BT range picker' };
  }

  // Step 2 — wait for the modal's two YYYY-MM-DD inputs to mount.
  let inputCount = 0;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 200));
    const probe = await evaluate(`
      (function() {
        var ins = document.querySelectorAll('input[placeholder="YYYY-MM-DD"]');
        var n = 0;
        for (var i = 0; i < ins.length; i++) { if (ins[i].offsetParent !== null) n++; }
        return n;
      })()
    `);
    inputCount = Number(probe) || 0;
    if (inputCount >= 2) break;
  }
  if (inputCount < 2) {
    return { success: false, error: 'date range modal did not open (no YYYY-MM-DD inputs found)' };
  }

  // Step 3 — fill both inputs via React-friendly setter, then poll the
  // submit-button enabled state (React validation re-render runs on a
  // microtask boundary; checking immediately would observe pre-change
  // state). Submit-button search is scoped to the modal that contains
  // the date inputs — previously a document-wide query could click an
  // unrelated 'OK' / 'Apply' button on another panel.
  const escFrom = JSON.stringify(from);
  const escTo = JSON.stringify(to);

  // Fill inputs separately so the wait can see post-render state.
  const fillResult = await evaluate(`
    (function() {
      function visible(el) { return el && el.offsetParent !== null; }
      function setReactInputValue(el, value) {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }
      var ins = document.querySelectorAll('input[placeholder="YYYY-MM-DD"]');
      var visIns = [];
      for (var i = 0; i < ins.length; i++) { if (visible(ins[i])) visIns.push(ins[i]); }
      if (visIns.length < 2) return { ok: false, error: 'fewer than 2 visible date inputs' };
      setReactInputValue(visIns[0], ${escFrom});
      setReactInputValue(visIns[1], ${escTo});
      // Resolve the modal container so the submit search is scoped.
      var modal = visIns[0].closest('[role="dialog"], [class*="dialog" i], [class*="modal" i], [data-dialog-name]');
      return { ok: true, set_from: visIns[0].value, set_to: visIns[1].value, modal_found: !!modal };
    })()
  `);
  if (!fillResult || !fillResult.ok) {
    return { success: false, error: fillResult?.error || 'could not fill range', detail: fillResult };
  }

  // Poll submit-button enable state inside the modal.
  let submitProbe = null;
  for (let i = 0; i < 20; i++) {
    submitProbe = await evaluate(`
      (function() {
        function visible(el) { return el && el.offsetParent !== null; }
        var ins = document.querySelectorAll('input[placeholder="YYYY-MM-DD"]');
        var anchor = null;
        for (var k = 0; k < ins.length; k++) { if (visible(ins[k])) { anchor = ins[k]; break; } }
        if (!anchor) return { ready: false, error: 'inputs disappeared' };
        var scope = anchor.closest('[role="dialog"], [class*="dialog" i], [class*="modal" i], [data-dialog-name]') || document;
        var allBtns = scope.querySelectorAll('button');
        var submitBtn = null;
        for (var b = 0; b < allBtns.length; b++) {
          if (!visible(allBtns[b])) continue;
          var t = (allBtns[b].textContent || '').trim();
          if (/^(S[ée]lectionner|Select|Apply|Appliquer|OK)$/i.test(t)) { submitBtn = allBtns[b]; break; }
        }
        if (!submitBtn) return { ready: false, error: 'submit button not found in modal scope' };
        var dis = submitBtn.disabled || submitBtn.getAttribute('aria-disabled') === 'true';
        return { ready: !dis, text: (submitBtn.textContent || '').trim() };
      })()
    `);
    if (submitProbe && submitProbe.ready) break;
    await new Promise(r => setTimeout(r, 75));
  }
  if (!submitProbe || !submitProbe.ready) {
    return {
      success: false,
      error: submitProbe?.error || 'submit button never enabled (date range may be invalid)',
      set_inputs: { from: fillResult.set_from, to: fillResult.set_to },
    };
  }

  // Click — the button is enabled within the modal scope.
  const filled = await evaluate(`
    (function() {
      function visible(el) { return el && el.offsetParent !== null; }
      var ins = document.querySelectorAll('input[placeholder="YYYY-MM-DD"]');
      var anchor = null;
      for (var k = 0; k < ins.length; k++) { if (visible(ins[k])) { anchor = ins[k]; break; } }
      if (!anchor) return { ok: false, error: 'inputs disappeared before click' };
      var scope = anchor.closest('[role="dialog"], [class*="dialog" i], [class*="modal" i], [data-dialog-name]') || document;
      var allBtns = scope.querySelectorAll('button');
      var submitBtn = null;
      for (var b = 0; b < allBtns.length; b++) {
        if (!visible(allBtns[b])) continue;
        var t = (allBtns[b].textContent || '').trim();
        if (/^(S[ée]lectionner|Select|Apply|Appliquer|OK)$/i.test(t)) { submitBtn = allBtns[b]; break; }
      }
      if (!submitBtn) return { ok: false, error: 'submit button not found' };
      submitBtn.click();
      return { ok: true, set_from: anchor.value, button: (submitBtn.textContent || '').trim() };
    })()
  `);
  if (!filled || !filled.ok) {
    return { success: false, error: filled?.error || 'could not fill range', detail: filled };
  }

  // Step 4 — verify the strategy-tester button reflects the new range.
  // Use the same tight regex as the picker-button search so the verifier
  // can't read from an unrelated cell.
  await new Promise(r => setTimeout(r, 1000));
  const verify = await evaluate(`
    (function() {
      function visible(el) { return el && el.offsetParent !== null; }
      var st = document.querySelector('[class*="strategy-tester" i], [data-name*="strategy-tester" i], [class*="strategyTester" i]');
      if (!st) return { displayed: null };
      var btns = st.querySelectorAll('button, [role="button"]');
      var rangeShape = /\\b(19|20)\\d{2}\\b[\\s\\S]{1,40}[—\\-–][\\s\\S]{1,40}\\b(19|20)\\d{2}\\b/;
      for (var i = 0; i < btns.length; i++) {
        if (!visible(btns[i])) continue;
        var t = (btns[i].textContent || '').trim();
        if (t.length > 80) continue;
        if (rangeShape.test(t)) return { displayed: t };
      }
      return { displayed: null };
    })()
  `);

  const yearFrom = from.slice(0, 4);
  const yearTo = to.slice(0, 4);
  const display = verify?.displayed || '';
  const matches = display.includes(yearFrom) && display.includes(yearTo);

  return {
    success: matches,
    requested: { from, to },
    set_inputs: { from: fillResult.set_from, to: fillResult.set_to },
    submit_button: filled.button,
    displayed: verify?.displayed || null,
    note: matches ? undefined : 'Range submitted but display verification did not match the requested years. Check Strategy Tester manually.',
  };
}
