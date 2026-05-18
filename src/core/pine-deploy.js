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

const TITLE_REGEX = /(?:indicator|strategy)\s*\(\s*[\s\S]*?['"]([^'"]+)['"]/;

/**
 * Derive a pre-clean title match from the Pine source's indicator() /
 * strategy() declaration title. Falls back to the file basename when
 * the declaration can't be parsed. Caller can override via explicit
 * `cleanMatch` arg to deployScript().
 */
export function deriveCleanMatch(source, pinePath) {
  const m = source.match(TITLE_REGEX);
  if (m) return m[1];
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
