/**
 * Shared zod validation helpers for MCP tool params.
 */
import { z } from 'zod';

// String-aware boolean for tool params. z.coerce.boolean() runs Boolean(v),
// so ANY non-empty string — including "false", "0", "no" — coerces to true.
// MCP clients and LLMs routinely send booleans as JSON strings, so a caller
// passing "false" to a default-true flag (or a destructive one like
// kill_existing) would silently get true. This parses the common string
// spellings; real booleans pass through untouched, and unrecognized strings
// fall through to z.boolean() which rejects them.
export const boolish = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const s = v.trim().toLowerCase();
  if (s === 'false' || s === '0' || s === 'no' || s === 'off' || s === '') return false;
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  return v;
}, z.boolean());
