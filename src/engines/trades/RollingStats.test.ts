import { describe, expect, it } from "vitest";
import { RollingStats } from "./RollingStats";

const SECOND_MS = 1000;

describe("RollingStats", () => {
  it("starts empty", () => {
    const stats = new RollingStats();
    expect(stats.getStats()).toEqual({
      buyVol: 0,
      sellVol: 0,
      count: 0,
      avgSize: 0,
    });
  });

  it("accumulates buy/sell volume, count, and avgSize for trades within the window", () => {
    const stats = new RollingStats();
    stats.record("buy", 10, 0);
    stats.record("sell", 4, 500);
    stats.record("buy", 6, 999);

    const snapshot = stats.getStats();
    expect(snapshot.buyVol).toBe(16);
    expect(snapshot.sellVol).toBe(4);
    expect(snapshot.count).toBe(3);
    expect(snapshot.avgSize).toBeCloseTo(20 / 3, 10);
  });

  it("keeps trades from multiple distinct seconds within the last 60s", () => {
    const stats = new RollingStats();
    for (let s = 0; s < 60; s++) {
      stats.record("buy", 1, s * SECOND_MS);
    }
    expect(stats.getStats()).toEqual({
      buyVol: 60,
      sellVol: 0,
      count: 60,
      avgSize: 1,
    });
  });

  describe("ring wraparound at 60s", () => {
    it("evicts a trade once a trade 60+ seconds newer is recorded", () => {
      const stats = new RollingStats();
      stats.record("buy", 100, 0); // second 0

      // A trade at second 60 evicts second 0 (60s old, i.e. no longer
      // within the trailing 60s window ending at second 60).
      stats.record("buy", 1, 60 * SECOND_MS);

      const snapshot = stats.getStats();
      expect(snapshot.buyVol).toBe(1);
      expect(snapshot.count).toBe(1);
    });

    it("keeps a trade exactly 59s old (still inside the window)", () => {
      const stats = new RollingStats();
      stats.record("buy", 100, 0); // second 0
      stats.record("buy", 1, 59 * SECOND_MS); // second 59

      const snapshot = stats.getStats();
      expect(snapshot.buyVol).toBe(101);
      expect(snapshot.count).toBe(2);
    });

    it("correctly evicts across multiple full wraps of the ring", () => {
      const stats = new RollingStats();
      // One trade per second for 250 seconds; only the last 60 should
      // remain in the totals at any point, proven by the final snapshot.
      for (let s = 0; s < 250; s++) {
        stats.record("buy", 1, s * SECOND_MS);
      }
      const snapshot = stats.getStats();
      expect(snapshot.count).toBe(60);
      expect(snapshot.buyVol).toBe(60);
    });

    it("does not evict a bucket that never held data (partial ring fill)", () => {
      const stats = new RollingStats();
      stats.record("buy", 5, 0);
      stats.record("buy", 5, 1 * SECOND_MS);
      // Advance only 2 seconds forward — well under a full ring cycle.
      stats.record("buy", 5, 3 * SECOND_MS);

      expect(stats.getStats()).toEqual({
        buyVol: 15,
        sellVol: 0,
        count: 3,
        avgSize: 5,
      });
    });
  });

  describe("eviction correctness after gaps with no trades", () => {
    it("evicts stale data via tick() alone, with no intervening trades", () => {
      const stats = new RollingStats();
      stats.record("buy", 100, 0);

      // 65s of wall-clock time pass with no trades at all.
      stats.tick(65 * SECOND_MS);

      expect(stats.getStats()).toEqual({
        buyVol: 0,
        sellVol: 0,
        count: 0,
        avgSize: 0,
      });
    });

    it("does not evict via tick() if the gap is still within the window", () => {
      const stats = new RollingStats();
      stats.record("buy", 100, 0);
      stats.tick(30 * SECOND_MS);

      expect(stats.getStats().buyVol).toBe(100);
    });

    it("a huge gap (far beyond ring capacity) still resolves to a clean, empty ring", () => {
      const stats = new RollingStats();
      stats.record("buy", 100, 0);

      // 1 hour gap, no trades — way more seconds than the ring holds.
      stats.tick(60 * 60 * SECOND_MS);
      expect(stats.getStats()).toEqual({
        buyVol: 0,
        sellVol: 0,
        count: 0,
        avgSize: 0,
      });

      // The ring must still work correctly afterward (bucket slots properly
      // reset, not left in some corrupted post-huge-gap state).
      stats.record("sell", 7, 60 * 60 * SECOND_MS + 1);
      expect(stats.getStats()).toEqual({
        buyVol: 0,
        sellVol: 7,
        count: 1,
        avgSize: 7,
      });
    });

    it("evicts stale trades once new trades resume after a gap", () => {
      const stats = new RollingStats();
      stats.record("buy", 100, 0);

      // No trades for 70s, then trading resumes.
      const resumeMs = 70 * SECOND_MS;
      stats.record("sell", 3, resumeMs);

      const snapshot = stats.getStats();
      expect(snapshot.buyVol).toBe(0); // the stale trade is gone
      expect(snapshot.sellVol).toBe(3);
      expect(snapshot.count).toBe(1);
    });

    it("per-second ticks during a gap evict incrementally, matching a single big jump", () => {
      const stepped = new RollingStats();
      stepped.record("buy", 100, 0);
      for (let s = 1; s <= 65; s++) {
        stepped.tick(s * SECOND_MS);
      }

      const jumped = new RollingStats();
      jumped.record("buy", 100, 0);
      jumped.tick(65 * SECOND_MS);

      expect(stepped.getStats()).toEqual(jumped.getStats());
    });
  });

  it("getStats() is a pure read: calling it repeatedly does not change state", () => {
    const stats = new RollingStats();
    stats.record("buy", 10, 0);

    const first = stats.getStats();
    const second = stats.getStats();
    expect(second).toEqual(first);
  });
});
