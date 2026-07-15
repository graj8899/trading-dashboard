# Known Issues

Real limitations, stated plainly — not "future work," just what's true today.

## Trades feed

- **Feed trims oldest rows off the top; scroll position isn't preserved.**
  The 200-row ring drops the oldest trade as new ones arrive. If you've
  scrolled up to inspect older trades under high trade volume, rows you're
  looking at shift or fall off without warning — there's no scroll anchor
  or "new trades" pause. Reading history mid-stream is unreliable.
- **200-row cap, no virtualization.** `TradesPanel` isn't per-row memoized
  the way `OrderBookRow` is — the full visible list re-renders on every
  flush (~2.8ms for 200 rows, see `evidence/profiler-trades-isolation.png`).
  Fine at 200 rows; would need row-level `memo` or a virtualized list before
  raising the cap materially (e.g. to 1,000+).
- **Pending-queue sheds oldest beyond 2,000.** If incoming trades outpace
  what one rAF frame can drain, `TradesEngine`'s pending queue drops the
  oldest unprocessed trade past 2,000 items rather than growing unbounded.
  This is silent — no dropped-count is surfaced in the UI. In practice the
  queue drains every frame at measured peak load (~925 msg/s total); this
  only bites well above that.
- **Large-trade highlighting is somewhat artificial.** The backend
  generates trade sizes in a near-uniform range (~96–106 observed), so
  "large trade" thresholds are more a UI feature demo than a signal that
  would mean anything against a real, heavy-tailed trade-size distribution.
- **Rolling-stats bar reads 0 for ~1s after a focus switch.** The stats
  window resets on the epoch bump that accompanies a symbol switch, so the
  bar shows zero volume/counts until enough new trades arrive to repopulate
  it — even though the trade feed itself starts showing data immediately.

## Order book

- **Flash highlighting is rate-limited to 300ms per row/bucket, and that
  limit doesn't reflect anything about the market.** Each backend orderbook
  snapshot is generated around a fresh random mid with no continuity from
  the last one, so the spec's ">10% size change" flash rule fires on nearly
  every bucket, every update, by construction of the mock data — not
  because of real order flow. Without the 300ms limit the book is a
  constant strobe. The limit is a UX patch for uncorrelated mock snapshots,
  not a meaningful signal threshold.
- **In-flight-message focus-switch edge (documented, not observed).**
  Engines stamp each message with the epoch at *arrival* and don't filter
  by symbol. In the sub-millisecond window between an epoch bump (on focus
  switch) and the corresponding unsubscribe taking effect, a message for
  the *old* symbol could in principle be stamped with the new epoch and
  render for one frame under the new symbol's panel. Never observed on
  localhost across manual rapid-switch testing (including BTC↔DOGE); would
  require per-message symbol filtering, not just epoch checks, to close
  completely.
- **Spread and mid are computed from the grouped view, not the raw
  best bid/ask.** This is what the spec asks for, but it means spread
  visibly widens at coarser groupings — it's not the "true" top-of-book
  spread you'd get from ungrouped data.

## General

- The WebSocket URL (`ws://localhost:8080`) is hardcoded, not
  environment-configured — fine for local evaluation, would need an env var
  for any other deployment target.
- `performance.memory` (used for the heap reading in the metrics overlay)
  is a non-standard, Chrome-only API; the overlay shows no heap figure in
  other browsers.

## Resolved (not open, noted for the record)

- **User Timing heap retention.** A heap snapshot under stress showed ~70%
  of the heap retained by `PerformanceMeasure`/`blink::UserTiming` —
  `performance.mark`/`measure` entries from the metrics instrumentation
  accumulating faster than `clearMarks`/`clearMeasures` reclaimed them.
  Fixed by replacing mark/measure with a plain `performance.now()` delta
  (`src/metrics/instrument.ts`) — same duration and resolution, zero
  timeline entries created.
- **DOM node growth from the flash overlay.** Chrome's Performance Monitor
  showed DOM node count climbing to 72k+ under constant-flash stress. Cause:
  the order-book flash overlay mounted a *new* keyed, CSS-animated `<div>`
  per flash event (~1,400/s at peak), and a detached element with a running
  CSS animation isn't garbage-collected until the animation finishes. Fixed
  by using one stable, persistent overlay `<div>` per row, tinted via a CSS
  `background-color` transition instead of a remounted keyframe animation
  (`src/components/OrderBookPanel.tsx`) — zero DOM churn, node count flat.
