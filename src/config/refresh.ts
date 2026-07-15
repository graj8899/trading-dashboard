// ─────────────────────────────────────────────────────────────────────────
// Perceptual refresh cadence.
//
// The wire delivers market data far faster than a human can read — several
// snapshots and many trades per second. The engines still INGEST every
// message at wire speed (lossless: the order book keeps the latest snapshot,
// the trades engine drains every frame into its rows + rolling stats), but
// they PUBLISH to the React stores at most once per REFRESH_MS.
//
// This matches the readable cadence of production trading UIs (e.g. Delta
// Exchange) — the book and tape update on a steady ~1s beat instead of
// strobing at the animation-frame rate — while keeping the data underneath
// complete and current. Epoch changes (reconnect / focus switch) bypass the
// throttle for an immediate publish so nothing feels laggy.
//
// Single knob by design: change this one constant to retune the whole app.
// ─────────────────────────────────────────────────────────────────────────
export const REFRESH_MS = 1000;
