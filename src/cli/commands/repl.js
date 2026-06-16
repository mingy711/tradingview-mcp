import readline from 'node:readline';
import { register, runOnce } from '../router.js';

/**
 * Split a command line into argv-style tokens. Respects double and
 * single quotes (with escapes), and the `tv` prefix is stripped so users
 * can paste either `state` or `tv state` interchangeably.
 *
 * Not a full shell parser — no env-var expansion, no globbing, no
 * backtick subshells. The REPL is for piping tv commands at high
 * throughput, not running arbitrary shell.
 */
export function parseShellLine(line) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '\\' && i + 1 < line.length) { cur += line[++i]; continue; }
      if (c === q) { q = null; continue; }
      cur += c;
    } else {
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === ' ' || c === '\t') { if (cur) { out.push(cur); cur = ''; } continue; }
      cur += c;
    }
  }
  if (cur) out.push(cur);
  if (out[0] === 'tv') out.shift(); // tolerate the `tv` prefix
  return out;
}

register('repl', {
  description: 'Persistent CDP session — read commands from stdin, write one JSON per line. Reuses a single CDP client across all commands (5-10× faster than spawning `node src/cli/index.js` per call). Use #-comments and blank lines freely; `exit` or EOF closes.',
  handler: async () => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr, // prompts/banners go to stderr so stdout stays clean JSON-per-line
      terminal: false,
    });
    process.stderr.write('tv repl ready — one command per line, `exit` or Ctrl+D to quit\n');

    let count = 0;
    let okCount = 0;
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (line === 'exit' || line === 'quit') break;
      count++;
      const startedAt = Date.now();
      try {
        const args = parseShellLine(line);
        if (args.length === 0) continue;
        const result = await runOnce(args);
        // Stamp elapsed_ms so callers can spot slow commands without
        // wrapping each line in `time`.
        const out = (result && typeof result === 'object' && !Array.isArray(result))
          ? { ...result, elapsed_ms: Date.now() - startedAt }
          : { result, elapsed_ms: Date.now() - startedAt };
        console.log(JSON.stringify(out));
        if (out.success !== false) okCount++;
      } catch (err) {
        console.log(JSON.stringify({
          success: false,
          error: err.message || String(err),
          elapsed_ms: Date.now() - startedAt,
        }));
      }
    }
    return { success: true, action: 'repl_closed', commands_processed: count, ok_count: okCount };
  },
});
