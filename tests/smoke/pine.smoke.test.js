/**
 * Smoke tests — src/core/pine.js.
 * analyze() and check() pure logic already unit-tested via pine_helpers.
 * These cover the remaining Monaco/DOM-dependent async exports.
 */
import { describe, it, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { installCdpMocks, resetCdpMocks, cleanupConnection, fakeCdpClient } from '../helpers/mock-cdp.js';
import * as pine from '../../src/core/pine.js';

describe('core/pine.js — smoke', () => {
  afterEach(() => resetCdpMocks());
  after(cleanupConnection);

  it('test_ensurePineEditorOpen_smoke_alreadyOpen', async () => {
    installCdpMocks({ evaluate: async () => true });
    assert.equal(await pine.ensurePineEditorOpen(), true);
  });

  it('test_ensurePineEditorOpen_smoke_opens', async () => {
    let call = 0;
    installCdpMocks({
      evaluate: async () => {
        call++;
        if (call === 1) return false;   // initial Monaco check — not open
        if (call <= 3) return undefined; // activate tab + click button
        return true;                     // first poll succeeds
      },
    });
    assert.equal(await pine.ensurePineEditorOpen(), true);
  });

  it.todo('test_ensurePineEditorOpen_smoke_timeout', () => {
    // Timeout path polls 50 × 200ms = 10s — too slow for smoke.
    // Flagged for a real integration test.
  });

  it('test_getSource_smoke', async () => {
    // Call 1: ensurePineEditorOpen → true; Call 2: getValue returns source
    let call = 0;
    installCdpMocks({
      evaluate: async () => (++call <= 2 ? true : '//@version=6\nindicator("test")\nplot(close)'),
    });
    const r = await pine.getSource();
    assert.equal(r.success, true);
    assert.equal(r.line_count, 3);
    assert.ok(r.char_count > 0);
  });

  it('test_setSource_smoke', async () => {
    // pine_set_source now uses a setTimeout-poll architecture (A.7 KarmicP fix
    // for hangs on large scripts). The mocked evaluate returns 'done' for the
    // status poll on the second call.
    let callIdx = 0;
    installCdpMocks({
      evaluate: async () => {
        callIdx++;
        if (callIdx === 1) return undefined; // initial setTimeout-wrap
        return 'done'; // poll status
      },
    });
    const r = await pine.setSource({ source: 'line1\nline2' });
    assert.equal(r.success, true);
    assert.equal(r.lines_set, 2);
  });

  it('test_compile_smoke_buttonFound', async () => {
    // Call 1: ensurePineEditorOpen → true
    // Call 2: click button → returns label
    let call = 0;
    installCdpMocks({
      evaluate: async () => (++call <= 2 ? true : 'Save and add to chart'),
    });
    const r = await pine.compile();
    assert.equal(r.success, true);
    assert.equal(r.button_clicked, 'Save and add to chart');
  });

  it('test_compile_smoke_keyboardFallback', async () => {
    let call = 0;
    installCdpMocks({
      getClient: async () => fakeCdpClient(),
      evaluate: async () => (++call <= 2 ? true : null),
    });
    const r = await pine.compile();
    assert.equal(r.button_clicked, 'keyboard_shortcut');
  });

  it('test_getErrors_smoke', async () => {
    let call = 0;
    installCdpMocks({
      evaluate: async () => (++call <= 2 ? true : [
        { line: 3, column: 5, message: 'Undeclared identifier', severity: 8 },
      ]),
    });
    const r = await pine.getErrors();
    assert.equal(r.success, true);
    assert.equal(r.has_errors, true);
    assert.equal(r.error_count, 1);
  });

  it('test_save_smoke', async () => {
    let call = 0;
    installCdpMocks({
      getClient: async () => fakeCdpClient(),
      evaluate: async () => (++call <= 2 ? true : false),  // no save-dialog
    });
    const r = await pine.save();
    assert.equal(r.success, true);
    assert.equal(r.action, 'Ctrl+S_dispatched');
  });

  it('test_getConsole_smoke', async () => {
    let call = 0;
    installCdpMocks({
      evaluate: async () => (++call <= 2 ? true : [
        { timestamp: '12:00:00', type: 'info', message: 'compiled' },
      ]),
    });
    const r = await pine.getConsole();
    assert.equal(r.success, true);
    assert.equal(r.entry_count, 1);
  });

  it('test_smartCompile_smoke', async () => {
    let call = 0;
    installCdpMocks({
      evaluate: async () => {
        call++;
        if (call === 1) return true;    // PINE_EDITOR_DIALOG_PRESENT
        if (call === 2) return true;    // FIND_MONACO (ensurePineEditorOpen fast-path)
        if (call === 3) return [        // studiesBefore (array form)
          { id: 's1', name: 'RSI' },
        ];
        if (call === 4) return 'My Strategy'; // pineTitleBefore
        if (call === 5) return 'Add to chart'; // button click
        if (call === 6) return [];      // errors after
        return [                          // studiesAfter
          { id: 's1', name: 'RSI' },
          { id: 's2', name: 'My Strategy' },
        ];
      },
    });
    const r = await pine.smartCompile();
    assert.equal(r.success, true);
    assert.equal(r.button_clicked, 'Add to chart');
    assert.equal(r.has_errors, false);
    assert.equal(r.study_added, true);
    assert.equal(r.pine_title, 'My Strategy');
    assert.equal(r.matched_study.id, 's2');
  });

  it('test_smartCompile_smoke_rejects_unrelated_concurrent_add', async () => {
    // PasanteAdmin honest-success: a NEW study appeared but its name
    // doesn't match the Pine editor title — must NOT report study_added.
    let call = 0;
    installCdpMocks({
      evaluate: async () => {
        call++;
        if (call === 1) return true;    // PINE_EDITOR_DIALOG_PRESENT
        if (call === 2) return true;    // FIND_MONACO
        if (call === 3) return [{ id: 's1', name: 'RSI' }];
        if (call === 4) return 'My Strategy'; // editor has My Strategy open
        if (call === 5) return 'Add to chart';
        if (call === 6) return [];
        // After: My Strategy did NOT land; user added MACD concurrently
        return [
          { id: 's1', name: 'RSI' },
          { id: 's3', name: 'MACD' },
        ];
      },
    });
    const r = await pine.smartCompile();
    assert.equal(r.study_added, false, 'mismatched study name must not count as study_added');
    assert.equal(r.matched_study, null);
    assert.equal(r.new_studies.length, 1, 'new_studies still surfaced for caller inspection');
    assert.equal(r.new_studies[0].name, 'MACD');
  });

  it('test_smartCompile_smoke_no_new_studies', async () => {
    let call = 0;
    installCdpMocks({
      evaluate: async () => {
        call++;
        if (call === 1) return true;    // PINE_EDITOR_DIALOG_PRESENT
        if (call === 2) return true;    // FIND_MONACO
        if (call === 3) return [{ id: 's1', name: 'RSI' }];
        if (call === 4) return 'My Strategy';
        if (call === 5) return 'Update on chart'; // existing study updated
        if (call === 6) return [];
        return [{ id: 's1', name: 'RSI' }]; // no diff
      },
    });
    const r = await pine.smartCompile();
    assert.equal(r.study_added, false);
    assert.deepEqual(r.new_studies, []);
  });

  it('test_newScript_smoke', async () => {
    installCdpMocks({ evaluate: async () => true });
    const r = await pine.newScript({ type: 'strategy' });
    assert.equal(r.success, true);
    assert.equal(r.type, 'strategy');
    assert.equal(r.action, 'new_script_created');
  });

  it('test_openScript_smoke', async () => {
    installCdpMocks({
      evaluate: async () => true,                   // ensurePineEditorOpen
      evaluateAsync: async () => ({ success: true, name: 'My Script', id: 'id_1', lines: 20 }),
    });
    const r = await pine.openScript({ name: 'My Script' });
    assert.equal(r.success, true);
    assert.equal(r.name, 'My Script');
    assert.equal(r.lines, 20);
  });

  it('test_listScripts_smoke', async () => {
    installCdpMocks({
      evaluateAsync: async () => ({
        scripts: [
          { id: 'id_1', name: 'Script A', title: 'Script A', version: 1, modified: null },
          { id: 'id_2', name: 'Script B', title: 'Script B', version: 3, modified: null },
        ],
      }),
    });
    const r = await pine.listScripts();
    assert.equal(r.success, true);
    assert.equal(r.count, 2);
    assert.equal(r.scripts[0].name, 'Script A');
  });

  // ── B.16 saveAs ────────────────────────────────────────────────────
  it('test_saveAs_smoke', async () => {
    let evalIdx = 0;
    let asyncIdx = 0;
    installCdpMocks({
      // Each evaluate call: 1=ensurePineEditorOpen check, 2=getValue source
      evaluate: async () => {
        evalIdx++;
        if (evalIdx === 1) return true;            // FIND_MONACO non-null check (ensurePineEditorOpen)
        return 'indicator("test")\nplot(close)';   // editor.getValue()
      },
      // evaluateAsync sequence: save/new POST → openScript list → openScript get
      evaluateAsync: async () => {
        asyncIdx++;
        if (asyncIdx === 1) return { status: 200, data: { scriptIdPart: 'new-id', name: 'My Copy' } };
        // openScript invocation chain (list → get → setValue)
        return { success: true, name: 'My Copy', id: 'new-id', lines: 2 };
      },
    });
    const r = await pine.saveAs({ name: 'My Copy' });
    assert.equal(r.success, true);
    assert.equal(r.action, 'save_as');
    assert.equal(r.name, 'My Copy');
    assert.equal(r.script_id, 'new-id');
    assert.equal(r.reopened, true);
  });

  // Regression: when openScript fails after save/new, saveAs used to swallow
  // the error and falsely report success — leaving the editor pointed at the
  // previous script so subsequent pine_save would clobber the wrong script.
  it('test_saveAs_smoke_surfaces_reopen_failure', async () => {
    let evalIdx = 0;
    let asyncIdx = 0;
    installCdpMocks({
      evaluate: async () => {
        evalIdx++;
        if (evalIdx === 1) return true;
        return 'indicator("test")\nplot(close)';
      },
      evaluateAsync: async () => {
        asyncIdx++;
        if (asyncIdx === 1) return { status: 200, data: { scriptIdPart: 'new-id', name: 'My Copy' } };
        // openScript fails on the next call (list/get throws)
        throw new Error('openScript: dropdown not found');
      },
    });
    const r = await pine.saveAs({ name: 'My Copy' });
    assert.equal(r.success, true);
    assert.equal(r.action, 'save_as');
    assert.equal(r.reopened, false);
    assert.match(r.reopen_error, /dropdown not found/);
    assert.match(r.warning, /editor still points at the original script/);
  });

  it('test_saveAs_smoke_throws_on_save_failure', async () => {
    installCdpMocks({
      evaluate: async () => 'source-code',
      evaluateAsync: async () => ({ status: 500, data: { error: 'server err' } }),
    });
    await assert.rejects(
      pine.saveAs({ name: 'Foo' }),
      /pine-facade save\/new failed/,
    );
  });

  // ── B.16 renameScript ─────────────────────────────────────────────
  it('test_renameScript_smoke', async () => {
    let asyncIdx = 0;
    installCdpMocks({
      evaluate: async () => true,  // ensurePineEditorOpen
      evaluateAsync: async () => {
        asyncIdx++;
        if (asyncIdx === 1) return { id: 'sid-1', name: 'Old', version: 2 }; // _currentScriptInfo
        return { status: 200, ok: true };                                     // rename
      },
    });
    const r = await pine.renameScript({ name: 'New Name' });
    assert.equal(r.success, true);
    assert.equal(r.action, 'renamed');
    assert.equal(r.old_name, 'Old');
    assert.equal(r.name, 'New Name');
    assert.equal(r.script_id, 'sid-1');
  });

  it('test_renameScript_smoke_throws_on_rename_failure', async () => {
    let asyncIdx = 0;
    installCdpMocks({
      evaluate: async () => true,
      evaluateAsync: async () => {
        asyncIdx++;
        if (asyncIdx === 1) return { id: 'sid-1', name: 'Old', version: 1 };
        return { status: 403, ok: false };
      },
    });
    await assert.rejects(
      pine.renameScript({ name: 'Forbidden' }),
      /pine-facade rename failed/,
    );
  });

  // ── B.16 versionHistory ───────────────────────────────────────────
  it('test_versionHistory_smoke', async () => {
    installCdpMocks({
      evaluate: async () => true,                          // ensurePineEditorOpen
      evaluateAsync: async () => ({ ok: true }),           // _pineMenuAction
    });
    const r = await pine.versionHistory();
    assert.equal(r.success, true);
    assert.equal(r.action, 'version_history_opened');
  });

  // ── B.16 deleteScript ─────────────────────────────────────────────
  it('test_deleteScript_smoke', async () => {
    let asyncIdx = 0;
    installCdpMocks({
      evaluateAsync: async () => {
        asyncIdx++;
        if (asyncIdx === 1) {
          // pine-facade list
          return [
            { scriptIdPart: 'sid-99', scriptName: 'doomed-script', scriptTitle: 'doomed-script' },
          ];
        }
        // delete call
        return { status: 200, ok: true };
      },
    });
    const r = await pine.deleteScript({ name: 'doomed-script' });
    assert.equal(r.success, true);
    assert.equal(r.action, 'deleted');
    assert.equal(r.script_id, 'sid-99');
  });

  it('test_deleteScript_smoke_throws_on_not_found', async () => {
    installCdpMocks({
      evaluateAsync: async () => [],   // empty list
    });
    await assert.rejects(
      pine.deleteScript({ name: 'nonexistent' }),
      /not found/,
    );
  });

  // ── B.17 switchScript (Ctrl+O picker path) ────────────────────────
  // Call sequence:
  //  1. ensurePineEditorOpen → PINE_EDITOR_DIALOG_PRESENT
  //  2. ensurePineEditorOpen → MONACO_PINE_EDITOR_AVAILABLE
  //  3. currentBefore (title button text)
  //  --- if short-circuit, return here ---
  //  4. dispatch Escape×2 (clear menus, returns undefined)
  //  5. focus textarea (returns undefined)
  //  6. Ctrl+O keydown/press/up (returns undefined)
  //  7. poll for picker dialog → true/false
  //  8. set search input value (returns undefined)
  //  9. find + click matching row → { ok: true, matched_via: 'exact_title'|'prefix' } or { error }
  // 10..N. poll for title-button text to match (early-exit when match)
  //  N+1. close dialog (returns undefined)
  it('test_switchScript_smoke_short_circuits_when_already_active', async () => {
    let evalIdx = 0;
    installCdpMocks({
      evaluate: async () => {
        evalIdx++;
        if (evalIdx === 1) return true;       // PINE_EDITOR_DIALOG_PRESENT
        if (evalIdx === 2) return true;       // MONACO_PINE_EDITOR_AVAILABLE
        return 'My Strategy';                  // current name (matches)
      },
    });
    const r = await pine.switchScript({ name: 'My Strategy' });
    assert.equal(r.success, true);
    assert.equal(r.shortCircuited, true);
    assert.equal(r.current, 'My Strategy');
  });

  it('test_switchScript_smoke_throws_when_picker_does_not_open', async () => {
    let evalIdx = 0;
    installCdpMocks({
      evaluate: async () => {
        evalIdx++;
        if (evalIdx === 1) return true;          // PINE_EDITOR_DIALOG_PRESENT
        if (evalIdx === 2) return true;          // MONACO_PINE_EDITOR_AVAILABLE
        if (evalIdx === 3) return 'Different';   // currentBefore (not target)
        if (evalIdx === 4) return undefined;     // Escape clear
        if (evalIdx === 5) return undefined;     // focus textarea
        if (evalIdx === 6) return undefined;     // Ctrl+O dispatch
        if (evalIdx === 7) return false;         // poll for dialog → timeout
        return undefined;
      },
    });
    await assert.rejects(
      pine.switchScript({ name: 'My Strategy' }),
      /picker dialog did not appear/,
    );
  });

  it('test_switchScript_smoke_completes_via_react_onclick', async () => {
    let evalIdx = 0;
    installCdpMocks({
      evaluate: async () => {
        evalIdx++;
        if (evalIdx === 1) return true;          // PINE_EDITOR_DIALOG_PRESENT
        if (evalIdx === 2) return true;          // MONACO_PINE_EDITOR_AVAILABLE
        if (evalIdx === 3) return 'Different';   // currentBefore
        if (evalIdx === 4) return undefined;     // Escape clear
        if (evalIdx === 5) return undefined;     // focus textarea
        if (evalIdx === 6) return undefined;     // Ctrl+O dispatch
        if (evalIdx === 7) return true;          // picker dialog appears
        if (evalIdx === 8) return undefined;     // set search input
        if (evalIdx === 9) return { ok: true, matched_via: 'exact_title' };  // React onClick
        if (evalIdx === 10) return 'My Strategy'; // title-button after click (matches on first poll)
        return undefined;                         // dialog close
      },
    });
    const r = await pine.switchScript({ name: 'My Strategy' });
    assert.equal(r.success, true);
    assert.equal(r.current, 'My Strategy');
    assert.equal(r.matched_via, 'exact_title');
  });

  it('test_switchScript_smoke_throws_when_script_not_in_picker', async () => {
    let evalIdx = 0;
    installCdpMocks({
      evaluate: async () => {
        evalIdx++;
        if (evalIdx === 1) return true;          // PINE_EDITOR_DIALOG_PRESENT
        if (evalIdx === 2) return true;          // MONACO_PINE_EDITOR_AVAILABLE
        if (evalIdx === 3) return 'Different';   // currentBefore
        if (evalIdx === 4) return undefined;     // Escape clear
        if (evalIdx === 5) return undefined;     // focus textarea
        if (evalIdx === 6) return undefined;     // Ctrl+O dispatch
        if (evalIdx === 7) return true;          // picker dialog appears
        if (evalIdx === 8) return undefined;     // set search input
        if (evalIdx === 9) return { error: 'no_match', searched: 'Missing', results: ['Foo', 'Bar'] };
        return undefined;                         // dialog close
      },
    });
    await assert.rejects(
      pine.switchScript({ name: 'Missing' }),
      /not found in picker.*Foo, Bar/,
    );
  });
});
