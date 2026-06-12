import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/pine-deploy.js';

export function registerPineDeployTools(server) {
  server.tool(
    'pine_deploy',
    'PREFERRED PATH for deploying Pine Script from a file on disk. One-shot replacement for pine_set_source + pine_save + pine_smart_compile. File-based: source is NEVER embedded in the tool call, so big Pine files (50–100 KB) carry no token tax. Auto-derives the indicator/strategy title from the source to pre-clean any prior instance from the chart BEFORE adding the new one — prevents the TV duplicate-instance build-up. Pass clean_match="" to disable pre-clean.',
    {
      pine_path: z.string().describe('Absolute path to a .pine file on disk'),
      clean_match: z.string().optional().describe('Title substring (case-insensitive) of prior chart studies to remove BEFORE deploy. Omit to auto-derive from indicator()/strategy() title; pass "" to skip pre-clean entirely.'),
    },
    async ({ pine_path, clean_match }) => {
      try {
        // empty string from caller = explicit opt-out; null = auto-derive
        const cleanMatch = clean_match === '' ? null : clean_match;
        return jsonResult(await core.deployScript({ pinePath: pine_path, cleanMatch }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
