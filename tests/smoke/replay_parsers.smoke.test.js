import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, parseFlexDate, parseSpeed, normalizeTimeframe, normalizeInterval } from '../../src/cli/replay_parsers.js';

// Anchor "now" for deterministic relative-date assertions.
const NOW = new Date('2026-05-17T12:00:00Z');

describe('cli/replay_parsers — smoke', () => {
  describe('parseTime', () => {
    it('parses HH:MM 24-hour', () => {
      assert.equal(parseTime('14:00'), '14:00');
      assert.equal(parseTime('09:30'), '09:30');
      assert.equal(parseTime('9:30'),  '09:30');
    });
    it('parses bare hour', () => {
      assert.equal(parseTime('14'), '14:00');
      assert.equal(parseTime('9'),  '09:00');
    });
    it('parses 4-digit compact', () => {
      assert.equal(parseTime('0930'), '09:30');
      assert.equal(parseTime('1400'), '14:00');
    });
    it('parses am/pm', () => {
      assert.equal(parseTime('2pm'),     '14:00');
      assert.equal(parseTime('2:30pm'),  '14:30');
      assert.equal(parseTime('12pm'),    '12:00');  // noon
      assert.equal(parseTime('12am'),    '00:00');  // midnight
      assert.equal(parseTime('11am'),    '11:00');
    });
    it('returns null for nonsense', () => {
      assert.equal(parseTime(''), null);
      assert.equal(parseTime('not-a-time'), null);
      assert.equal(parseTime(null), null);
    });
  });

  describe('parseFlexDate', () => {
    it('passes ISO date through unchanged', () => {
      assert.equal(parseFlexDate('2026-05-08'), '2026-05-08');
      assert.equal(parseFlexDate('2026-05-08T09:30:00-04:00'), '2026-05-08T09:30:00-04:00');
    });
    it('expands 8-digit YYYYMMDD', () => {
      assert.equal(parseFlexDate('20260508'), '2026-05-08');
    });
    it('expands 6-digit YYMMDD into 20XX', () => {
      assert.equal(parseFlexDate('260508'), '2026-05-08');
    });
    it('today / yesterday relative to NOW', () => {
      assert.equal(parseFlexDate('today', NOW), '2026-05-17');
      assert.equal(parseFlexDate('yesterday', NOW), '2026-05-16');
      assert.equal(parseFlexDate('TODAY', NOW), '2026-05-17');
    });
    it('relative -Nd / -Nw / -Nm', () => {
      assert.equal(parseFlexDate('-7d', NOW), '2026-05-10');
      assert.equal(parseFlexDate('-2w', NOW), '2026-05-03');
      assert.equal(parseFlexDate('-3m', NOW), '2026-02-17');
    });
    it('slash form with current year default', () => {
      assert.equal(parseFlexDate('5/8', NOW), '2026-05-08');
      assert.equal(parseFlexDate('05/08', NOW), '2026-05-08');
    });
    it('slash form with 2-digit year', () => {
      assert.equal(parseFlexDate('5/8/26', NOW), '2026-05-08');
    });
    it('slash form with 4-digit year', () => {
      assert.equal(parseFlexDate('5/8/2024', NOW), '2024-05-08');
    });
    it('slash form with time appended', () => {
      assert.equal(parseFlexDate('5/8 0930', NOW), '2026-05-08T09:30');
      assert.equal(parseFlexDate('5/8 2pm', NOW), '2026-05-08T14:00');
    });
    it('month name forms', () => {
      assert.equal(parseFlexDate('may 8', NOW), '2026-05-08');
      assert.equal(parseFlexDate('march 1', NOW), '2026-03-01');
      assert.equal(parseFlexDate('mar 1 2024', NOW), '2024-03-01');
      assert.equal(parseFlexDate('jan 15 14:00', NOW), '2026-01-15T14:00');
    });
    it('returns undefined for empty input', () => {
      assert.equal(parseFlexDate(''), undefined);
      assert.equal(parseFlexDate(null), undefined);
    });
    it('rejects boolean input (regression: CLI shield drops -7d after -d)', () => {
      // When `tv replay start -d -7d` runs, the router's negative-positional
      // shield inserts `--` before -7d, so opts.date becomes `true`. The
      // handler falls back to positionals[0] only if parseFlexDate doesn't
      // claim a value for `true`.
      assert.equal(parseFlexDate(true), undefined);
      assert.equal(parseFlexDate(false), undefined);
    });
    it('falls through unknown formats to TV/Date()', () => {
      // anything not matching becomes a pass-through
      assert.equal(parseFlexDate('next tuesday', NOW), 'next tuesday');
    });
  });

  describe('parseSpeed', () => {
    it('maps multipliers to ms delays', () => {
      assert.equal(parseSpeed('1x'),  1000);
      assert.equal(parseSpeed('3x'),  300);
      assert.equal(parseSpeed('5x'),  200);
      assert.equal(parseSpeed('10x'), 100);
      assert.equal(parseSpeed('0.5x'), 2000);
    });
    it('passes raw ms through', () => {
      assert.equal(parseSpeed('100'), 100);
      assert.equal(parseSpeed('2500'), 2500);
    });
    it('rejects invalid speed', () => {
      assert.throws(() => parseSpeed('fast'), /Invalid speed/);
      assert.throws(() => parseSpeed('0'), /Invalid speed/);
      assert.throws(() => parseSpeed('-100'), /Invalid speed/);
    });
    it('returns undefined for empty', () => {
      assert.equal(parseSpeed(undefined), undefined);
      assert.equal(parseSpeed(''), undefined);
    });
  });

  describe('normalizeTimeframe', () => {
    it('strips m suffix for minute TFs', () => {
      assert.equal(normalizeTimeframe('1m'), '1');
      assert.equal(normalizeTimeframe('5m'), '5');
      assert.equal(normalizeTimeframe('15M'), '15');
    });
    it('converts h to minutes', () => {
      assert.equal(normalizeTimeframe('1h'), '60');
      assert.equal(normalizeTimeframe('4h'), '240');
    });
    it('maps d/w/M to TV codes', () => {
      assert.equal(normalizeTimeframe('1d'), 'D');
      assert.equal(normalizeTimeframe('D'), 'D');
      assert.equal(normalizeTimeframe('1w'), 'W');
      assert.equal(normalizeTimeframe('w'), 'W');
      assert.equal(normalizeTimeframe('1M'), 'M');
    });
    it('passes bare numbers through', () => {
      assert.equal(normalizeTimeframe('60'), '60');
      assert.equal(normalizeTimeframe('5'), '5');
    });
    it('returns undefined for empty', () => {
      assert.equal(normalizeTimeframe(undefined), undefined);
      assert.equal(normalizeTimeframe(''), undefined);
    });
  });

  describe('normalizeInterval', () => {
    it('maps aliases to TV-native codes', () => {
      assert.equal(normalizeInterval('chart'), 'auto');
      assert.equal(normalizeInterval('1t'), '1T');
      assert.equal(normalizeInterval('tick'), '1T');
      assert.equal(normalizeInterval('1s'), '1S');
    });
    it('passes TV-native codes through', () => {
      assert.equal(normalizeInterval('1T'), '1T');
      assert.equal(normalizeInterval('5'), '5');
      assert.equal(normalizeInterval('auto'), 'auto');
    });
    it('returns undefined for empty', () => {
      assert.equal(normalizeInterval(undefined), undefined);
      assert.equal(normalizeInterval(''), undefined);
    });
  });
});
