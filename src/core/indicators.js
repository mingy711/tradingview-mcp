/**
 * Core indicator settings logic.
 */
import { evaluate as _evaluate, safeString } from '../connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

function _resolve(deps) {
  return { evaluate: deps?.evaluate || _evaluate };
}

/**
 * Set indicator input values.
 *
 * Override-key resolution: each key in `inputs` is matched first against
 * the input's machine `id` (e.g. "in_0", "length"), then as a fallback
 * against the case-insensitive `name` (the display label shown in TV's
 * settings dialog — e.g. "Length", "RSI Source"). Without the display-
 * name fallback, common pattern `{ "Length": 21 }` silently dropped
 * because TV exposes the input under id "in_0" but the user only knows
 * the visible label. Surfaced from jacktradesnq fork May 2026.
 *
 * Returns:
 *   updated_inputs    { id: appliedValue }     keys whose override stuck
 *   unmatched_keys    [ "key", ... ]           override keys with no id/name match
 *   detected_inputs   [ {id, value, name, type, options[]}, ... ]
 *                                              full schema of the study's inputs,
 *                                              useful for the caller to retry with
 *                                              the right key when unmatched > 0.
 */
export async function setInputs({ entity_id, inputs: inputsRaw, _deps }) {
  const { evaluate } = _resolve(_deps);
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (!inputs || typeof inputs !== 'object' || Object.keys(inputs).length === 0) {
    throw new Error('inputs must be a non-empty object, e.g. { length: 50 }');
  }

  const inputsJson = JSON.stringify(inputs);

  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var currentInputs = study.getInputValues();

      // Best-effort meta lookup so we can surface display name / type /
      // options to the caller AND build a name → id resolver.
      var meta = null;
      try {
        if (typeof study.metaInfo === 'function') meta = study.metaInfo();
        else if (study._metaInfo) meta = study._metaInfo;
      } catch(e) {}

      function metaFor(id) {
        if (!meta || !Array.isArray(meta.inputs)) return null;
        for (var k = 0; k < meta.inputs.length; k++) {
          if (meta.inputs[k] && meta.inputs[k].id === id) return meta.inputs[k];
        }
        return null;
      }

      var detected = currentInputs.map(function(it) {
        var mi = metaFor(it.id);
        return {
          id: it.id,
          value: it.value,
          name: mi ? (mi.name || null) : null,
          type: mi ? (mi.type || null) : null,
          options: mi && Array.isArray(mi.options) ? mi.options.slice(0, 30) : null,
        };
      });

      var overrides = ${inputsJson};
      var updatedKeys = {};
      var unmatched = [];

      // id-first lookup, then case-insensitive display-name fallback.
      // Track display-name collisions: if two inputs share the same name
      // (case-insensitively), the key is ambiguous — refuse to guess, push
      // to unmatched_keys so the caller switches to ids.
      var idIdx = {};
      var nameIdx = {};
      var nameCollision = {};
      for (var i = 0; i < currentInputs.length; i++) {
        idIdx[currentInputs[i].id] = i;
        var mi2 = metaFor(currentInputs[i].id);
        if (mi2 && mi2.name) {
          var lname = String(mi2.name).toLowerCase();
          if (Object.prototype.hasOwnProperty.call(nameIdx, lname)) nameCollision[lname] = true;
          else nameIdx[lname] = i;
        }
      }

      Object.keys(overrides).forEach(function(key) {
        var idx = -1;
        if (Object.prototype.hasOwnProperty.call(idIdx, key)) idx = idIdx[key];
        else {
          var lkey = String(key).toLowerCase();
          if (Object.prototype.hasOwnProperty.call(nameCollision, lkey)) { unmatched.push(key); return; }
          if (Object.prototype.hasOwnProperty.call(nameIdx, lkey)) idx = nameIdx[lkey];
        }
        if (idx === -1) { unmatched.push(key); return; }
        currentInputs[idx].value = overrides[key];
        updatedKeys[currentInputs[idx].id] = overrides[key];
      });

      try { study.setInputValues(currentInputs); }
      catch(e) { return { error: 'setInputValues failed: ' + e.message, detected_inputs: detected }; }
      return { updated_inputs: updatedKeys, unmatched_keys: unmatched, detected_inputs: detected };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  return {
    success: true,
    entity_id,
    updated_inputs: result.updated_inputs || {},
    unmatched_keys: result.unmatched_keys || [],
    detected_inputs: result.detected_inputs || [],
  };
}

export async function toggleVisibility({ entity_id, visible, _deps }) {
  const { evaluate } = _resolve(_deps);
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (typeof visible !== 'boolean') throw new Error('visible must be a boolean (true or false)');

  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      study.setVisible(${visible});
      var actualVisible = study.isVisible();
      return { visible: actualVisible };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  return { success: true, entity_id, visible: result.visible };
}
