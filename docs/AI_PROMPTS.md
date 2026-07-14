# AI Prompt Log

This is a running record of how AI was used to build this project. It is kept
up to date as the build progresses (not reconstructed at the end).

## Workflow

The architecture was designed first (see `docs/architecture-and-build-plan.md`)
and treated as a fixed design contract. AI was then used for **implementation
against that contract**, one phase per conversation. Two AI surfaces were used:

- **Claude in VS Code** — generated the application code for each phase from the
  prompts below.
- **Claude in Cowork** — planning, explanation, the Phase 0 capture/verify helper
  scripts, diff review, and drafting the submission docs.

Every generated diff was read and reviewed by a human before commit. No file was
committed that could not be explained. All performance numbers in the
architecture doc were measured by a human, not taken from the model's claims.

Format below: each phase lists the prompt(s) actually used, which surface ran
them, and a short note on what was produced and what the human changed/verified.

---

## Phase 0 — Backend recon & fixtures

**Surface:** Claude in Cowork.

The playbook's original plan was to capture fixtures by hand with `wscat`. Copying
a clean 500-level order-book message out of the live firehose by hand is
error-prone, so instead:

**Request 1 — capture helper:**
> Give me a clean way to capture one real message of each channel (v2/ticker,
> l2_orderbook, all_trades) plus the subscriptions ack into docs/fixtures/,
> instead of copy-pasting from the wscat stream.

Produced `scripts/capture-fixtures.mjs` (Node built-in WebSocket; subscribes,
grabs one message of each type + the ack, writes pretty-printed JSON, exits).
Human ran it and confirmed 4 files written.

**Request 2 — verify before committing:**
> Before I commit, let me double-check the fixtures are correct — one channel at
> a time rather than trusting all four at once.

Produced `scripts/verify-fixture.mjs` (read-only; subscribes to a single channel,
pulls a fresh message, structurally compares top-level keys + bids/asks shape
against the saved fixture). Human ran it per channel and confirmed shapes match.

**Human verification:** confirmed each fixture's fields against the doc's
message-shape table — `close` / `ltp_change_24h` (ratio) / µs timestamps on
ticker; no `side` field on trades; 500-level full-snapshot order book.

---

## Phase 1 — Scaffold + types

**Surface:** terminal (scaffold) + Claude in VS Code (types).

Scaffolded Vite React-TS, added zustand + vitest, committed the vanilla scaffold
on its own so the next diff would show only hand-designed code.

**Prompt 1.1 — Claude in VS Code:**
> Read docs/architecture-and-build-plan.md — it is the design contract for this
> project; follow it for everything.
>
> Set up the project skeleton:
> 1. tsconfig: strict true, noUncheckedIndexedAccess true, noImplicitReturns true.
> 2. Folder structure: src/transport, src/engines, src/stores, src/components,
>    src/config, src/types, src/utils. Direct imports only — no barrel files, no
>    circular deps.
> 3. src/types/messages.ts: TypeScript types for the three WebSocket message
>    types, derived EXACTLY from the real captured payloads in docs/fixtures/*.json.
>    Model them as a discriminated union on the `type` field. Prices are strings,
>    timestamps are microseconds — type them as-is with comments; do not clean up
>    the wire format. Only the fields we use, plus a comment noting others exist.
> 4. src/config/symbols.ts: the symbol config table from the doc — precision and
>    grouping ladder per symbol, `as const`, with a Symbol union type from its keys.
> 5. Vitest config wired into package.json (test script).
> No `any` anywhere. No UI yet.

**Human verification:** read messages.ts and symbols.ts field-by-field against the
captured fixtures (close typed as number, prices/ratio as strings, µs timestamps,
no trade `side` field; all six symbols' precisions and grouping ladders match the
doc's table). Ran `npx tsc --noEmit` (clean) and `grep -rn ": any" src/` (none).
Noted for Phase 4: ladder increments are decimal floats, so `g = increment ×
10^precision` must be wrapped in Math.round to stay an exact integer (DOGE 6dp).

---

## Phase 2 — Transport layer

**Surface:** Claude in VS Code.

**Prompt 2.1:**
> Read docs/architecture-and-build-plan.md, src/types/messages.ts and
> docs/fixtures/ack.json.
>
> Implement the transport layer per the doc's "Transport layer" section:
> 1. src/transport/SocketClient.ts — framework-free class (no React imports).
>    Owns one WebSocket to ws://localhost:8080. States connecting/connected/
>    reconnecting/disconnected via an onStatus callback. Reconnect with
>    exponential backoff min(1000×2^n, 30000) plus full jitter, counter resets on
>    open. An epoch number incremented on every reconnect, exposed to consumers.
>    Route messages: parse JSON once, switch on msg.type, dispatch to per-channel
>    handlers. Malformed JSON: log and drop, never throw.
> 2. src/transport/SubscriptionManager.ts — holds the DESIRED subscription set.
>    On (re)connect sends the full desired set. Listens for the server's
>    `subscriptions` ack, diffs actual vs desired, re-sends on drift. Public API
>    setDesired(subscriptions); computes minimal subscribe/unsubscribe messages.
> 3. src/stores/connection.ts — Zustand store {status, epoch}; only writer is a
>    thin adapter wired to SocketClient callbacks. No business logic.
> 4. src/components/ConnectionBadge.tsx — memoized, selector to status only.
> Wire behind a single bootTransport() in App.tsx; delete the Vite demo assets.
> No `any`. Unit tests for SubscriptionManager's diffing logic.

**Prompt 2.2 (understanding pass):**
> Walk me through SocketClient.ts and SubscriptionManager.ts function by function.
> For each: why does it exist, what breaks if it's removed, and what interview
> question would you expect about it? Be specific to this code, not generic.

**Human verification:** live-tested all four connection states — connecting flash
on load, connected steady, reconnecting on backend kill with growing delays and
auto-recovery without page refresh (ack shows resubscription), disconnected only
via explicit disconnect(). Reviewed backoff/full-jitter math, epoch-at-drop
semantics, and ack reconciliation. `npm test` green (diff unit tests incl. focus
swap, no-drift, dedupe, partial overlap, channel-order determinism).

---

## Phase 3 — Ticker bar with render isolation

**Surface:** Claude in VS Code.

**Prompt 3.1:**
> Read docs/architecture-and-build-plan.md (TickerEngine section), src/transport/*,
> src/config/symbols.ts.
>
> Implement:
> 1. src/engines/TickerEngine.ts — framework-free. onMessage stores the raw
>    message in a Map<Symbol, TickerMsg> and adds the symbol to a dirty Set (two
>    O(1) ops). A requestAnimationFrame flush loop builds an immutable TickerView
>    { symbol, price, changePct, dir } per dirty symbol — price from close,
>    changePct = (parseFloat(ltp_change_24h) − 1) × 100 (RATIO), dir vs previous
>    published price — then publishes and clears dirty.
> 2. src/stores/tickers.ts — Record<Symbol, TickerView>. Publish REPLACES ONLY
>    CHANGED KEYS so unchanged symbols keep referential identity.
> 3. src/stores/market.ts — { focusedSymbol } persisted via zustand/persist.
> 4. src/components/TickerBar.tsx + TickerCell.tsx — TickerCell React.memo'd,
>    subscribes with s => s.tickers[symbol] only; price formatted to the symbol's
>    precision; change % colored; click sets focusedSymbol; focused cell reads
>    focus via its own narrow selector s => s.focusedSymbol === symbol.
> Subscribe v2/ticker for ALL six symbols at boot. No `any`.

**Human verification (React DevTools Profiler):**
- Ticking recording: parents (App, TickerBar) NEVER appear in any commit; only
  TickerCell(s) render. Subset commit 38/144 showed only BTCUSD + ETHUSD
  rendering while the other four cells stayed out — proves per-symbol isolation.
- Coalescing: all six symbols ticking in one frame collapse into a single commit.
- Evidence saved: docs/evidence/profiler-ticker-isolation.png (subset commit) and
  profiler-ticker-coalescing.png (all-six single commit).
- Focus persists across page reload (zustand/persist).

---

## Phase 4 — Order book (split into 3 commits)

**Surface:** Claude in VS Code.

### 4.1 — pure grouping pipeline + tests (no UI)

**Prompt 4.1:**
> Read docs/architecture-and-build-plan.md — OrderBookEngine section, especially
> the integer-tick grouping pipeline — and src/config/symbols.ts,
> docs/fixtures/orderbook.json.
>
> Implement the pure transformation pipeline in src/engines/orderbook/pipeline.ts
> (no React, no store imports):
> 1. parseAndGroup(msg, groupingIncrement, precision, N): prices → integer ticks
>    via Math.round(parseFloat(p) × 10^precision); bucket bids with floor(ticks/g)×g
>    and asks with ceil(ticks/g)×g where g = Math.round(increment × 10^precision).
>    Walk the already-sorted raw arrays accumulating size per bucket; EARLY-EXIT
>    after N buckets per side (N=12).
> 2. Same pass: cumulative sizes, maxCumulative, mid, spreadAbs, spreadBps,
>    imbalance (Σ visible bid / Σ visible ask) — all from the GROUPED view.
> 3. Return an immutable OrderbookView; convert bucket ticks back to display
>    prices at the symbol's precision.
> Then thorough Vitest tests BEFORE any UI: 6 symbols × each ladder increment —
> floor/ceil boundaries, size aggregation, cumulative monotonicity, DOGEUSD 6dp
> exactness, early-exit fills N, spread/imbalance from grouped not raw. Real
> fixture as one input. No `any`.

**Human verification:** independently reproduced the boundary rounding and DOGE
6dp results in plain Node (61785/61790; 0.012345 round-trip; 0.0123/0.0124). The
Math.round(g) guard is present — kept as provably-exact defence against float
representation, not a fix for an observed bug. `npm test` green. Documented
assumption: pipeline relies on the backend's best→worst sort (contiguous buckets).

### 4.2 — engine + store

**Prompt 4.2:**
> Implement src/engines/OrderBookEngine.ts per the doc: single latestRaw slot
> (latest-snapshot-wins), rAF flush runs the 4.1 pipeline and publishes to a new
> src/stores/orderbook.ts as { view, loading, epoch }. Flush carries the transport
> epoch; discard if stale. Track previous snapshot's bucket sizes to mark
> flash 'up'|'down'|null on >10% size change, rate-limited to one flash per bucket
> per 300ms. Grouping increment from a new src/stores/preferences.ts (per-symbol
> grouping + largeTradeThreshold, persisted). Unit tests for the flash rate-limiter
> (fake timers) and the epoch guard.

**Follow-up (review-driven):**
> The flash-tracking maps accumulate every bucket key ever seen within an epoch,
> so they grow as the mid wanders and a bucket that scrolls out then back in
> compares against a stale size. Rebuild them each flush to hold only the current
> snapshot's visible buckets (bounds to ≤2×N, makes "previous" literally the last
> snapshot). Add a test asserting the maps stay bounded over many wandering-mid
> snapshots.

**Human verification:** reviewed all four risk points — stable bucket-price flash
keys, epoch read at flush time, per-symbol preferences, flash reset on epoch
change. Traced that the map-rebuild preserves the 300ms rate-limit window across
flushes. Memory-bound test confirms ≤2×N entries over 200 wandering snapshots.
`npm test` green.

### 4.3 — panel UI

**Prompt 4.3:**
> Build src/components/OrderBookPanel.tsx per the doc: asks on top (lowest ask
> nearest the spread row), bids below; FIXED 12 rows per side rendered always
> (stable DOM — zero layout shift); each row price/size/cumulative + depth bar as
> an absolutely-positioned div scaled with transform: scaleX(cum/maxCum) (transform
> only). Spread row: mid, spreadAbs, spreadBps, imbalance. Grouping dropdown fed
> from the focused symbol's ladder, writing preferences. Flash via a CSS animation
> keyed on a changeKey. Loading skeleton when loading. Panel subscribes to the
> orderbook store only. No `any`.

**Follow-up (review-driven):**
> The fixed rows are keyed by price, so every snapshot's mid shift remounts all 24
> rows. Key each row by its position index instead (DOM node reuse — only content
> updates), keeping the flash overlay's price+size changeKey so animations still
> retrigger.

**Human verification (screen recording):** book renders correctly for the
subscribed symbol — BTC ~63,000 at 1dp on the $1 grid, SOL ~76.28 at 4dp on the
0.0001 grid; depth bars, spread row (mid/abs/bps/imbalance), and per-symbol
grouping ladders all correct. Confirmed index-keyed rows + price/size flash key.
Known gap (closed in Phase 6): switching focus updates the panel label/precision/
grouping immediately but the l2_orderbook subscription only follows after reload.

---

## Phase 5 — Trades feed (2 commits)

**Surface:** Claude in VS Code.

### 5.1 — merge + rolling stats + tests

**Prompt 5.1:**
> Implement pure modules with Vitest tests: src/engines/trades/merge.ts
> (deriveSide from buyer_role; mergeIntoRows — merge same-price within 100ms of
> the row's FIRST trade, µs→ms once; format time once at ingest) and
> src/engines/trades/RollingStats.ts (60 one-second bucket ring with running
> totals, O(1) record + O(1) per-second eviction, getStats {buyVol, sellVol,
> count, avgSize}). Tests: merge boundaries (99/100/101ms), side derivation,
> ring wraparound, eviction after multi-second gaps.

**Human verification:** independently reran the ring scenarios in Node (60s
evict, 59s keep, 250s roll, tick-only decay, 1h-gap-then-resume, stepped==jumped)
— all match. avgSize guarded against divide-by-zero. `npm test` green.

### 5.2 — engine + UI

**Prompt 5.2:**
> Implement src/engines/TradesEngine.ts: bounded pending queue (cap 2000, shed
> oldest), rAF flush merges into a 200-row ring and publishes to src/stores/
> trades.ts; feed RollingStats; publish stats to a SEPARATE src/stores/
> tradeStats.ts once per second (drive tick() on that 1Hz cadence). Epoch-guard
> like the book. UI: TradesPanel — rows (time, side-colored price, size, ×count
> badge, large-trade style when price×size ≥ threshold); auto-scroll pin/unpin
> with "Jump to latest"; RollingStatsBar (1Hz); per-symbol threshold input.

**Follow-up (review-driven):** moved the `large` determination out of the engine
into TradeRowItem (reads threshold live from preferences) so editing the
threshold restyles visible rows immediately, even during a lull; engine now
publishes plain TradeRow[].

**Human verification (screen recordings + Profiler):** feed flows with side
colors + 1Hz stats; grouping + threshold work; large-trade highlight discriminates
per row (verified 62236.5×96 = 5.97M rendered plain below a 6M threshold while
larger rows highlight). Profiler: trades commit re-renders only TradesPanel +
TradeRowItems (no book/ticker); book commit re-renders only the book — isolation
both directions. Evidence: profiler-trades-isolation.png, profiler-book-isolation.png.

Documented for KNOWN_ISSUES / assumptions: feed trims oldest rows off the top
(reading position can shift when scrolled up under high volume); rolling-stats
ring advanced by trade timestamps (record) + wall-clock (1Hz tick), safe as
backend stamps Date.now() on the same host; backend emits near-uniform trade
sizes (~96-106) and random per-trade prices, so large-trade highlighting and
same-price merges are seldom exercised by real data.

---

## Phase 6 — Focus switching

**Surface:** Claude in VS Code.

**Prompt 6.1:**
> Wire the focus-switch sequence exactly as the doc specifies. Clicking a ticker →
> market store updates (persisted) → epoch increments → orderbook and trades stores
> reset to loading (no stale data) → SubscriptionManager desired-set changes (unsub
> old symbol's l2_orderbook + all_trades, sub new) → engines drop buffered old-epoch
> messages → first new-symbol message clears loading. Reconnect replays the CURRENT
> desired set (focused symbol's channels), not a stale one. No `any`.

Implemented as a synchronous useMarketStore.subscribe handler in bootTransport:
bumpEpoch() → resetOrderbook/TradesForFocusSwitch(epoch) → setDesired(new). A single
buildDesiredSubscriptions(focusedSymbol) is the source of truth, so reconnect replays
the current focus.

**Human verification (screen recordings + WS frame inspection):**
- Connected rapid-switch through all 6 symbols incl. BTC↔DOGE (61,000 vs 0.03,
  6dp): book + trades always symbol-correct, no stale flash.
- WS SEND frames: boot subscribe(6 tickers); each switch = one unsubscribe(old
  l2_orderbook + all_trades) + one subscribe(new), tickers untouched, no orphans.
- Kill/restart while focused on a non-default symbol recovers to that symbol.

Documented edge (in-flight, not observed): engines stamp epoch at message arrival
and don't filter by symbol, so an old-symbol message arriving in the sub-ms window
after a switch could in principle render for one frame; not seen on localhost.
Cosmetic: rolling-stats bar reads 0 for up to ~1s after a switch (window reset)
while the feed populates immediately.

---

<!-- Phase 7+ prompts appended here as each phase completes. -->




