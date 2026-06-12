import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { installCdpMocks, resetCdpMocks, cleanupConnection } from '../helpers/mock-cdp.js';
import * as strategy from '../../src/core/strategy.js';

describe('core/strategy.js — smoke', () => {
  after(async () => { resetCdpMocks(); await cleanupConnection(); });

  it('test_setDeepBacktestRange_smoke_validates_ymd', async () => {
    await assert.rejects(
      () => strategy.setDeepBacktestRange({ from: '2024-1-1', to: '2024-12-31' }),
      /YYYY-MM-DD/,
    );
    await assert.rejects(
      () => strategy.setDeepBacktestRange({ from: '2024-01-01', to: 'tomorrow' }),
      /YYYY-MM-DD/,
    );
  });

  it('test_setDeepBacktestRange_smoke_fails_when_picker_button_missing', async () => {
    installCdpMocks({
      evaluate: async () => ({ ok: false, error: 'date range button not found in strategy tester' }),
    });
    const r = await strategy.setDeepBacktestRange({ from: '2024-01-01', to: '2024-12-31' });
    assert.equal(r.success, false);
    assert.match(r.error, /date range button not found/);
  });

  it('test_setDeepBacktestRange_smoke_modal_input_timeout', async () => {
    let n = 0;
    installCdpMocks({
      evaluate: async () => {
        n++;
        if (n === 1) return { ok: true, text: '2024-01-01 — 2024-06-30' };
        return 0;  // never reaches 2 visible inputs
      },
    });
    const r = await strategy.setDeepBacktestRange({ from: '2024-01-01', to: '2024-12-31' });
    assert.equal(r.success, false);
    assert.match(r.error, /modal did not open/);
  });

  it('test_setDeepBacktestRange_smoke_happy_path', async () => {
    let n = 0;
    installCdpMocks({
      evaluate: async () => {
        n++;
        if (n === 1) return { ok: true, text: '2023-01-01 — 2023-06-30' };  // picker open
        if (n === 2) return 2;                                                // inputs-mounted probe
        if (n === 3) return { ok: true, set_from: '2024-01-01', set_to: '2024-12-31', modal_found: true };  // fill
        if (n === 4) return { ready: true, text: 'Select' };                  // submit-enable probe
        if (n === 5) return { ok: true, set_from: '2024-01-01', button: 'Select' };  // click
        return { displayed: '2024-01-01 — 2024-12-31' };                      // verify
      },
    });
    const r = await strategy.setDeepBacktestRange({ from: '2024-01-01', to: '2024-12-31' });
    assert.equal(r.success, true);
    assert.equal(r.set_inputs.from, '2024-01-01');
    assert.equal(r.set_inputs.to, '2024-12-31');
    assert.equal(r.submit_button, 'Select');
    assert.match(r.displayed, /2024-01-01/);
  });

  it('test_setDeepBacktestRange_smoke_submit_disabled', async () => {
    let n = 0;
    installCdpMocks({
      evaluate: async () => {
        n++;
        if (n === 1) return { ok: true };                                                // picker open
        if (n === 2) return 2;                                                           // inputs-mounted probe
        if (n === 3) return { ok: true, set_from: '2024-01-01', set_to: '2024-12-31', modal_found: true };  // fill
        return { ready: false, error: 'submit button never enabled (date range may be invalid)' };          // 20 polls all disabled
      },
    });
    const r = await strategy.setDeepBacktestRange({ from: '2024-01-01', to: '2024-12-31' });
    assert.equal(r.success, false);
    assert.match(r.error, /never enabled|disabled/);
  });
});
