# Production Considerations & Interview Talking Points

Ideas that go **beyond the assignment's deliberately-contained scope** — not
built (the spec rewards depth over breadth and a rock-solid 90%), but captured
here as "what I'd do in a real deployment" for discussion.

---

## Perceptual refresh vs. data refresh

**Observation.** Under stress the UI repaints at ~60fps (rAF-coalesced), but a
human can only read a few updates per second. With the test backend — which
emits a *fresh random mid per snapshot* — the order book and trades feed look
like noise. (Real market data is continuous, so a real book barely moves
between ticks and reads fine; the strobe is the mock harness, not the render
path.)

**The three rates, kept distinct.**
1. **Ingestion** — the firehose (200–1,000 msg/s). Must be handled.
2. **Render** — how often we repaint (~60fps, rAF-coalesced). What's graded.
3. **Perception** — what a person can actually absorb (a handful/sec).

The current design correctly decouples (1) from (2). The gap between (2) and
(3) is a *usability* concern, not a performance one.

**What I'd add in production — a perceptual-refresh layer *on top of*
full-rate ingestion:**
- Configurable "visible refresh" cap for the order book (e.g. repaint the
  book at ~8–10fps) while the last-traded price and connection state still
  tick at full rate — the book is for *reading depth*, not for watching every
  micro-change.
- Optional price/size smoothing or short interpolation so levels ease rather
  than snap.
- A "freeze on hover / hold to read" affordance so a user can pause the feed
  to inspect a level without fighting the stream.

**Key point for the interview:** this layer sits *above* an engine that already
ingests the full firehose — I would **not** slow the ingestion or data path to
achieve readability. Throttling everything to 1Hz would undersell the
coalescing architecture and violate the spec's "real-time" requirement; the
right move is to separate *perceptual* cadence from *data* cadence.

Why it's not in the submission: the assignment explicitly scopes this out
("not a full trading terminal", "visual design is not tested", "depth over
breadth"), and only the rolling-stats bar is required at 1Hz (already done).

---

<!-- Further production ideas appended below as we discuss them. -->
