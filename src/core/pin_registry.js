/**
 * Cross-instance pin registry.
 *
 * Multiple Claude sessions can each run their own tradingview-mcp processes
 * against the same Chrome (port 9222). Pins are per-process; without
 * coordination two processes could claim the same tab and race on every
 * CDP call. This module records `{targetId → owner-pid}` in a shared JSON
 * file so `claim()` can refuse double-claims (or force-override with
 * explicit intent).
 *
 * Storage: ~/.tv-mcp-registry.json (overridable via TV_MCP_REGISTRY_PATH)
 * Locking: ~/.tv-mcp-registry.lock (exclusive O_CREAT, retry+backoff, stale-break)
 * Liveness: process.kill(pid, 0) — throws ESRCH for dead PIDs, entries pruned
 *           on every read.
 *
 * Ported verbatim from ogdeeeezy/tv-mcp (commit b3f7e9c, May 2026).
 */
import { readFileSync, writeFileSync, existsSync, renameSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';

const REGISTRY_PATH = process.env.TV_MCP_REGISTRY_PATH || join(homedir(), '.tv-mcp-registry.json');
const LOCK_PATH = REGISTRY_PATH + '.lock';
const LOCK_STALE_MS = 5000;
const LOCK_RETRY_MS = 25;
const LOCK_MAX_WAIT_MS = 2000;
const REGISTRY_VERSION = 1;

function isAlive(entryOrPid) {
  // Accepts the registry entry (preferred) or a raw pid. When passed an
  // entry, treats foreign-host entries as dead — PID recycling on a
  // different host (or registry sync via dotfiles) can otherwise make a
  // dead pin look live forever and block legitimate claims.
  const entry = typeof entryOrPid === 'object' && entryOrPid !== null ? entryOrPid : null;
  const pid = entry ? entry.pid : entryOrPid;
  if (!pid || typeof pid !== 'number') return false;
  if (entry && entry.host && entry.host !== hostname()) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

function emptyRegistry() { return { version: REGISTRY_VERSION, pins: {} }; }

function readRaw() {
  if (!existsSync(REGISTRY_PATH)) return emptyRegistry();
  let raw;
  try { raw = readFileSync(REGISTRY_PATH, 'utf8'); }
  catch { return emptyRegistry(); }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.pins) return emptyRegistry();
    return parsed;
  } catch (err) {
    // Corrupt JSON: snapshot the bad file so we don't silently overwrite
    // pins owned by other live processes. Without this, the next
    // writeAtomic() blows away everyone's entries on a partial write or
    // manual edit.
    try {
      const backup = `${REGISTRY_PATH}.corrupt.${Date.now()}`;
      writeFileSync(backup, raw);
      process.stderr.write(`tv-mcp pin-registry: corrupt JSON at ${REGISTRY_PATH} (${err.message}); backed up to ${backup}\n`);
    } catch {}
    return emptyRegistry();
  }
}

function writeAtomic(data) {
  const tmp = REGISTRY_PATH + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, REGISTRY_PATH);
}

async function acquireLock() {
  const start = Date.now();
  while (Date.now() - start < LOCK_MAX_WAIT_MS) {
    try { const fd = openSync(LOCK_PATH, 'wx'); closeSync(fd); return; }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const observedMtime = statSync(LOCK_PATH).mtimeMs;
        const age = Date.now() - observedMtime;
        if (age > LOCK_STALE_MS) {
          // Re-stat right before unlinking to avoid a race where two
          // processes both saw the same stale lock, both unlinked,
          // and then process A's freshly-created lock got deleted by
          // process B's late unlink. If mtime changed, someone else
          // already broke the stale lock (or refreshed it); back off
          // and retry the openSync instead of unlinking.
          let confirmedStale = false;
          try { confirmedStale = statSync(LOCK_PATH).mtimeMs === observedMtime; } catch {}
          if (confirmedStale) { try { unlinkSync(LOCK_PATH); } catch {} continue; }
        }
      } catch {}
      await new Promise(r => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  throw new Error(`Could not acquire pin-registry lock at ${LOCK_PATH} within ${LOCK_MAX_WAIT_MS}ms`);
}

function releaseLock() { try { unlinkSync(LOCK_PATH); } catch {} }

async function readAndPrune() {
  await acquireLock();
  try {
    const reg = readRaw();
    let mutated = false;
    for (const [tid, entry] of Object.entries(reg.pins)) {
      if (!isAlive(entry)) { delete reg.pins[tid]; mutated = true; }
    }
    if (mutated) writeAtomic(reg);
    return reg;
  } finally { releaseLock(); }
}

/**
 * Claim a target for this process. Throws with `err.code === 'PIN_CONFLICT'`
 * and `err.owner` populated if another live PID owns it (unless `force: true`).
 * On force, the prior owner is returned in `displaced` for telemetry.
 */
export async function claim(targetId, { force = false, lane = null } = {}) {
  if (!targetId) throw new Error('claim requires a targetId');
  await acquireLock();
  try {
    const reg = readRaw();
    for (const [tid, entry] of Object.entries(reg.pins)) {
      if (!isAlive(entry)) delete reg.pins[tid];
    }
    const existing = reg.pins[targetId];
    if (existing && existing.pid !== process.pid && !force) {
      const err = new Error(
        `Tab ${targetId} is already pinned by pid=${existing.pid} ` +
        `(lane=${existing.lane || 'unknown'}, host=${existing.host}, ` +
        `since ${new Date(existing.claimedAt).toISOString()}). ` +
        `Use force=true to override.`
      );
      err.code = 'PIN_CONFLICT';
      err.owner = existing;
      throw err;
    }
    const entry = {
      pid: process.pid,
      host: hostname(),
      lane: lane || process.env.TV_MCP_LANE || null,
      claimedAt: Date.now(),
    };
    const displaced = existing && existing.pid !== process.pid ? existing : null;
    reg.pins[targetId] = entry;
    writeAtomic(reg);
    return { entry, displaced };
  } finally { releaseLock(); }
}

/** Release a pin owned by this process (idempotent). */
export async function release(targetId) {
  if (!targetId) return { released: false };
  await acquireLock();
  try {
    const reg = readRaw();
    const existing = reg.pins[targetId];
    if (existing && existing.pid === process.pid) {
      delete reg.pins[targetId];
      writeAtomic(reg);
      return { released: true };
    }
    return { released: false };
  } finally { releaseLock(); }
}

/** Release every pin owned by this process. Called on process exit. */
export async function releaseAll() {
  await acquireLock();
  try {
    const reg = readRaw();
    let mutated = false;
    for (const [tid, entry] of Object.entries(reg.pins)) {
      if (entry?.pid === process.pid && entry?.host === hostname()) { delete reg.pins[tid]; mutated = true; }
    }
    if (mutated) writeAtomic(reg);
    return { released_count: Object.keys(reg.pins).length };
  } finally { releaseLock(); }
}

/** List all live pins (dead-PID entries pruned as a side effect). */
export async function list() {
  const reg = await readAndPrune();
  return {
    registry_path: REGISTRY_PATH,
    version: reg.version || REGISTRY_VERSION,
    pin_count: Object.keys(reg.pins).length,
    pins: Object.entries(reg.pins).map(([target_id, entry]) => ({
      target_id, ...entry, mine: entry.pid === process.pid,
    })),
  };
}

/**
 * Synchronous best-effort cleanup for process exit handlers.
 *
 * CRITICAL: only mutate the registry when we actually hold the lock. If
 * lock acquisition fails (another live process holds it), skip the
 * read-modify-write entirely — better to leak our pin entries (which
 * will be pruned by the next live process on its next read+prune cycle,
 * since our PID will be dead) than to corrupt the registry by racing
 * another writer. The previous version proceeded unconditionally and
 * unlink'd the lock at exit, letting a third process enter the critical
 * section while our writeAtomic was mid-rename.
 */
export function releaseAllSync() {
  let locked = false;
  try {
    try { const fd = openSync(LOCK_PATH, 'wx'); closeSync(fd); locked = true; } catch { /* held by another process */ }
    if (!locked) return;  // skip cleanup; our dead PID will be pruned later
    try {
      const reg = readRaw();
      let mutated = false;
      for (const [tid, entry] of Object.entries(reg.pins)) {
        if (entry?.pid === process.pid && entry?.host === hostname()) { delete reg.pins[tid]; mutated = true; }
      }
      if (mutated) writeAtomic(reg);
    } finally {
      // Only remove the lock if WE created it.
      try { unlinkSync(LOCK_PATH); } catch {}
    }
  } catch { /* swallow — exiting anyway */ }
}

export { REGISTRY_PATH };
