/**
 * Flexible input parsers for `tv replay start`. Pure functions, exported
 * for unit tests + reuse from the (smaller) MCP-side handler.
 *
 * Sourced from KarmicP fork. We keep the rich format set because the
 * NQ historical-replay workflow burns a lot of `replay start --date`
 * calls; one missed format = one CLI restart.
 */

/**
 * Parse a single time string. Accepts:
 *   "14:00", "14:30", "9:30"     → "14:00" / "14:30" / "09:30"
 *   "2pm", "2:30pm", "14"        → "14:00" / "14:30" / "14:00"
 *   "0930" (4-digit)             → "09:30"
 * Returns null if it doesn't match (caller can choose to fall back).
 */
export function parseTime(str) {
  if (!str || !String(str).trim()) return null;
  const s = String(str).trim();
  const mil = s.match(/^(\d{1,2}):(\d{2})$/);
  if (mil) return `${mil[1].padStart(2, '0')}:${mil[2]}`;
  const ampm = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = ampm[2] || '00';
    if (ampm[3].toLowerCase() === 'pm' && h < 12) h += 12;
    if (ampm[3].toLowerCase() === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }
  if (/^\d{4}$/.test(s)) return `${s.slice(0, 2)}:${s.slice(2)}`;
  if (/^\d{1,2}$/.test(s)) return `${s.padStart(2, '0')}:00`;
  return null;
}

/**
 * Parse a date (with optional inline time) into a string TradingView's
 * `new Date(...).getTime()` will happily parse. Accepts:
 *   "2026-05-08"                        ISO date
 *   "2026-05-08T09:30:00-04:00"         ISO with TZ (pass-through)
 *   "20260508"                          8-digit YYYYMMDD
 *   "260508"                            6-digit YYMMDD
 *   "5/8", "5/8/2026", "5/8 2pm"        slash form
 *   "may 8", "may 8 14:00"              month name
 *   "today" / "yesterday"               relative
 *   "-7d" / "-2w" / "-1m"               relative offset
 * Returns the input string if no rule matches (let Date() try).
 * Pass `now` for deterministic testing.
 */
export function parseFlexDate(input, now = new Date()) {
  if (input == null || input === '') return undefined;
  // Reject booleans (a CLI flag without a value lands here as `true` when
  // the shield separated the next arg). Numbers are accepted (epoch ms).
  if (typeof input === 'boolean') return undefined;
  const s = String(input).trim();
  if (!s) return undefined;

  // Already ISO-like (with or without time) — pass through.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;

  // 8-digit YYYYMMDD
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

  // 6-digit YYMMDD (assume 2000s)
  if (/^\d{6}$/.test(s)) return `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`;

  if (/^today$/i.test(s)) return now.toISOString().slice(0, 10);
  if (/^yesterday$/i.test(s)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  // Relative: "-7d", "-2w", "-1m"
  const rel = s.match(/^-(\d+)([dwm])$/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const d = new Date(now);
    if (unit === 'd') d.setDate(d.getDate() - n);
    else if (unit === 'w') d.setDate(d.getDate() - n * 7);
    else if (unit === 'm') d.setMonth(d.getMonth() - n);
    return d.toISOString().slice(0, 10);
  }

  // Slash form: "5/8", "5/8/2026", "5/8 2pm", "05/08/26 14:00"
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*(.*)?$/);
  if (slash) {
    const month = slash[1].padStart(2, '0');
    const day = slash[2].padStart(2, '0');
    const year = slash[3]
      ? (slash[3].length === 2 ? '20' + slash[3] : slash[3])
      : String(now.getFullYear());
    const time = parseTime(slash[4]);
    return time ? `${year}-${month}-${day}T${time}` : `${year}-${month}-${day}`;
  }

  // Month name: "mar 1", "march 1 14:00", "may 8 2pm"
  const months = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
  const mon = s.match(/^([a-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?\s*(.*)?$/i);
  if (mon) {
    const mm = months[mon[1].toLowerCase().slice(0, 3)];
    if (mm) {
      const day = mon[2].padStart(2, '0');
      const year = mon[3] || String(now.getFullYear());
      const time = parseTime(mon[4]);
      return time ? `${year}-${mm}-${day}T${time}` : `${year}-${mm}-${day}`;
    }
  }

  return s;
}

/**
 * Speed multipliers → autoplay delay (ms). Lower delay = faster.
 * Raw ms passthrough also accepted (e.g. "200").
 */
const SPEED_MAP = {
  '10x': 100, '7x': 143, '5x': 200, '3x': 300,
  '1x': 1000, '0.5x': 2000, '0.3x': 3000, '0.2x': 5000, '0.1x': 10000,
};
export function parseSpeed(str) {
  if (!str) return undefined;
  const s = String(str).trim().toLowerCase();
  if (SPEED_MAP[s] !== undefined) return SPEED_MAP[s];
  const n = Number(s);
  if (!isNaN(n) && n > 0) return n;
  throw new Error(`Invalid speed "${str}". Use: ${Object.keys(SPEED_MAP).join(', ')} (or raw ms 100-10000).`);
}

/**
 * Timeframe alias normalization. "1m"→"1", "1h"→"60", "1d"→"D", "1w"→"W".
 * Bare numbers and TV-native strings pass through unchanged.
 */
export function normalizeTimeframe(tf) {
  if (!tf) return undefined;
  const s = String(tf).trim();
  // Month check FIRST (case-sensitive uppercase M) to beat the
  // minute rule, which would otherwise swallow "1M" because case-
  // insensitive m matches M.
  if (/^1?M$/.test(s)) return 'M';
  if (/^\d+m$/.test(s)) return s.replace(/m$/, '');
  if (/^\d+m$/i.test(s)) return s.replace(/m$/i, '');  // accept "15M" as minutes too
  if (/^\d+h$/i.test(s)) return String(parseInt(s, 10) * 60);
  if (/^1?d$/i.test(s)) return 'D';
  if (/^1?w$/i.test(s)) return 'W';
  return s;
}

/**
 * Replay update-interval (tick resolution): "1s"/"1t"/"chart" aliases plus
 * raw TV strings ("1", "5", "1T", "1S", "auto").
 */
export function normalizeInterval(str) {
  if (!str) return undefined;
  const s = String(str).trim().toLowerCase();
  const alias = { chart: 'auto', tick: '1T', '1t': '1T', '1s': '1S' };
  return alias[s] || String(str).trim();
}
