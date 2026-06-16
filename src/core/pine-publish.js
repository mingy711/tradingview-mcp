/**
 * pine_publish — Pine Script publish flow.
 *
 * Currently exposes **only** the read-only `publishDialogInspect` probe.
 * The active publishScript implementation from the jacktradesnq fork
 * (commit 5ec59b1, May 2026) is French-locale-only ("Touches finales",
 * "Continuer", "Publier", "Mettre à jour") and uses TV-build-specific
 * hashed CSS classes (`.title-input-olfWh9s2`, `.textarea-x5KHDULU`,
 * `.first-step-button-olfWh9s2`, `.segmentedControlBase-NZgAw_ip`).
 * Both inputs to that flow change every TV release; submitting a real
 * publish from a stale selector also risks an accidental public push to
 * TradingView's community library.
 *
 * The right shape for active publish is: run `pine_publish_dialog_inspect`
 * on the user's current TV build + locale, capture the actual labels +
 * class names, then generate a per-build selector map. That work lives
 * downstream — `pine_publish_dialog_inspect` enables it.
 */
import { evaluate as _evaluate } from '../connection.js';
import { ensurePineEditorOpen as _ensurePineEditorOpen } from './pine.js';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    ensurePineEditorOpen: deps?.ensurePineEditorOpen || _ensurePineEditorOpen,
  };
}

/**
 * Click the Pine Editor's "Publish script" toolbar button and dump the
 * resulting dialog's full structure: inputs, buttons, radios/checkboxes,
 * headings, embedded editor containers. Used to discover per-TV-build
 * selectors before wiring a real publish flow.
 *
 * Returns { success, button_clicked: {clicked, text, aria, data_name},
 *           dialog_found, dialog_class, dialog_role, inputs[], buttons[],
 *           radios_or_checkboxes[], headings[], editor_containers[] }.
 */
export async function publishDialogInspect({ _deps } = {}) {
  const { evaluate, ensurePineEditorOpen } = _resolve(_deps);
  const editorReady = await ensurePineEditorOpen({ _deps });
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  // Step 1 — click the publish button, scoped to the Pine Editor root.
  // Document-wide queries previously matched 'publish' surfaces on
  // unrelated panels (alert-conditions, strategy-tester, layout
  // publishing), so a collapsed Pine editor could trigger publish on
  // another flow — the subsequent dialog dump would return data from
  // the wrong dialog. The Pine editor root is anchored by the
  // .pine-editor-monaco container (or .pine-editor-* fallback).
  const buttonClicked = await evaluate(`
    (function() {
      function visible(el) { return el && el.offsetParent !== null; }
      // Resolve the Pine editor root; refuse to broaden to document.
      var root = document.querySelector('.pine-editor-monaco')
              || document.querySelector('[class*="pine-editor"]')
              || document.querySelector('[data-name*="pine-editor" i]');
      if (!root) return { clicked: false, error: 'Pine editor root not found — cannot scope publish-button search' };
      // Walk up to the editor's surrounding panel so the toolbar buttons
      // (which live in a sibling of the editor container) are reachable.
      var scope = root.closest('[class*="widgetbar" i], [class*="editor-container" i], [data-name*="pine" i]') || root.parentElement || root;
      var candidates = [];
      var byData = scope.querySelectorAll('[data-name*="publish" i]');
      for (var i = 0; i < byData.length; i++) candidates.push(byData[i]);
      var byAria = scope.querySelectorAll('[aria-label*="ublish" i]');
      for (var j = 0; j < byAria.length; j++) candidates.push(byAria[j]);
      var byClass = scope.querySelectorAll('[class*="publishButton" i]');
      for (var n = 0; n < byClass.length; n++) candidates.push(byClass[n]);
      var btns = scope.querySelectorAll('button, [role="button"]');
      for (var k = 0; k < btns.length; k++) {
        var t = (btns[k].textContent || '').trim();
        var al = btns[k].getAttribute('aria-label') || '';
        if (/publish.*script/i.test(t) || /publier.*script/i.test(t) ||
            /publish.*script/i.test(al) || /^publish$/i.test(t)) {
          candidates.push(btns[k]);
        }
      }
      for (var m = 0; m < candidates.length; m++) {
        if (visible(candidates[m])) {
          candidates[m].click();
          return {
            clicked: true,
            text: (candidates[m].textContent || '').trim().slice(0, 80),
            aria: candidates[m].getAttribute('aria-label') || null,
            data_name: candidates[m].getAttribute('data-name') || null,
          };
        }
      }
      return { clicked: false };
    })()
  `);

  if (!buttonClicked || !buttonClicked.clicked) {
    return { success: false, error: buttonClicked?.error || 'Publish Script button not found in Pine Editor toolbar.' };
  }

  await new Promise(r => setTimeout(r, 1500));

  // The publish dialog has a real Publish button that pushes scripts to
  // TV's public community library; leaving it open after an inspection
  // failure invites accidental clicks by the user or downstream
  // automation. Always close on any non-happy exit path.
  const closeDialog = async () => {
    try {
      await evaluate(`
        (function() {
          var rx = /^(close|cancel|×|annuler|cancelar|abbrechen|chiudi)$/i;
          var dialogs = document.querySelectorAll('[role="dialog"], [class*="dialog" i], [class*="modal" i]');
          for (var d = 0; d < dialogs.length; d++) {
            if (dialogs[d].offsetParent === null) continue;
            var btns = dialogs[d].querySelectorAll('button, [role="button"]');
            for (var i = 0; i < btns.length; i++) {
              var t = (btns[i].textContent || '').trim();
              var al = btns[i].getAttribute('aria-label') || '';
              if (rx.test(t) || /^(close|cancel)$/i.test(al)) {
                if (btns[i].offsetParent !== null) { btns[i].click(); return true; }
              }
            }
          }
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
          return false;
        })()
      `);
    } catch { /* best-effort cleanup */ }
  };

  // Step 2 — dump everything in the visible dialog so callers can
  // discover their TV build's actual selectors + labels.
  let inspection;
  try {
    inspection = await evaluate(`
      (function() {
        function visible(el) { return el && el.offsetParent !== null; }
        function preview(s) { s = String(s == null ? '' : s); return s.length > 100 ? s.slice(0, 100) : s; }
        function findLabel(el) {
          if (!el) return '';
          if (el.id) {
            var lab = document.querySelector('label[for="' + el.id + '"]');
            if (lab) return (lab.textContent || '').trim();
          }
          var p = el.parentElement;
          for (var i = 0; i < 4 && p; i++) {
            if (p.tagName === 'LABEL') return (p.textContent || '').trim();
            p = p.parentElement;
          }
          return (el.getAttribute('aria-label') || '').trim();
        }

        var dialogs = document.querySelectorAll('[role="dialog"], [class*="dialog" i], [class*="modal" i], [data-name*="dialog" i]');
        var dialog = null;
        for (var i = 0; i < dialogs.length; i++) {
          if (visible(dialogs[i])) { dialog = dialogs[i]; break; }
        }
        if (!dialog) return { dialog_found: false };

        var inputs = [];
        var raw = dialog.querySelectorAll('input, textarea, select');
        for (var a = 0; a < raw.length; a++) {
          var el = raw[a];
          var type = (el.type || el.tagName).toLowerCase();
          if (type === 'radio' || type === 'checkbox') continue;
          inputs.push({
            tag: el.tagName.toLowerCase(), type: type,
            name: el.name || null, id: el.id || null,
            placeholder: el.placeholder || null,
            aria_label: el.getAttribute('aria-label') || null,
            class: el.className || null,
            value_preview: preview(el.value),
          });
        }

        var buttons = [];
        var btns = dialog.querySelectorAll('button, [role="button"]');
        for (var b = 0; b < btns.length; b++) {
          if (!visible(btns[b])) continue;
          buttons.push({
            text: (btns[b].textContent || '').trim().slice(0, 120),
            aria_label: btns[b].getAttribute('aria-label') || null,
            class: btns[b].className || null,
            disabled: btns[b].disabled === true || btns[b].getAttribute('aria-disabled') === 'true',
          });
        }

        var radios = [];
        var rcs = dialog.querySelectorAll('input[type="radio"], input[type="checkbox"]');
        for (var r = 0; r < rcs.length; r++) {
          radios.push({
            type: rcs[r].type, name: rcs[r].name || null, value: rcs[r].value || null,
            label_text: findLabel(rcs[r]),
            checked: rcs[r].checked === true,
          });
        }

        var headings = [];
        var hs = dialog.querySelectorAll('h1, h2, h3, h4, [role="heading"]');
        for (var h = 0; h < hs.length; h++) {
          var ht = (hs[h].textContent || '').trim();
          if (ht) headings.push(ht);
        }

        var editors = [];
        var eds = dialog.querySelectorAll('[class*="editor" i], [class*="monaco" i]');
        for (var e = 0; e < eds.length; e++) {
          editors.push({
            class: eds[e].className || null,
            tag: eds[e].tagName.toLowerCase(),
            has_monaco: /monaco/i.test(eds[e].className || ''),
          });
        }

        return {
          dialog_found: true,
          dialog_class: dialog.className || null,
          dialog_role: dialog.getAttribute('role') || null,
          inputs: inputs, buttons: buttons,
          radios_or_checkboxes: radios,
          headings: headings, editor_containers: editors,
        };
      })()
    `);
  } catch (err) {
    await closeDialog();
    throw err;
  }

  if (!inspection || !inspection.dialog_found) {
    await closeDialog();
    return { success: false, error: 'Publish button clicked but no dialog appeared after 1500ms.', button_clicked: buttonClicked };
  }

  return { success: true, button_clicked: buttonClicked, ...inspection };
}
