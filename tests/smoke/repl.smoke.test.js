/**
 * Smoke tests — src/cli/commands/repl.js parseShellLine + runOnce reuse.
 *
 * Note: the REPL itself reads from stdin and is harder to unit-test;
 * we cover parseShellLine + a runOnce roundtrip via an end-to-end CLI
 * subprocess test in tests/cli.test.js if needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseShellLine } from '../../src/cli/commands/repl.js';

describe('cli/commands/repl.js — parseShellLine', () => {
  it('splits plain whitespace', () => {
    assert.deepEqual(parseShellLine('state'), ['state']);
    assert.deepEqual(parseShellLine('replay start --date 2026-05-08'), ['replay', 'start', '--date', '2026-05-08']);
  });

  it('respects double-quoted strings with spaces', () => {
    assert.deepEqual(
      parseShellLine('symbol "CME_MINI:NQM2026"'),
      ['symbol', 'CME_MINI:NQM2026'],
    );
    assert.deepEqual(
      parseShellLine('replay start --date "2026-05-08T13:33:00Z"'),
      ['replay', 'start', '--date', '2026-05-08T13:33:00Z'],
    );
  });

  it('respects single-quoted strings (for JSON inputs)', () => {
    assert.deepEqual(
      parseShellLine("indicator set abc -i '{\"length\": 20}'"),
      ['indicator', 'set', 'abc', '-i', '{"length": 20}'],
    );
  });

  it('preserves escaped chars inside quotes', () => {
    assert.deepEqual(
      parseShellLine('symbol "he said \\"hi\\""'),
      ['symbol', 'he said "hi"'],
    );
  });

  it('strips a leading "tv" prefix so callers can paste either form', () => {
    assert.deepEqual(parseShellLine('tv state'), ['state']);
    assert.deepEqual(parseShellLine('tv replay start --date 2026-05-08'), ['replay', 'start', '--date', '2026-05-08']);
    // Doesn't strip "tv" mid-line — only the first token.
    assert.deepEqual(parseShellLine('indicator add "tv"'), ['indicator', 'add', 'tv']);
  });

  it('returns empty array on blank input', () => {
    assert.deepEqual(parseShellLine(''), []);
    assert.deepEqual(parseShellLine('   '), []);
  });

  it('handles tabs and multiple spaces', () => {
    assert.deepEqual(parseShellLine('replay\tstart  --date 2026-05-08'), ['replay', 'start', '--date', '2026-05-08']);
  });

  it('preserves leading-hyphen positional arg (router shields later)', () => {
    // parseShellLine just tokenizes; the router shields -4 with `--` later.
    assert.deepEqual(
      parseShellLine('indicator add "-4 CB Model Indicator"'),
      ['indicator', 'add', '-4 CB Model Indicator'],
    );
  });
});
