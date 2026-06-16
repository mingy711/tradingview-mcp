import { register } from '../router.js';
import * as core from '../../core/pine.js';
import * as deployCore from '../../core/pine-deploy.js';
import * as publishCore from '../../core/pine-publish.js';
import { readFileSync } from 'fs';

async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

register('pine', {
  description: 'Pine Script tools',
  subcommands: new Map([
    ['get', {
      description: 'Get current Pine Script source from editor',
      handler: () => core.getSource(),
    }],
    ['set', {
      description: 'Set Pine Script source (reads stdin or --file)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.setSource({ source });
      },
    }],
    ['compile', {
      description: 'Smart compile: detect button, compile, check errors',
      handler: () => core.smartCompile(),
    }],
    ['raw-compile', {
      description: 'Click compile/add button without smart detection',
      handler: () => core.compile(),
    }],
    ['analyze', {
      description: 'Offline static analysis (no TradingView needed)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.analyze({ source });
      },
    }],
    ['check', {
      description: 'Server-side compile check (no chart needed)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.check({ source });
      },
    }],
    ['save', {
      description: 'Save the current Pine Script (Ctrl+S)',
      handler: () => core.save(),
    }],
    ['new', {
      description: 'Create a new blank Pine Script (indicator, strategy, library)',
      handler: (opts, positionals) => {
        const type = positionals[0] || 'indicator';
        return core.newScript({ type });
      },
    }],
    ['open', {
      description: 'Open a saved Pine Script by name (or --id USER;hash)',
      options: {
        id: { type: 'string', description: 'Script ID (USER;hash) from pine list — bypasses name lookup' },
      },
      handler: (opts, positionals) => {
        if (opts.id) return core.openScript({ id: opts.id });
        if (!positionals[0]) throw new Error('Script name required. Usage: tv pine open "My Script" OR tv pine open --id USER;hash');
        return core.openScript({ name: positionals.join(' ') });
      },
    }],
    ['switch', {
      description: 'Switch the Pine editor to a different saved script via the title-button dropdown (UI path). Unlike pine open which fetches source from pine-facade, this navigates the editor itself to the saved script.',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Script name required. Usage: tv pine switch "My Script"');
        return core.switchScript({ name: positionals.join(' ') });
      },
    }],
    ['list', {
      description: 'List saved Pine Scripts',
      handler: () => core.listScripts(),
    }],
    ['deploy', {
      description: 'File-based atomic deploy: read .pine → set source → save → Add to chart, with auto pre-clean of prior instance',
      options: {
        file: { type: 'string', short: 'f', description: '.pine file path (required)' },
        'clean-match': { type: 'string', description: 'Title substring to remove from chart before deploy. Omit = auto-derive from indicator()/strategy() title. Pass empty "" to skip pre-clean.' },
      },
      handler: (opts) => {
        if (!opts.file) throw new Error('--file is required. Usage: tv pine deploy --file my.pine');
        const cleanMatch = opts['clean-match'] === '' ? null : opts['clean-match'];
        return deployCore.deployScript({ pinePath: opts.file, cleanMatch });
      },
    }],
    ['publish-inspect', {
      description: 'Probe Pine "Publish script" dialog: click publish button + dump dialog inputs/buttons/labels (read-only, no submission)',
      handler: () => publishCore.publishDialogInspect(),
    }],
    ['errors', {
      description: 'Get Pine Script compilation errors',
      handler: () => core.getErrors(),
    }],
    ['console', {
      description: 'Get Pine Script console/log output',
      handler: () => core.getConsole(),
    }],
  ]),
});
