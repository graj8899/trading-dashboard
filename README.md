# Trading Dashboard

Real-time trading dashboard over a custom WebSocket load-test backend
(`socket-custom-load`): 6 symbols, three streams (`v2/ticker`,
`l2_orderbook`, `all_trades`). Built with Vite + React 18 + TypeScript
(strict) + Zustand.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design and
measured performance, and [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md)
for an honest list of limitations.

## Prerequisites

- Node.js 18+ and npm
- The `socket-custom-load` backend repo, checked out **alongside** this one,
  with its own dependencies installed (`bun install`, or see its README for
  Docker). It exposes:
  - `ws://localhost:8080` — market data
  - `http://localhost:3000/intervals` — runtime stress config (GET/POST)

## Running (backend + frontend side by side)

```bash
# terminal 1 — backend
cd ../socket-custom-load
bun start          # or: docker compose up

# terminal 2 — this repo
cd trading-dashboard
npm install
npm run dev         # http://localhost:5173
```

The frontend connects to `ws://localhost:8080` on load (hardcoded — this is
a local evaluation harness, not a deployed config). If the backend isn't up
yet, the connection badge shows `reconnecting` and self-heals with backoff
once it is.

Press the backtick key (`` ` ``) to toggle a dev-only metrics overlay
(messages/s, flushes/s, drop ratio, flush duration, FPS, JS heap). It's
stripped from production builds (`import.meta.env.DEV`-gated) and adds
effectively zero cost when hidden.

## Features, mapped to the assignment

**1. Real-time ticker strip** — `TickerEngine` + `tickers` store +
`TickerCell`. Per-symbol `memo`'d cells with narrow selectors so an update
to one symbol repaints only that cell (`docs/evidence/profiler-ticker-isolation.png`);
correlated multi-symbol ticks still batch into a single rAF commit
(`profiler-ticker-coalescing.png`).

**2. Order book with grouping** — `OrderBookEngine` (integer-tick
parse/group/derive pipeline, see `ARCHITECTURE.md` §3) + `orderbook` store +
`OrderBookPanel`. Depth bars, mid/spread/imbalance derived from the grouped
view, per-symbol grouping-ladder selector, flash highlighting on size
changes (rate-limited — see Known Issues).

**3. Trade feed with stats** — `TradesEngine` (bounded pending queue,
merge, 200-row ring, 1Hz rolling stats) + `trades`/`tradeStats` stores +
`TradesPanel` / `RollingStatsBar`. Derived buy/sell side, large-trade
highlighting against a per-symbol, user-editable threshold.

Cross-cutting: focus-switch handling (epoch-guarded resubscribe, see
`ARCHITECTURE.md` §1), reconnect with exponential backoff + jitter,
localStorage-persisted preferences (focused symbol, grouping, thresholds).

## Stress-testing with the backend's `/intervals` API

The backend's defaults already push real load (120–600 msg/s across
`v2/ticker`, up to 100K price tuples/s to parse for `l2_orderbook`). To push
past that and reproduce the numbers in `ARCHITECTURE.md` §2:

```bash
# check current intervals
curl http://localhost:3000/intervals

# push to evaluation-level stress (min/max in ms; lower = faster)
curl -X POST http://localhost:3000/intervals \
  -H "Content-Type: application/json" \
  -d '{
    "all_trades":   { "min": 1,  "max": 5  },
    "l2_orderbook": { "min": 10, "max": 20 },
    "v2/ticker":    { "min": 10, "max": 20 }
  }'

# tighten orderbook further once the overlay is stable
curl -X POST http://localhost:3000/intervals \
  -H "Content-Type: application/json" \
  -d '{ "l2_orderbook": { "min": 1, "max": 5 } }'

# restore defaults
curl -X POST http://localhost:3000/intervals \
  -H "Content-Type: application/json" \
  -d '{
    "all_trades":   { "min": 5,  "max": 20 },
    "l2_orderbook": { "min": 10, "max": 40 },
    "v2/ticker":    { "min": 10, "max": 50 }
  }'
```

Watch the metrics overlay (backtick key) and Chrome's Performance Monitor
(DOM nodes, JS heap) while stressing. `min` must be `>= 1` and `max >= min`
per channel or the backend returns `400`.

## Tests

```bash
npm test
```

Vitest, colocated with source:

- `src/engines/orderbook/pipeline.test.ts`, `src/engines/OrderBookEngine.test.ts`
  — integer-tick grouping across all 6 symbol precisions, including the
  DOGEUSD 6dp round-trip.
- `src/engines/TradesEngine.test.ts`, `src/engines/trades/merge.test.ts`,
  `src/engines/trades/RollingStats.test.ts` — merge/dedupe, ring eviction,
  rolling-window stats.
- `src/transport/SubscriptionManager.test.ts`, `src/transport/bootTransport.test.ts`
  — desired-state diffing, ack reconciliation, focus-switch epoch flow.
- `src/metrics/engineMetrics.test.ts` — flush/drop accounting.

## Build

```bash
npm run build   # tsc -b && vite build
npm run lint
```
