import { register } from '../router.js';
import * as core from '../../core/tab.js';

register('tab', {
  description: 'Tab management (list, new, close, switch)',
  subcommands: new Map([
    ['list', {
      description: 'List all open chart tabs',
      handler: () => core.list(),
    }],
    ['new', {
      description: 'Open a new chart tab (lands on layout picker — pick layout in TV to complete)',
      handler: () => core.newTab(),
    }],
    ['close', {
      description: 'Close a tab via CDP. Defaults to current attached tab; pass --id to target a specific tab.',
      options: {
        id: { type: 'string', description: 'CDP target id of the tab to close (from tab list or tab new picker_tab_id)' },
      },
      handler: (opts) => core.closeTab({ id: opts.id }),
    }],
    ['switch', {
      description: 'Switch to a tab by index',
      handler: (opts, positionals) => {
        if (positionals[0] === undefined) throw new Error('Index required. Usage: tv tab switch 0');
        return core.switchTab({ index: positionals[0] });
      },
    }],
  ]),
});
