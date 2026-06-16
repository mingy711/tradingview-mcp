/**
 * Smoke tests — src/core/ui.js.
 * Pure helpers (modifierMask, resolveKey, scrollDelta, findLayoutMatch)
 * are already unit-tested. These cover the CDP-dependent exports.
 */
import { describe, it, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { installCdpMocks, resetCdpMocks, cleanupConnection, fakeCdpClient } from '../helpers/mock-cdp.js';
import * as ui from '../../src/core/ui.js';

describe('core/ui.js — smoke', () => {
  afterEach(() => resetCdpMocks());
  after(cleanupConnection);

  it('test_click_smoke', async () => {
    installCdpMocks({
      evaluate: async () => ({ found: true, tag: 'button', text: 'Save', aria_label: null, data_name: null }),
    });
    const r = await ui.click({ by: 'text', value: 'Save' });
    assert.equal(r.success, true);
    assert.equal(r.clicked.tag, 'button');
  });

  it('test_click_smoke_notFound', async () => {
    installCdpMocks({ evaluate: async () => ({ found: false }) });
    await assert.rejects(ui.click({ by: 'text', value: 'Ghost' }), /No matching element/);
  });

  it('test_openPanel_smoke_bottomPanel', async () => {
    installCdpMocks({ evaluate: async () => ({ was_open: false, performed: 'opened' }) });
    const r = await ui.openPanel({ panel: 'pine-editor', action: 'open' });
    assert.equal(r.success, true);
    assert.equal(r.performed, 'opened');
  });

  it('test_openPanel_smoke_sidePanel', async () => {
    installCdpMocks({ evaluate: async () => ({ was_open: true, performed: 'closed' }) });
    const r = await ui.openPanel({ panel: 'watchlist', action: 'toggle' });
    assert.equal(r.success, true);
    assert.equal(r.performed, 'closed');
  });

  it('test_fullscreen_smoke', async () => {
    installCdpMocks({ evaluate: async () => ({ found: true }) });
    const r = await ui.fullscreen();
    assert.equal(r.success, true);
    assert.equal(r.action, 'fullscreen_toggled');
  });

  it('test_layoutList_smoke', async () => {
    installCdpMocks({
      evaluateAsync: async () => ({
        layouts: [{ id: 'L1', name: 'Day Trading', symbol: 'AAPL', resolution: '5' }],
        source: 'internal_api',
      }),
    });
    const r = await ui.layoutList();
    assert.equal(r.success, true);
    assert.equal(r.layout_count, 1);
    assert.equal(r.layouts[0].name, 'Day Trading');
  });

  it('test_layoutSwitch_smoke_no_dialog', async () => {
    installCdpMocks({
      evaluateAsync: async () => ({ success: true, method: 'loadChartFromServer', id: 'L1', name: 'Day Trading' }),
      evaluate: async () => ({ present: false }),   // no unsaved-changes dialog
    });
    const r = await ui.layoutSwitch({ name: 'Day Trading' });
    assert.equal(r.success, true);
    assert.equal(r.layout, 'Day Trading');
    assert.equal(r.action, 'switched');
    assert.equal(r.discarded_unsaved_changes, false);
  });

  it('test_layoutSwitch_smoke_blocked_by_unsaved_dialog', async () => {
    installCdpMocks({
      evaluateAsync: async () => ({ success: true, method: 'loadChartFromServer', id: 'L1', name: 'Day Trading' }),
      evaluate: async () => ({ present: true, button_text: 'Open anyway' }),
    });
    const r = await ui.layoutSwitch({ name: 'Day Trading' });
    assert.equal(r.success, false);
    assert.equal(r.unsaved_dialog_present, true);
    assert.equal(r.blocking_button_text, 'Open anyway');
    assert.match(r.error, /discard_unsaved/);
  });

  it('test_layoutSwitch_smoke_discard_opt_in', async () => {
    installCdpMocks({
      evaluateAsync: async () => ({ success: true, method: 'loadChartFromServer', id: 'L1', name: 'Day Trading' }),
      evaluate: async () => ({ present: true, button_text: 'Discard' }),
    });
    const r = await ui.layoutSwitch({ name: 'Day Trading', discard_unsaved: true });
    assert.equal(r.success, true);
    assert.equal(r.discarded_unsaved_changes, true);
  });

  it('test_keyboard_smoke', async () => {
    installCdpMocks({ getClient: async () => fakeCdpClient() });
    const r = await ui.keyboard({ key: 'Enter', modifiers: ['ctrl'] });
    assert.equal(r.success, true);
    assert.deepEqual(r.modifiers, ['ctrl']);
  });

  it('test_typeText_smoke', async () => {
    installCdpMocks({ getClient: async () => fakeCdpClient() });
    const r = await ui.typeText({ text: 'hello' });
    assert.equal(r.success, true);
    assert.equal(r.typed, 'hello');
    assert.equal(r.length, 5);
  });

  it('test_hover_smoke', async () => {
    installCdpMocks({
      getClient: async () => fakeCdpClient(),
      evaluate: async () => ({ x: 100, y: 200, tag: 'button' }),
    });
    const r = await ui.hover({ by: 'aria-label', value: 'Save' });
    assert.equal(r.success, true);
    assert.equal(r.hovered.x, 100);
  });

  it('test_scroll_smoke', async () => {
    installCdpMocks({
      getClient: async () => fakeCdpClient(),
      evaluate: async () => ({ x: 600, y: 400 }),
    });
    const r = await ui.scroll({ direction: 'down', amount: 200 });
    assert.equal(r.success, true);
    assert.equal(r.direction, 'down');
    assert.equal(r.amount, 200);
  });

  it('test_mouseClick_smoke_singleClick', async () => {
    installCdpMocks({ getClient: async () => fakeCdpClient() });
    const r = await ui.mouseClick({ x: 100, y: 200 });
    assert.equal(r.success, true);
    assert.equal(r.button, 'left');
    assert.equal(r.double_click, false);
  });

  it('test_mouseClick_smoke_doubleClick', async () => {
    installCdpMocks({ getClient: async () => fakeCdpClient() });
    const r = await ui.mouseClick({ x: 100, y: 200, button: 'right', double_click: true });
    assert.equal(r.button, 'right');
    assert.equal(r.double_click, true);
  });

  it('test_findElement_smoke_css', async () => {
    installCdpMocks({
      evaluate: async () => ({
        dpr: 1.25,
        elements: [
          { tag: 'button', text: 'Save', aria_label: null, data_name: 'save', x: 0, y: 0, width: 80, height: 32, device_x: 50, device_y: 20, visible: true },
        ],
      }),
    });
    const r = await ui.findElement({ query: 'button', strategy: 'css' });
    assert.equal(r.success, true);
    assert.equal(r.count, 1);
    assert.equal(r.device_pixel_ratio, 1.25, 'dpr surfaced for callers');
    assert.equal(r.elements[0].device_x, 50, 'device_x exposed');
  });

  it('test_findElement_smoke_text', async () => {
    installCdpMocks({
      evaluate: async () => ({
        dpr: 1,
        elements: [
          { tag: 'span', text: 'Alerts', aria_label: null, data_name: null, x: 100, y: 100, width: 50, height: 20, device_x: 125, device_y: 110, visible: true },
        ],
      }),
    });
    const r = await ui.findElement({ query: 'Alerts' });
    assert.equal(r.strategy, 'text');
    assert.equal(r.count, 1);
    assert.equal(r.device_pixel_ratio, 1);
  });

  it('test_mouseClick_smoke_selector_path_scales_by_dpr', async () => {
    // selector path: getBoundingClientRect → CSS coords → multiply by dpr.
    // The test verifies the CDP dispatch is invoked at scaled coords.
    const dispatched = [];
    const fakeClient = {
      Input: {
        dispatchMouseEvent: async (args) => { dispatched.push(args); },
      },
      close: async () => {},
    };
    installCdpMocks({
      getClient: async () => fakeClient,
      evaluate: async () => ({
        found: true,
        visible: true,
        dpr: 1.5,
        cssX: 200,
        cssY: 100,
        cssW: 40,
        cssH: 30,
      }),
    });
    const r = await ui.mouseClick({ selector: 'button[aria-label="Bar replay"]' });
    assert.equal(r.success, true);
    // 200 * 1.5 = 300, 100 * 1.5 = 150
    assert.equal(r.x, 300);
    assert.equal(r.y, 150);
    assert.equal(r.resolved.dpr, 1.5);
    // 3 dispatches: mouseMoved + mousePressed + mouseReleased
    assert.equal(dispatched.length, 3);
    assert.equal(dispatched[0].x, 300);
    assert.equal(dispatched[1].y, 150);
  });

  it('test_mouseClick_smoke_selector_not_found_throws', async () => {
    installCdpMocks({
      getClient: async () => ({ Input: { dispatchMouseEvent: async () => {} }, close: async () => {} }),
      evaluate: async () => ({ found: false }),
    });
    await assert.rejects(
      ui.mouseClick({ selector: 'button[aria-label="Nope"]' }),
      /did not match/,
    );
  });

  it('test_mouseClick_smoke_raw_xy_path_unchanged', async () => {
    const dispatched = [];
    installCdpMocks({
      getClient: async () => ({
        Input: { dispatchMouseEvent: async (a) => { dispatched.push(a); } },
        close: async () => {},
      }),
    });
    const r = await ui.mouseClick({ x: 500, y: 250 });
    assert.equal(r.success, true);
    assert.equal(r.x, 500);
    assert.equal(r.y, 250);
    assert.equal(r.selector, undefined, 'no selector field on raw-xy path');
    assert.equal(dispatched[0].x, 500);
  });

  // uiEvaluate was removed in security PR #54 (the unrestricted-JS hole).
});
