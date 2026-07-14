import { beforeEach, describe, expect, it } from "vitest";
import {
  isMetricsEnabled,
  readEngineMetrics,
  recordFlush,
  recordMessage,
  setMetricsEnabled,
} from "./engineMetrics";

describe("engineMetrics gating", () => {
  beforeEach(() => {
    setMetricsEnabled(false);
  });

  it("starts disabled", () => {
    expect(isMetricsEnabled()).toBe(false);
  });

  it("does not record messages or flushes while disabled", () => {
    recordMessage("ticker");
    recordFlush("ticker", 5, true);

    expect(readEngineMetrics("ticker")).toEqual({
      messagesIn: 0,
      flushesOut: 0,
      lastFlushMs: 0,
      p95FlushMs: 0,
    });
  });

  it("records messages and flushes once enabled", () => {
    setMetricsEnabled(true);

    recordMessage("ticker");
    recordMessage("ticker");
    recordFlush("ticker", 3, true);

    const snapshot = readEngineMetrics("ticker");
    expect(snapshot.messagesIn).toBe(2);
    expect(snapshot.flushesOut).toBe(1);
    expect(snapshot.lastFlushMs).toBe(3);
  });

  it("stops recording again once disabled", () => {
    setMetricsEnabled(true);
    recordMessage("orderbook");
    setMetricsEnabled(false);
    recordMessage("orderbook");

    expect(readEngineMetrics("orderbook").messagesIn).toBe(1);
  });

  it("resets counters every time metrics are (re-)enabled", () => {
    setMetricsEnabled(true);
    recordMessage("trades");
    recordFlush("trades", 10, true);
    expect(readEngineMetrics("trades").messagesIn).toBe(1);

    setMetricsEnabled(false);
    setMetricsEnabled(true); // toggled back on — should start clean

    const snapshot = readEngineMetrics("trades");
    expect(snapshot.messagesIn).toBe(0);
    expect(snapshot.flushesOut).toBe(0);
    expect(snapshot.lastFlushMs).toBe(0);
  });

  it("only increments flushesOut for flushes flagged as published", () => {
    setMetricsEnabled(true);
    recordFlush("ticker", 1, false);
    recordFlush("ticker", 2, true);
    recordFlush("ticker", 3, false);

    const snapshot = readEngineMetrics("ticker");
    expect(snapshot.flushesOut).toBe(1);
    expect(snapshot.lastFlushMs).toBe(3); // lastFlushMs tracks every flush
  });

  it("keeps engines' counters independent of one another", () => {
    setMetricsEnabled(true);
    recordMessage("ticker");
    recordMessage("ticker");
    recordMessage("orderbook");

    expect(readEngineMetrics("ticker").messagesIn).toBe(2);
    expect(readEngineMetrics("orderbook").messagesIn).toBe(1);
    expect(readEngineMetrics("trades").messagesIn).toBe(0);
  });
});

describe("p95FlushMs", () => {
  beforeEach(() => {
    setMetricsEnabled(true);
  });

  it("is 0 with no samples", () => {
    expect(readEngineMetrics("ticker").p95FlushMs).toBe(0);
  });

  it("is the max with a single sample", () => {
    recordFlush("ticker", 7, true);
    expect(readEngineMetrics("ticker").p95FlushMs).toBe(7);
  });

  it("reflects the 95th percentile across many samples", () => {
    // 1..100 ms: p95 should sit near the top of the distribution, not
    // dragged down by the many small values.
    for (let ms = 1; ms <= 100; ms++) {
      recordFlush("ticker", ms, true);
    }
    const p95 = readEngineMetrics("ticker").p95FlushMs;
    expect(p95).toBeGreaterThanOrEqual(90);
    expect(p95).toBeLessThanOrEqual(100);
  });

  it("is not skewed by a single early outlier once enough samples roll past it", () => {
    recordFlush("ticker", 500, true); // one huge spike
    for (let i = 0; i < 200; i++) {
      recordFlush("ticker", 2, true); // then steady, fast flushes
    }
    // The bounded sample window means the old spike eventually rolls off.
    expect(readEngineMetrics("ticker").p95FlushMs).toBe(2);
  });
});
