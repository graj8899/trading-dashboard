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

<!-- Phase 4+ prompts appended here as each phase completes. -->



