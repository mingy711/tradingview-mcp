# Ideas & Backlog

Improvements tracked but not yet implemented.

## Recently shipped (kept for context, dated)

- **2026-04-25** — B.18 `pane_read_batch` (ttnsx888 668cc55d): self-contained additive port, format helpers duplicated rather than refactored to avoid conflict.
- **2026-04-25** — `pine_smart_compile` exposes `elapsed_ms` so callers know how long compilation took.
- **2026-04-25** — `tab_list` includes the active Pine script name per tab (DOM probe via `pine-script-title-button`).
- **2026-04-25** — `tab_switch_by_name`: switch by Pine script name (exact-then-substring match) instead of by index.
- **2026-04-25** — Cycle 1 (6 bugs): `tv_launch` null pid, `pane_read_batch` wrong unwrap path, port param fiction in `ensureCDP`, `watchlist.addBulk` macOS modifier, `paths.resolveScreenshotDir` traversal vector, `pine.saveAs` silent reopen failure. Cycle 2 (3 perf items): page-side cap in `buildGraphicsJS`, dialog selector pre-filter, per-target Pine read timeout. (`fork-port/cycle-1-2-fixes`)
- **2026-04-25** — `stream.js` smoke coverage (10 tests). Added `_deps` to `pollLoop` so iteration count, sleep, signals, and stdout/stderr are injectable. Includes regressions for the `inner.get(false)` unwrap path and study-filter threading.
- **2026-04-25** — Per-call `_deps` DI migration for 10 core modules: alerts, batch, capture, data, health, indicators, pane, pine, ui, watchlist. The global `__setTestOverrides` hook still works as the underlying fallback. (`refactor/wrappers-and-di`)
- **2026-04-25** — E2e wrapper refactor: 37 of 79 raw `evaluate(...CHART_API...)` sites replaced with wrapper calls (`coreChart`, `coreDrawing`, `coreHealth`, `corePine`, `coreData`, `coreUi`, `coreIndicators`). Includes the four "output size budget" tests that were re-implementing wrapper IIFEs verbatim — now they assert the wrapper's actual output, so a TV API rename produces a single-source failure instead of parallel-implementation drift. Down to 42 raw sites; the rest are DOM existence probes, FIND_MONACO walks, or BARS_PATH single-bar reads with no wrapper equivalent. (`refactor/wrappers-and-di`)
- **2026-04-25** — TV Desktop 3.1.0 quirks wiki entry written at `~/ai/wiki/vendors/tradingview-desktop.md` covering API surface changes, state-pollution traps, Pine graphics object path, and launch-path quirks.

## Fork audit 2026-05-09

Sourced from `scripts/audit_forks.sh --top 100` (report at `/tmp/fork_audit.md`).

### Shipped this audit cycle

- **`chart_remove_studies_by_title`** — bulk title-substring removal via `getAllStudies` + `removeEntity`. Saves a `chart_get_state` roundtrip when the caller has the script name but not entity_id. Sourced from prezis (their `pine_remove_study` fix didn't apply directly because our `chart_manage_indicator` already used `removeEntity`, but the title-match capability was a genuine gap).
- **CDP reliability bundle** — `withReconnect()` helper, 2s liveness timeout in `getClient()` with timer cleanup, and `Emulation.setFocusEmulationEnabled` on every (re)attach (so background-tab screenshots keep painting). Sourced from upstream PR #131 + dsfortescue fork (`99cc9c5`).
- **`data_get_strategy_info`** — strategy name (internal API on `metaInfo`) + Strategy Tester date range (DOM scrape). Sourced from PasanteAdmin.
- **EPIPE-on-TV-close fix** — `connect()` no longer calls `Runtime.enable` / `Page.enable` / `DOM.enable`, eliminating the console-event forwarding channel that EPIPEs on TV's renderer at shutdown. `disconnect()` sends `disable` defensively and waits 250 ms for the close frame to flush. `connect()` registers a `disconnect` event handler so the cached client drops immediately when TV closes. `server.js` adds SIGTERM, SIGINT, and stdin-close handlers that route through `disconnectCdp()` before exit. Sourced from PasanteAdmin (`bcd8176` + `cf9785a`).
- **`replay_stop` linking-path fix** — `_replaySessionState` now nulls on `chartWidget._linking._chartWidgetCollection` (the path that survives a TV process restart), not the non-existent `TradingViewApi.linking`. Surfaced this session.

### Audited, no genuine gap

- **KarmicP — CDP injection sanitization across 9 modules.** Our `tests/sanitization.test.js` (353 lines) already covers `safeString`, `requireFinite`, source-level audit. The two files without `safeString` (`capture.js`, `pine.js`) interpolate server-controlled strings (internal `colPath`, generated `token`), not user input.
- **KarmicP — `pine_set_source` hangs on large scripts.** Already shipped — `src/core/pine.js` setSource (lines 326-380) uses `pushEditOperations` + `setTimeout(...,0)` + 15s polling timeout, identical pattern to KarmicP's fix.
- **dsfortescue — `tab_switch` CDP redirect.** Our `switchTab` already calls `connectToTarget(target.id)` after `Target.activateTarget`. Their fix targeted a fork that didn't reconnect at all.
- **PasanteAdmin — `strategy_tester_open/close/get_results/get_trades`.** `ui_open_panel('strategy-tester')` covers open/close. Our `data_get_strategy_results` uses `_reportData.performance` (internal API) which is locale-stable and exposes more metrics than PasanteAdmin's DOM scrape. Same for `data_get_trades` (uses `_reportData.trades`). Their `set_settings` was deferred upstream by PasanteAdmin themselves (DOM-text matching was unreliable).

### Still on the backlog

- **KarmicP — validate cloud-persisted values** before round-tripping (alert payloads, watchlist names, layout names). Belt-and-braces against TV-side input that bypasses our local sanitization.
- **PasanteAdmin — strict `smart_compile` honest success.** We already check study-count delta; their check catches the false-positive when an unrelated study is added concurrently. Tighten ours by filtering by Pine title rather than count.
- **prezis — `deployMultipleScripts`** (sequential multi-script deploy with auto-switch between editor slots). Audited 2026-05-09: it's a 433-LOC workflow tool that depends on `pine_switch_script` (which we don't have) and orchestrates `setSource` + `save` + `add-to-chart` per script. Our existing primitives (`pine_set_source`, `pine_smart_compile`, `pine_save`, `chart_manage_indicator`) compose well enough for callers to chain themselves. Worth porting only if user-facing demand surfaces.
- **prezis — `pine_switch_script`** via the Pine editor dropdown (UI path, not REST). Useful when the script isn't already on chart. Prerequisite for `deployMultipleScripts`.
- **prezis — `fib-truth.js`** exact OHLCV wick lookup for Fib ground-truth verification.
- **KarmicP — replay CLI ergonomics.** `--chart`/`-c` to switch tab before replay; `--layout`/`-l` to load a saved layout first; compound `replay_start` accepting flexible date formats.
- **yaojinhui1993 — chart data download workflow.** `target_id` + filename params for bulk OHLCV export via TV's native download path; complements our 500-bar `data_get_ohlcv` cap.

## Audit 2026-05-16 — historical-replay sweep findings

Sourced from a NQ master DB validation pass at `~/ai/nq/master/` that tried to
sweep 50 corpus sessions across 10 NQ futures contracts, replay each to 9:33
ET, and compare the Pine `-4 CB Model Indicator`'s drawn line Y values to a
Python-computed reference. **One session validated bit-exact** (2026-05-08
NQM6, all 6 lines + OR OHLC match) but the 49-session scale-out hit the bugs
below. Each one blocked work in this session — listed in rough priority order.

### Shipped 2026-05-17

- **`tab_new` + `tab_close` rewrite** — `tab_new` was unreliable on TV 3.1+
  because the chart canvas absorbs `Ctrl+T` before Electron's window handler
  sees it. Investigation found that the tab-strip `+` button lives in a
  separate Electron shell page (file:///.../index.html) as
  `button.create-new-tab-button`; triggering its React `onClick` handler
  directly (via `__reactProps`) reliably spawns a new tab. The new tab
  lands on TV's layout-picker page (URL `.../new-tab/index.html?...`) and
  needs a layout selection to become a real chart. `tab_new` now returns
  `picker_tab_id` so callers can switch into it or clean up. `tab_close`
  rewritten to use CDP `/json/close/<id>` (Ctrl+W had the same user-gesture
  problem); accepts an optional `id` param so callers can target picker
  tabs explicitly, defaults to the currently-attached target. Refuses to
  close the last chart tab. Layout selection in the picker still requires
  user action in TV (no programmatic path discovered).
- **`chart_set_symbol` recovery cascade** — three-tier auto-recovery now lives
  in `setSymbol`: poll `chart.symbol()` for JS-API match (8s window, replaces
  the old DOM-legend gate that false-positived on exchange-prefix mismatch);
  on mismatch, dismiss blocking dialogs + retry; on still-mismatch OR a
  visible "This symbol doesn't exist" / "No data here" / "Invalid symbol"
  overlay, hard-reload via `Page.reload` and retry once. Response carries
  `hard_reloaded:true` + `prior_studies` so callers can restore wiped
  studies; new error code `SYMBOL_LOAD_ERROR` (vs `SYMBOL_DID_NOT_CHANGE`)
  flags the overlay variant. Live-validated: clean switches no longer
  trigger false-positive reload; replay-active switches preserve cursor.
- **`replay_start` intraday + re-jump** — accepts ISO-with-time strings
  (`2026-05-08T13:33:00Z` / `+offset`); when called against an already-
  running replay, runs `stopReplay` + clears `_replaySessionState` on both
  top-level and `_linking` paths + 300 ms settle before `selectDate` so TV
  doesn't silently restore the cached cursor. Cursor poll is now target-
  aware (waits until `currentDate` is within 60 s of the requested ts);
  response includes `requested_ts`, `drift_seconds`, and a `warning` string
  when drift > 5 min (catches the silent-clamp-to-unloaded-data symptom).
  Live-validated 09:33 ET / 10:30 / 11:30 ET jumps round-trip with drift
  1 s on NQM2026 60 m.

### Replay API

- **`replay_start --date` only handles day-precision strings; needs ISO-with-time.**
  `_replayApi.selectDate(ms)` accepts full ms precision (cursor lands on exact
  second when called directly via CDP eval). The MCP wrapper's
  `new Date("YYYY-MM-DD").getTime()` zero-fills the time component, so callers
  can't position the cursor at e.g. `09:33 ET`. Accept `YYYY-MM-DDTHH:MM:SSZ`
  or `YYYY-MM-DD HH:MM` and pass ms through unchanged. Tested: passing
  `"2026-05-08T09:33:00-04:00"` to the existing wrapper works (`new Date`
  parses ISO with offset) but isn't documented. Document or formalize.

- **`replay_start` should clear `_replaySessionState` before every `selectDate`,
  not just on `stop`.** When replay is already started and you call
  `selectDate(new_target)`, TV silently restores the cached cursor from
  `_replaySessionState` instead of moving to the new target. The clear logic
  in `core/replay.js stop()` exists; lift it into a helper that runs at the
  top of `start()` too. Both paths must be nulled:
  `_chartWidgetCollection._replaySessionState` AND
  `_activeChartWidgetWV.value()._chartWidget._linking._chartWidgetCollection._replaySessionState`.

- **`selectDate` silently clamps backward jumps to unloaded historical
  dates.** TV's chart series doesn't fetch earlier 30s bars via `selectDate`;
  the cursor stays at the previously-loaded buffer's last bar with no error.
  Forward jumps (to dates after current buffer) DO trigger a server-side load.
  Backward jumps within the loaded range work. Backward jumps outside it
  don't. Document this in `replay_start` help text and consider a
  `--scroll-back` option that simulates UI mouse-wheel pans to force backward
  loads.

- **`_replayUIController.disableReplayMode()` doesn't actually stop replay.**
  `isReplayStarted()` keeps returning `true` after calling it. Need to also
  call `_replayManager.stopReplay()` and null `_replaySessionState`. Affects
  any caller trying to "reset to realtime" without going through
  `tv replay stop`.

### Chart / symbol

- **`chart.setSymbol` stuck-state is irrecoverable from CDP.** When the chart
  enters a stuck state (cumulative side-effects from prior failed/in-flight
  ops, or stale `_replaySessionState`), subsequent setSymbol calls return
  success silently while `chart.symbol()` stays at the old value. Even
  round-tripping (setSymbol A → setSymbol B → setSymbol A) doesn't recover.
  The MCP detects mismatch and emits "may be in a stuck saved-replay state
  — try replay_stop or restarting TV" but `replay_stop` doesn't fix it.
  Real recovery needs `Page.reload`. Add `tv reconnect --hard` that does
  the reload, OR have `setSymbol`'s retry path auto-trigger a hard reload
  after the dialog-dismissal retry also fails.

- **`tv tab switch <n>` doesn't propagate to subsequent commands.** After
  switching tabs, `tv state` still returns the OLD tab's symbol/studies.
  Re-attaching the CDP target after switch isn't happening or isn't taking
  effect immediately. Tested with 8 tabs all on NQ futures; `tab switch`
  returned `{success: true, index: N}` but state remained pinned to tab 0's
  view. Workaround: pass `TV_TARGET_CHART_ID` env var to pin a specific
  chart-id at command time. Investigate whether `switchTab`'s
  `connectToTarget` is racing with the cached CDP client.

- ~~**`tv tab new` (Ctrl+T via `Input.dispatchKeyEvent`) doesn't reliably
  create a new tab.**~~ — Shipped 2026-05-17. Fixed by triggering the
  Electron shell's `.create-new-tab-button` React `onClick` directly;
  returns the picker tab id. Layout selection still manual.

### Indicators / Pine

- **`tv indicator add` parses leading hyphen in indicator name as a flag.**
  `tv indicator add "-4 CB Model Indicator"` errors with `Indicator name
  required` because the CLI argparser sees `-4` as a flag. Workarounds:
  `tv indicator add -- "-4 CB Model Indicator"` (works), `tv indicator add
  "_4 CB Model"` (doesn't, wrong name). Reorder parser to accept positional
  after `--`, or auto-detect this case and emit a helpful hint.

- **`tv indicator add USER;<scriptIdPart>` doesn't resolve user-saved Pine
  scripts.** `chart.createStudy(name)` expects a built-in study name; passing
  the `USER;<id>` form (which `tv pine list` returns) fails silently with
  `new_study_count: 0`. To add a user script by ID, currently must go through
  the Pine editor open + compile flow (which has its own friction — see
  below). Either add a `--user-script` flag that loads via pine-facade, or
  accept `USER;<id>` directly and route appropriately.

- **`tv pine open <name>` fails with "Could not open Pine Editor" on fresh
  charts.** The `ensurePineEditorOpen` helper polls for Monaco availability
  via `FIND_MONACO`, retries the panel-open trigger every 2s, gives up after
  50 iterations (10s). On a fresh chart tab with no prior Pine activity, the
  pine-dialog-button doesn't always render within that budget. Either extend
  the polling or fall back to clicking the visible bottom-panel "Pine Editor"
  tab via DOM selector.

- **Pine editor "Add to chart" button needs broader selectors for TV 3.1.0+
  icon-only headers.** `pine compile` looks for buttons with text matching
  `/save and add to chart/i` or `/^(Add to chart|Update on chart)$/i`. On
  3.1+ these buttons are icon-only — the label lives in `title` attr — and
  there may be additional candidates like `Untitled scriptAdd to chartAdd
  to chartPublish scriptPublish script` parent divs that confuse the matcher.
  Tested: `tv pine compile` timed out repeatedly even with the indicator
  source loaded. Worked when I manually clicked at the button's reported
  coordinates via `tv ui mouse`. Strengthen the selectors and add a
  click-by-coords fallback.

### Pine indicator data extraction

- **Pine `line` primitives expose `y1`/`y2` directly on the primitive object,
  NOT under `.v`.** The wiki entry at `~/ai/wiki/vendors/tradingview-desktop.md`
  documents `p.v.y1` — but on TV Desktop 3.1.0.7818 the actual structure is
  `{id, x1, y1, x2, y2, ex, st, ci, w}` directly on `p`. The MCP's
  `data lines` returns line price levels by deduping but the verbose mode
  may rely on the wrong path. Wiki entry needs correction. (Verified by
  reading `study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById`
  on a working chart.)

- **`tv data lines -f "..."` returns empty study list when indicator hasn't
  yet drawn lines.** For session-triggered indicators (like `-4 CB Model`),
  the lines exist only between trigger-touch and -4-touch within replay
  cursor's current session. Returning `{studies: []}` for "no lines drawn yet"
  is correct but indistinguishable from "indicator not loaded". Add a flag
  like `--include-empty` so caller can tell the difference.

### UI automation

- **`tv ui mouse <x> <y>` click coords don't match `tv ui find` reported
  positions on overlapping toolbar elements.** `find "Bar replay"` returned
  3 matching button elements with bounding boxes (947, 0, 88×38). Center
  click at (991, 19) actually opened the Alert dialog (adjacent button),
  not Replay. Either DOM rect coords differ from CDP click coords (likely
  devicePixelRatio mismatch on WSL2-driven Windows TV), OR the reported box
  belongs to a parent container rather than the leaf button. Reconcile,
  OR have `tv ui mouse` accept an element-id from a prior `tv ui find` to
  abstract over the coord-space.

### Performance / DX

- **Per-call CDP target enumeration dominates batch-job runtime.** Each
  `node tv_spot_check.js <cmd>` call takes 3-10s minimum even for cheap
  reads, because every invocation re-runs `CDP.List({port: 9222})` and
  re-attaches. For a 50-session sweep with ~3 commands per session, that's
  7-25 minutes of pure CDP-setup overhead. A persistent CDP session mode —
  e.g. `tv repl` that takes stdin commands and emits stdout JSON per line
  over a single client — would cut this to seconds. Or expose the
  `tv_spot_check.js` helper pattern (one Node process, multiple
  Runtime.evaluate calls) as a first-class CLI mode.

## Held for design discussion

- **C.23 AsyncLocalStorage tab routing + persistent pin + study-readiness gate** (floatalgo `81efb1ff`) — significant architectural change to how tools are routed across tabs. Needs design call before code.

## Permanently skipped (kept so future-me doesn't re-investigate)

- **C.22 3-phase strategy detection with DOM fallback** (PR #51) — superseded by PR #90 (which we merged); also contains a duplicate of the `ui_evaluate` security hole we removed in N.35; also Korean-locale-specific DOM scraping that wouldn't work for most users.
- **C.26 DOM-scrape fallback for strategy results + trades** (PR #96) — English-only label parsing with line-position fragility. PR #90 covers TV 3.1.0 strategy detection robustly enough that the fallback complexity isn't worth the maintenance cost.
- **`data_get_strategy_results_dom` regex tightening** — was tied to C.22; skipped by transitivity.

## Speculative future direction

Sub-agent personas for strategy development:

- **Architect**: writes Pine Script strategy from spec.
- **Backtester**: runs parameter sweeps, reads strategy tester results.
- **Reviewer**: static analysis + `pine_check` before compile.
- **Reporter**: formats backtest results into structured summary.

Not action items — captured for later if/when we go this direction.
