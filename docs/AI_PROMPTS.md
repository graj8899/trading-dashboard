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

<!-- Phase 2+ prompts appended here as each phase completes. -->

