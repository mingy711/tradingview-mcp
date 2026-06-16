import { register } from '../router.js';
import * as core from '../../core/replay.js';
import * as chartCore from '../../core/chart.js';
import * as tabCore from '../../core/tab.js';
import * as uiCore from '../../core/ui.js';
import { parseFlexDate, parseTime, parseSpeed, normalizeTimeframe, normalizeInterval } from '../replay_parsers.js';

/**
 * Find a chart tab whose title contains `symbol` (case-insensitive). Returns
 * the matched tab descriptor after switching to it, or null when there's
 * only one tab (nothing to switch).
 *
 * Errors if `symbol` is set but no tab matches — replay must run on the
 * intended chart; silently picking the wrong tab is worse than failing fast.
 */
async function switchToChart(symbol) {
  if (!symbol) return null;
  const { tabs } = await tabCore.list();
  if (!tabs || tabs.length <= 1) return null;
  const q = symbol.toLowerCase();
  const match = tabs.find(t => (t.title || '').toLowerCase().includes(q));
  if (!match) {
    throw new Error(`No tab matching "${symbol}". Open tabs: ${tabs.map(t => t.title).join(', ')}`);
  }
  await tabCore.switchTab({ index: match.index });
  await new Promise(r => setTimeout(r, 500));
  return match;
}

register('replay', {
  description: 'Replay mode controls',
  subcommands: new Map([
    ['start', {
      description: 'Start replay. Example: tv replay start -c ES -d 5/8 -H 0930 -tf 5m -s 3x',
      options: {
        // Setup (run before replay starts)
        layout:  { type: 'string', short: 'l', description: 'Load a saved layout before starting (graceful fallback to current chart)' },
        chart:   { type: 'string', short: 'c', description: 'Switch to tab whose title matches (e.g. "ES", "NVDA"); fails fast on mismatch' },
        tf:      { type: 'string',              description: 'Timeframe: 1m, 5m, 15m, 1h, 4h, D, W (or raw: 1, 5, 60)' },
        // Cursor target
        date:    { type: 'string', short: 'd', description: 'Date (or pos arg 1): 2026-05-08, 20260508, 260508, 5/8, "may 8", today, yesterday, -7d' },
        hour:    { type: 'string', short: 'H', description: 'Time (or pos arg 2): 0930, 9:30, 2pm, 14' },
        'scroll-back': { type: 'boolean', description: 'Pre-extend the bar buffer backward (force TV to load historical bars) before engaging replay. Use for jumps outside the current loaded range.' },
        // Pacing (run after replay starts)
        speed:    { type: 'string', short: 's', description: 'Autoplay speed: 1x, 3x, 5x, 7x, 10x (or raw ms)' },
        interval: { type: 'string', short: 'i', description: 'Update interval: 1s, 1t, 1, 5, chart/auto' },
      },
      handler: async (opts, positionals) => {
        // Positional fallback: `tv replay start 2026-05-08 0930`.
        // The router's negative-positional shield (`^-\d` → `--`) means a
        // leading-hyphen arg like `-7d` lands in positionals[0] AND opts.date
        // becomes `true` (boolean default for a value-less string flag).
        // Treat opts.date as set only when it's a real string.
        const dateFromOpt = typeof opts.date === 'string' ? opts.date : null;
        const hourFromOpt = typeof opts.hour === 'string' ? opts.hour : null;
        const rawDate = dateFromOpt ?? positionals[0];
        const rawHour = hourFromOpt ?? positionals[dateFromOpt != null ? 0 : 1];
        let date = parseFlexDate(rawDate);
        if (date && rawHour) {
          const t = parseTime(rawHour);
          if (t) date = `${date}T${t}`;
        }

        const results = {};

        // 1. Layout switch (graceful fallback to current chart on miss)
        if (opts.layout) {
          try {
            results.layout = await uiCore.layoutSwitch({ name: opts.layout });
            await new Promise(r => setTimeout(r, 1000));
          } catch (e) {
            results.layout_warning = `Layout "${opts.layout}" not found, using current chart. ${e.message}`;
          }
        }

        // 2. Tab switch (hard error on miss — don't replay on the wrong chart)
        if (opts.chart) {
          results.tab = await switchToChart(opts.chart);
        }

        // 3. Timeframe (before replay so the replay session uses it)
        if (opts.tf) {
          const tf = normalizeTimeframe(opts.tf);
          results.timeframe = await chartCore.setTimeframe({ timeframe: tf });
          await new Promise(r => setTimeout(r, 500));
        }

        // 4. The replay itself
        results.replay = await core.start({ date, scrollBack: opts['scroll-back'] });

        // 5. Pacing (after replay is up)
        if (opts.speed) {
          results.autoplay = await core.autoplay({ speed: parseSpeed(opts.speed) });
        }
        if (opts.interval) {
          results.resolution = await core.setResolution({ interval: normalizeInterval(opts.interval) });
        }

        return { success: true, ...results };
      },
    }],
    ['step', {
      description: 'Advance one bar in replay',
      handler: () => core.step(),
    }],
    ['stop', {
      description: 'Stop replay and return to realtime',
      handler: () => core.stop(),
    }],
    ['status', {
      description: 'Get current replay state',
      handler: () => core.status(),
    }],
    ['autoplay', {
      description: 'Toggle autoplay (-s accepts 1x/3x/5x/7x/10x or raw ms)',
      options: {
        speed: { type: 'string', short: 's', description: 'Autoplay speed: 1x..10x or raw ms (100..10000)' },
      },
      handler: (opts) => core.autoplay({ speed: opts.speed ? parseSpeed(opts.speed) : undefined }),
    }],
    ['resolution', {
      description: 'Set tick interval: 1s, 1t, 1, 5, chart/auto',
      options: {
        interval: { type: 'string', short: 'i', description: 'Update interval (1s/1t/chart/auto or TV-native 1/5/1S/1T)' },
      },
      handler: (opts, positionals) => {
        const raw = opts.interval ?? positionals[0];
        if (!raw) throw new Error('Interval required. Usage: tv replay resolution 1s');
        return core.setResolution({ interval: normalizeInterval(raw) });
      },
    }],
    ['trade', {
      description: 'Execute a trade in replay mode (buy, sell, close)',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Action required. Usage: tv replay trade buy');
        return core.trade({ action: positionals[0] });
      },
    }],
  ]),
});
