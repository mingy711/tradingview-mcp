import { jsonResult } from './_format.js';
import * as core from '../core/pine-publish.js';

export function registerPinePublishTools(server) {
  server.tool(
    'pine_publish_dialog_inspect',
    'READ-ONLY probe for the Pine Editor "Publish script" dialog. Clicks the publish toolbar button, waits 1.5s, then dumps every input/button/radio/checkbox/heading/editor-container in the resulting dialog with full class names + label text. Use this to discover per-TV-build selectors + locale labels before wiring an active publish flow. Does NOT submit anything.',
    {},
    async () => {
      try { return jsonResult(await core.publishDialogInspect()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
