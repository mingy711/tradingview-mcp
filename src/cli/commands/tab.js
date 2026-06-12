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
    ['pin', {
      description: 'Pin MCP to one tab (cross-instance, claims a slot in ~/.tv-mcp-registry.json). Pass exactly one of --id/--title/--symbol/--url.',
      options: {
        id:     { type: 'string', description: 'Exact CDP target id' },
        title:  { type: 'string', description: 'Substring of tab title' },
        symbol: { type: 'string', short: 's', description: 'Substring of chart symbol' },
        url:    { type: 'string', short: 'u', description: 'Substring of tab URL' },
        force:  { type: 'boolean', description: 'Take over an existing claim from another process' },
      },
      handler: (opts) => core.pin({ id: opts.id, title: opts.title, symbol: opts.symbol, url: opts.url, force: opts.force }),
    }],
    ['unpin', {
      description: 'Clear the tab pin and release the registry claim',
      handler: () => core.unpin(),
    }],
    ['registry', {
      description: 'Show cross-instance pin registry (every tab claimed by any live tradingview-mcp process)',
      handler: () => core.registryList(),
    }],
  ]),
});
