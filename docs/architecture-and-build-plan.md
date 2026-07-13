# Real-Time Trading Dashboard — Architecture & Build Plan

Grounded in the actual `socket-custom-load` backend source (verified, not assumed).
Stack: **Vite + React 18 + TypeScript (strict) + Zustand**. No UI framework needed.

---

## Part 1 — Backend Ground Truth

Everything below was verified by reading the backend source. These facts drive the design.

### Protocol

- `ws://localhost:8080` — data. `http://localhost:3000/intervals` — runtime stress config (GET/POST).
- No data until you subscribe: `{"type":"subscribe","payload":{"channels":[{"name":"v2/ticker","symbols":["BTCUSD",...]}]}}`
- Every subscribe/unsubscribe is **acked with the full current subscription state** (`type: "subscriptions"`). Use this as the source of truth for reconciliation — don't trust client-side bookkeeping alone.
- Unsubscribe with `symbols` omitted drops the whole channel.

### Message shapes (the fields we actually use)

| Channel | Fields used | Traps |
|---|---|---|
| `v2/ticker` | `symbol`, `close` (number, last price), `ltp_change_24h` (string **ratio**: `"1.0123"` = +1.23%), `timestamp` (µs) | Change % = `(parseFloat(ltp_change_24h) − 1) × 100`. Not a percent. |
| `l2_orderbook` | `symbol`, `bids: [price, size][]` (500, strings, sorted best→worst), `asks` (same, 500), `timestamp` (µs) | **Full snapshot, not deltas.** No merging needed; intermediate messages are droppable losslessly. |
| `all_trades` | `symbol`, `price` (string), `size` (int, ~96–106), `buyer_role`/`seller_role` (maker/taker), `timestamp` (µs) | **No `side` field.** Derive: `buyer_role === "taker"` → buy, else sell. Document this assumption. |

All timestamps are microseconds (`Date.now() * 1000`). All prices are strings formatted to the symbol's precision.

### Symbols & precision (from backend `config.js`)

| Symbol | Range | Precision | Grouping ladder (derived) |
|---|---|---|---|
| BTCUSD | 60000–65000 | 1 dp | 1, 5, 10, 50, 100, 500 |
| ETHUSD | 1500–2000 | 2 dp | 0.50, 1, 5, 10, 50 |
| XRPUSD | 1.0–2.0 | 4 dp | 0.0001, 0.001, 0.01, 0.1 |
| SOLUSD | 70–80 | 4 dp | 0.0001, 0.001, 0.01, 0.1, 0.5 |
| PAXGUSD | 5000–5500 | 2 dp | 0.50, 1, 5, 10, 50 |
| DOGEUSD | 0–0.1 | 6 dp | 0.000001, 0.00001, 0.0001, 0.001 |

BTCUSD/ETHUSD/XRPUSD ladders are mandated by the assignment; SOLUSD/PAXGUSD/DOGEUSD derive by the same rule (start at 1 tick, scale ×5/×10, cap well below price range). Keep as a config table.

### Load math (defaults from backend config — worse than the assignment PDF states)

- `v2/ticker` 10–50ms × 6 symbols → **120–600 msgs/sec** (PDF says 12–30/s; design for the config values)
- `l2_orderbook` 10–40ms → 25–100 snapshots/sec × 1,000 price levels = **up to 100K tuples/sec to parse+group**
- `all_trades` 5–20ms → 50–200 trades/sec
- Under evaluation stress: trades at 1–5ms (**up to 1,000/sec**), orderbook at 10–20ms

### Data realism caveat (document as assumption)

Each orderbook snapshot is generated around a *new random mid* — no continuity between messages. Consequence: the ">10% size change" flash rule fires on nearly every level, every update. Implement per spec, but rate-limit flashes per row (e.g. one flash per row per 300ms) or the book becomes a strobe. State this in the doc.

---

## Part 2 — Architecture

### Layer diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ TRANSPORT (framework-free TS)                                   │
│  SocketClient ── reconnect (expo backoff + jitter), epoch/gen   │
│  SubscriptionManager ── desired-state model, ack reconciliation │
└───────────────┬─────────────────────────────────────────────────┘
                │ raw JSON, routed by msg.type
┌───────────────▼─────────────────────────────────────────────────┐
│ ENGINES (framework-free TS; mutable inside, immutable out)      │
│  TickerEngine     latest-per-symbol map + dirty set             │
│  OrderBookEngine  latest-snapshot-wins slot → parse → group     │
│  TradesEngine     pending queue → merge → ring buffer + stats   │
│  each flushes on requestAnimationFrame (coalescing)             │
└───────────────┬─────────────────────────────────────────────────┘
                │ immutable snapshots, published on flush
┌───────────────▼─────────────────────────────────────────────────┐
│ STORES (Zustand, one per domain)                                │
│  connection │ market(focus) │ tickers │ orderbook │ trades      │
│  preferences (grouping, trade threshold — persisted)            │
└───────────────┬─────────────────────────────────────────────────┘
                │ selector subscriptions (per-symbol / per-slice)
┌───────────────▼─────────────────────────────────────────────────┐
│ REACT (presentation only)                                       │
│  TickerBar → TickerCell×6 (memo, selects tickers[sym])          │
│  OrderBookPanel (fixed rows, CSS-transform depth bars)          │
│  TradesPanel (capped list, auto-scroll) + RollingStatsBar       │
│  ConnectionBadge · GroupingSelect · ThresholdInput              │
└─────────────────────────────────────────────────────────────────┘
```

### The one idea that makes stress mode survivable

**React never sees the message rate.** Every engine accepts messages at wire speed into a cheap holding structure (overwrite a slot, push to a queue, set a dirty flag) and publishes to its store at most once per animation frame (~60/s). Because the orderbook is a full snapshot, dropping intermediate messages is lossless. Because tickers are latest-value, same. Trades are the only stream where every message matters (stats + feed), so they queue and batch — nothing is lost, but rendering is amortized. At 1,000 msgs/sec the UI does exactly the same work per frame as at 50 msgs/sec; only the drop ratio changes. Load-shedding is structural, not reactive.

### Transport layer

**SocketClient**
- States: `connecting → connected → reconnecting → disconnected`. Published to connection store (badge in UI).
- Reconnect: exponential backoff `min(1000 × 2^n, 30s)` + jitter; reset counter on successful open. Handles backend kill/restart without page refresh (explicit requirement — test it).
- **Epoch counter**: incremented on every reconnect *and* every focus switch. Every engine flush carries the epoch it was buffered under; stale-epoch data is discarded. This kills both "stale flash after symbol switch" and "ghost data after reconnect" with one mechanism.

**SubscriptionManager**
- Holds *desired* subscriptions (derived from app state: always 6 tickers + orderbook/trades for focused symbol).
- On connect/reconnect: sends full desired set. On server ack (`subscriptions` message): diff against desired; re-send if drift. Self-healing.
- Focus switch = change desired set → manager computes unsubscribe(old)/subscribe(new) messages.

### TickerEngine

- `latest: Map<Symbol, TickerMsg>` + `dirty: Set<Symbol>` — message handling is two O(1) writes, at any rate.
- On rAF flush: for each dirty symbol, build a minimal immutable `TickerView { symbol, price, changePct, dir }` and publish into the tickers store record **replacing only changed keys** — untouched symbols keep referential identity.
- **This is what passes the evaluator's Profiler check**: `TickerCell` is `memo`'d and selects `s => s.tickers[symbol]`. A BTCUSD update changes only `tickers.BTCUSD`'s reference; ETHUSD's selector output is `Object.is`-equal → no re-render.

### OrderBookEngine (the 20% criterion)

- Holding structure: a single slot `latestRaw: OrderbookMsg | null` — new message overwrites. Zero queue growth by construction.
- On rAF flush, one pass pipeline:

```
parse:   price string → integer ticks: Math.round(parseFloat(p) × 10^precision)
         (BTC max: 65000×10 = 650,000; DOGE: 0.1×10⁶ = 100,000 — all safe integers.
          Integer ticks make bucketing exact at every precision; float keys break at 6dp.)

group:   bucketTicks(bid) = floor(ticks / g) × g     ─┐ g = increment × 10^precision
         bucketTicks(ask) = ceil(ticks / g) × g      ─┘ (also an integer)
         Walk the already-sorted raw arrays in order, accumulating size per bucket.
         EARLY EXIT once N visible buckets are filled (N ≈ 12/side).
         → We parse at most a few hundred of the 1,000 tuples per flush, not all of them,
           at coarse groupings often <50.

derive:  cumulative sizes (same pass, running sum)
         maxCumulative → depth bar scale
         mid = (bestBid + bestAsk)/2 ; spread = bestAsk − bestBid (abs + bps vs mid)
         imbalance = Σ bidSize / Σ askSize over the N visible grouped levels
         Assumption to document: spread/mid computed from the grouped view (per spec:
         "metrics update based on the grouped view").

publish: one immutable OrderbookView { asks[N], bids[N], mid, spreadAbs, spreadBps,
         imbalance, maxCum, epoch }
```

- Flash detection: compare each visible level's size to the previous snapshot's same bucket (map lookup); mark `flash: 'up' | 'down' | null`, with per-row 300ms rate limit. Rendering uses a CSS animation triggered by a change key — no timers in React.
- Grouping change (dropdown) just changes `g` — next flush regroups. No special path.

### TradesEngine

- `pending: TradeMsg[]` (bounded, e.g. 2,000 — beyond that drop oldest *pending*; document as stress-mode shedding) + flush on rAF.
- On flush, per trade: derive side; format time as `HH:MM:SS.ms` from `timestamp / 1000` (µs → ms — format once at ingest, not per render); merge into the last visible row if same price and within 100ms window (combined size + count); else push new row into a **ring buffer of 200 visible rows**.
- Large-trade flag: `price × size ≥ threshold[symbol]` — threshold is per-symbol (DOGE notionals are ~10⁴× smaller than BTC's; a single global default would never/always fire). User-configurable, persisted.
- **Rolling 60s stats**: 60 one-second buckets in a ring, `{buyVol, sellVol, count, sizeSum}` + running totals. Each trade: O(1) add to current bucket + totals. Each second: evict oldest bucket by subtracting from totals — O(1). Never re-scan a window. Published once per second to its own store slice so the stats bar re-renders 1×/s, independent of the feed.
- Auto-scroll: track `isPinnedToLatest` (scroll listener with threshold); when pinned, scroll on publish; when not, freeze and show "Jump to latest". List capped at 200 rows renders fine without virtualization — one less dependency; note in tradeoffs (virtualize at 1,000+).

### Stores & persistence

One Zustand store per domain: `connection`, `market` (focused symbol), `tickers`, `orderbook`, `trades`, `tradeStats`, `preferences`. `market.focusedSymbol` and `preferences` (grouping per symbol, thresholds) persist via `zustand/persist` to localStorage. No store imports another; no store touches the socket; engines are the only writers of market data.

### Focus switch sequence (no stale flash)

```
click ETHUSD → market store updates + persists
            → epoch++ ; orderbook/trades stores → { loading: true, data: null }
            → SubscriptionManager: unsub BTC book+trades, sub ETH book+trades
            → engines drop any buffered data from old epoch
            → first ETH snapshot arrives → publish → loading: false
```

### Performance strategy & measurement plan (for the doc's "what did you measure?")

Budgets: orderbook flush (parse+group+derive) < 5ms; any store publish < 1ms; steady 60fps at defaults; no unbounded heap growth over 10min under stress.

Measured evidence to collect (this section of the submission doc must contain *numbers*, not promises):
1. `performance.mark/measure` around each engine flush → log p50/p95 to a dev-only metrics overlay (msgs/sec in, flushes/sec out, drop ratio, flush ms).
2. React DevTools Profiler recording proving ticker isolation (the evaluator's exact test) — screenshot it for the doc.
3. Chrome Performance + Memory: 10-minute soak at `{"all_trades":{"min":1,"max":5},"l2_orderbook":{"min":10,"max":20}}` via the config API; heap flat-line screenshot.
4. Kill/restart backend mid-stress; recovery time to first rendered update.

### Scaling answer (50 symbols — rubric question, answer concretely)

Breaks in order: (1) main-thread CPU — 50 orderbook streams ≈ 50× parse+group ≈ hundreds of ms/frame → move parse+group into a Web Worker pool, post transferable grouped arrays; (2) GC pressure from snapshot churn → pool/reuse snapshot arrays, publish deltas of the grouped view; (3) socket parse cost itself → binary protocol (the JSON decode alone dominates at that scale); (4) DOM — never mount 50 books; subscribe only to visible panels, coarse cadence (1s) for background symbols. The engine/store boundary already isolates this: workers slot in behind the same publish interface without touching React.

---

## Part 3 — Step-by-Step Build Plan

Total: ~2.5 focused days. Each step ends in a commit (they read the git log — commit at every checkpoint, message format: `feat(orderbook): integer-tick grouping with early exit`).

### Phase 0 — Recon (30 min)
1. Clone backend, `bun install && bun start` (or `docker compose up`).
2. `npx wscat -c ws://localhost:8080`, subscribe manually, capture one real message per channel into `docs/fixtures/`. These become type-checking fixtures and test inputs.
3. **Commit**: `chore: backend fixtures and notes`

### Phase 1 — Scaffold (45 min)
4. `npm create vite@latest -- --template react-ts`; strict tsconfig (`strict`, `noUncheckedIndexedAccess`); ESLint; Vitest; folder skeleton (`transport/ engines/ stores/ components/ config/ types/`).
5. `types/messages.ts` — discriminated union on `msg.type` for the three channels, written against the captured fixtures. `config/symbols.ts` — precision + grouping ladder table.
6. **Commit**: `chore: scaffold, strict TS, message types from live fixtures`

### Phase 2 — Transport (3h)
7. `SocketClient` (connect, backoff+jitter, epoch, status callbacks) → `connection` store → `ConnectionBadge`.
8. `SubscriptionManager` (desired-state + ack reconciliation).
9. **Verify now, not later**: kill backend, watch badge cycle reconnecting→connected, confirm re-subscribe via ack log. 
10. **Commits**: `feat(transport): socket client with backoff reconnect`, `feat(transport): subscription manager with ack reconciliation`

### Phase 3 — Ticker bar (3h)
11. TickerEngine (latest map + dirty set + rAF flush) → tickers store → `TickerBar`/`TickerCell` (memo + per-symbol selector). Click sets focus; persist focus; highlight focused cell.
12. **Verify with Profiler immediately** — record, confirm single-cell re-renders. Screenshot → doc. This is the evaluator's first check; get it right while the app is small.
13. **Commits**: `feat(ticker): engine with rAF coalescing`, `feat(ticker): bar UI with per-symbol render isolation (profiler-verified)`

### Phase 4 — Order book (6h — the centerpiece)
14. Pure functions first: `parseBook`, `groupBook` (integer ticks, floor/ceil, early exit), `deriveMetrics`. **Unit-test before any UI**: all 6 precisions, each ladder increment, cumulative correctness, bid/ceil-ask boundary cases, DOGE 6dp exactness.
15. OrderBookEngine (snapshot slot + flush) → orderbook store.
16. `OrderBookPanel`: fixed N rows/side (stable DOM → no layout shift), depth bars as `transform: scaleX()` (no layout/paint storms), spread row, grouping dropdown, flash via change-keyed CSS animation with rate limit.
17. **Commits**: `feat(book): grouping pipeline + unit tests`, `feat(book): engine with latest-snapshot-wins coalescing`, `feat(book): panel UI with depth bars and flash highlights`

### Phase 5 — Trades feed (4h)
18. Pure functions: `mergeTrades` (100ms/same-price), `RollingStats` (60-bucket ring). Unit-test both (fake clock).
19. TradesEngine → trades + tradeStats stores → `TradesPanel` (ring-buffer list, side colors, large-trade styling, auto-scroll + "Jump to latest") + `RollingStatsBar` (1Hz slice) + threshold input (persisted, per-symbol defaults).
20. **Commits**: `feat(trades): merge + rolling stats with tests`, `feat(trades): feed UI with auto-scroll and large-trade highlighting`

### Phase 6 — Focus switching & resilience (2h)
21. Wire the full switch sequence (epoch bump, clear+loading, unsub/sub). Rapid-click through all 6 symbols — no stale flash, no orphan subscriptions (check via ack).
22. Backend kill/restart during stress → auto-recovery. 
23. **Commit**: `feat(app): epoch-guarded focus switching with loading states`

### Phase 7 — Stress & measure (3h)
24. Dev metrics overlay (msgs/sec, drop ratio, flush p95, FPS). 
25. Crank via config API to evaluation levels; 10-min soak; collect all four evidence items from Part 2. Fix what the numbers expose (this is where `useMemo`/`memo` additions are justified by data).
26. **Commit**: `perf: stress instrumentation + fixes from profiling` (with measurements in the message body)

### Phase 8 — Submission package (2.5h)
27. README: setup (backend + frontend), features, stress-test instructions.
28. **Architecture doc (1–2 pages)**: compress Part 2 of this file + real measured numbers + diagram + tradeoffs + scaling answer + documented assumptions (derived trade side, ratio field, grouped-view metrics, flash rate limit, pending-queue shedding).
29. `KNOWN_ISSUES.md` — honest, specific ("flash rate-limited to 300ms/row because backend snapshots are uncorrelated", "trades pending queue sheds oldest beyond 2,000 under extreme stress", etc.).
30. `AI_PROMPTS.md` — the prompts used, per the recruiter's email request, plus the architectural flow.
31. Final pass: `git log --oneline` reads as a story; no `any` (`grep -rn ": any" src/`); fresh-clone test on both repos side by side.
32. **Commit**: `docs: architecture, known issues, AI prompts`

### Rubric coverage check

| Criterion (weight) | Where it's won |
|---|---|
| Architecture & state isolation (30%) | Phases 2–3: per-domain stores, per-symbol selectors, epoch lifecycle, Profiler proof |
| Performance under stress (30%) | rAF coalescing by design (all engines) + Phase 7 measured evidence |
| Order book depth (20%) | Phase 4: integer-tick grouping, unit tests across all 6 precisions |
| Problem decomposition (20%) | Commit-per-step git log + the 1–2 page doc with real numbers |
