/**
 * pine_deploy — file-based atomic deploy for Pine Script.
 *
 * Reads a `.pine` file from disk, optionally pre-cleans same-title
 * instances from the chart (to avoid TV's max-N-instances cap +
 * duplicate-build-up), injects into the editor via setSource, saves,
 * and clicks "Add to chart" via smart_compile.
 *
 * The "file from disk" path matters: MCP callers (Claude, etc.) don't
 * have to embed the Pine source in the tool call. For a 50-100 KB Pine
 * file, that's a real token-tax saving — and it lets the agent treat
 * `pine_deploy` as a one-shot replacement for the four-step
 * pine_set_source + pine_save + Add-to-chart click + pine_get_errors
 * chain.
 *
 * Compose-from-primitives port (prezis fork commit e423ec9, May 2026):
 * we use our own hardened `setSource`, `save`, `smartCompile`,
 * `getErrors`, and `removeStudiesByTitle` rather than the upstream
 * implementations, since ours have been live-validated across more
 * dialog / Monaco / button-selector edge cases on TV 3.1+.
 */
import { readFile } from 'node:fs/promises';
import * as _pine from './pine.js';
import * as _chart from './chart.js';

/**
 * Parse a Pine string literal starting at index `i` of `source`. Returns
 * { value, end } where `end` is the index after the closing quote, or
 * null if no valid literal at that position. Honors `\\` and `\"`/`\'`
 * escape sequences inside the matching quote style.
 */
function _readPineString(source, i) {
  const quote = source[i];
  if (quote !== '"' && quote !== "'") return null;
  let out = '';
  let j = i + 1;
  while (j < source.length) {
    const ch = source[j];
    if (ch === '\\' && j + 1 < source.length) {
      const next = source[j + 1];
      if (next === quote || next === '\\') { out += next; j += 2; continue; }
    }
    if (ch === quote) return { value: out, end: j + 1 };
    if (ch === '\n' && quote === '"') return null;  // unterminated
    out += ch;
    j++;
  }
  return null;
}

/**
 * Derive a pre-clean title match from the Pine source's indicator() /
 * strategy() declaration title.
 *
 * Precedence: explicit `title=` named arg, then the first positional
 * string, then the file basename. The previous regex
 * `/['"]([^'"]+)['"]/` grabbed the FIRST quoted string after the paren,
 * which silently mis-derived `indicator(shorttitle="NQR", title="...")`
 * (returned "NQR") and broke entirely on titles containing escaped
 * quotes. The new parser is quote-aware (honors `\"` / `\\` escapes
 * inside the matching quote style) and named-arg aware so the resolved
 * title flows correctly into the chart.removeStudiesByTitle pre-clean.
 */
export function deriveCleanMatch(source, pinePath) {
  const decl = source.match(/\b(indicator|strategy)\s*\(/);
  if (decl) {
    const argsStart = decl.index + decl[0].length;
    let namedTitle = null;
    let positionalTitle = null;
    let i = argsStart;
    let depth = 1;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '(') { depth++; i++; continue; }
      if (ch === ')') { depth--; i++; continue; }
      if (ch === '"' || ch === "'") {
        const lit = _readPineString(source, i);
        if (!lit) { i++; continue; }
        if (positionalTitle === null) positionalTitle = lit.value;
        i = lit.end;
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        const nameMatch = source.slice(i).match(/^([A-Za-z_][A-Za-z_0-9]*)\s*=\s*/);
        if (nameMatch) {
          const name = nameMatch[1];
          const valStart = i + nameMatch[0].length;
          if (source[valStart] === '"' || source[valStart] === "'") {
            const lit = _readPineString(source, valStart);
            if (lit) {
              if (name === 'title' && namedTitle === null) namedTitle = lit.value;
              i = lit.end;
              continue;
            }
          }
          i = valStart;
          continue;
        }
      }
      i++;
    }
    const picked = namedTitle || positionalTitle;
    if (picked) return picked;
  }
  const base = String(pinePath || '').split(/[/\\]/).pop() || '';
  return base.replace(/\.pine$/i, '');
}

/**
 * File-based atomic Pine deploy.
 *
 * Steps:
 *   0. Read source from pinePath; reject empty.
 *   1. (Optional) Pre-clean same-title instances from chart. CRITICAL:
 *      must happen BEFORE Add-to-chart, otherwise TV uses
 *      "Update on chart" semantics, which can produce a duplicate
 *      instance or a "Cannot add a script with unsaved changes" dialog.
 *      Caller controls: pass cleanMatch:null to skip; omit to auto-derive
 *      from indicator()/strategy() title; or pass an explicit substring.
 *   2. setSource — inject via Monaco setValue with 15 s polling.
 *   3. save — Ctrl+S + Save-dialog handler.
 *   4. smartCompile — click "Add to chart" / "Update on chart" via
 *      hardened selector + diff studies before/after to verify the new
 *      study was actually added (honest_success).
 *   5. getErrors — read compile-marker errors from Monaco.
 *
 * Returns { success, errors, study_added, matched_study, pre_cleaned,
 *           pine_title, source_bytes, file }
 */
export async function deployScript({ pinePath, cleanMatch, _deps } = {}) {
  if (!pinePath) throw new Error('pinePath is required');
  const pine = _deps?.pine || _pine;
  const chart = _deps?.chart || _chart;
  const readFileImpl = _deps?.readFile || readFile;

  const source = await readFileImpl(pinePath, 'utf-8');
  if (!source.trim()) throw new Error(`File is empty: ${pinePath}`);

  // Step 1 — pre-clean
  let preCleaned = null;
  const match = cleanMatch === undefined ? deriveCleanMatch(source, pinePath) : cleanMatch;
  if (match) {
    try {
      const r = await chart.removeStudiesByTitle({ title_match: match, _deps });
      preCleaned = { match, removed: r.removed || [], matched: r.matched || [] };
    } catch (e) {
      preCleaned = { match, error: e.message };
    }
  }

  // Step 2 — inject source
  await pine.setSource({ source, _deps });

  // Step 3 — save
  await pine.save({ _deps });

  // Step 4 — Add-to-chart (with honest success check)
  const compile = await pine.smartCompile({ _deps });

  // Step 5 — collect Monaco errors
  let errors = [];
  try {
    const e = await pine.getErrors({ _deps });
    errors = e.errors || [];
  } catch { /* getErrors is best-effort */ }

  return {
    success: errors.length === 0 && compile.study_added !== false,
    errors,
    study_added: compile.study_added,
    matched_study: compile.matched_study || null,
    pine_title: compile.pine_title || null,
    pre_cleaned: preCleaned,
    source_bytes: source.length,
    file: pinePath,
    compile,
  };
}
