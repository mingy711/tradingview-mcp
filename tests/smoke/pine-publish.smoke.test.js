import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { installCdpMocks, resetCdpMocks, cleanupConnection } from '../helpers/mock-cdp.js';
import { publishDialogInspect } from '../../src/core/pine-publish.js';

describe('core/pine-publish.js — smoke', () => {
  after(async () => { resetCdpMocks(); await cleanupConnection(); });

  it('returns error when Publish button not found', async () => {
    let n = 0;
    installCdpMocks({
      evaluate: async () => {
        n++;
        if (n === 1) return true;       // PINE_EDITOR_DIALOG_PRESENT
        if (n === 2) return true;       // MONACO_PINE_EDITOR_AVAILABLE
        if (n === 3) return { clicked: false };  // publish button probe
        return null;
      },
    });
    const r = await publishDialogInspect();
    assert.equal(r.success, false);
    assert.match(r.error, /Publish Script button not found/);
  });

  it('returns error when dialog does not appear after click', async () => {
    let n = 0;
    installCdpMocks({
      evaluate: async () => {
        n++;
        if (n === 1) return true;
        if (n === 2) return true;
        if (n === 3) return { clicked: true, text: 'Publish script', aria: null, data_name: null };
        return { dialog_found: false };
      },
    });
    const r = await publishDialogInspect();
    assert.equal(r.success, false);
    assert.match(r.error, /no dialog appeared/);
    assert.equal(r.button_clicked.text, 'Publish script');
  });

  it('returns full dialog dump on happy path', async () => {
    let n = 0;
    installCdpMocks({
      evaluate: async () => {
        n++;
        if (n === 1) return true;
        if (n === 2) return true;
        if (n === 3) return { clicked: true, text: 'Publish script', aria: 'Publish script', data_name: null };
        return {
          dialog_found: true,
          dialog_class: 'publish-dialog-x9',
          dialog_role: 'dialog',
          inputs: [
            { tag: 'input', type: 'text', placeholder: 'Title', class: 'title-input-x', value_preview: '' },
            { tag: 'textarea', type: 'textarea', class: 'desc-x', value_preview: '' },
          ],
          buttons: [
            { text: 'Continue', class: 'btn-x', disabled: false },
            { text: 'Cancel', class: 'btn-y', disabled: false },
          ],
          radios_or_checkboxes: [
            { type: 'radio', name: 'visibility', value: 'open', label_text: 'Open', checked: false },
          ],
          headings: ['Publish script'],
          editor_containers: [],
        };
      },
    });
    const r = await publishDialogInspect();
    assert.equal(r.success, true);
    assert.equal(r.dialog_found, true);
    assert.equal(r.inputs.length, 2);
    assert.equal(r.buttons[0].text, 'Continue');
    assert.equal(r.radios_or_checkboxes[0].label_text, 'Open');
    assert.deepEqual(r.headings, ['Publish script']);
  });
});
