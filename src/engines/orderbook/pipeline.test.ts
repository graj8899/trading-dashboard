import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SYMBOL_CONFIG, SYMBOLS, type Symbol } from "../../config/symbols";
import type { OrderbookMessage } from "../../types/messages";
import { parseAndGroup } from "./pipeline";

type RawLevel = [string, string];

function priceAtTicks(ticks: number, scale: number, precision: number): string {
  return (ticks / scale).toFixed(precision);
}

// Builds `count` raw levels starting at `baseTicks`, stepping by one tick
// (the finest resolution the symbol's precision allows) in `direction`.
function buildLevels(
  baseTicks: number,
  direction: 1 | -1,
  count: number,
  scale: number,
  precision: number,
  size: string,
): RawLevel[] {
  const levels: RawLevel[] = [];
  for (let i = 0; i < count; i++) {
    const ticks = baseTicks + direction * i;
    levels.push([priceAtTicks(ticks, scale, precision), size]);
  }
  return levels;
}

function makeMessage(
  symbol: Symbol,
  bids: RawLevel[],
  asks: RawLevel[],
): OrderbookMessage {
  return {
    type: "l2_orderbook",
    symbol,
    bids,
    asks,
    timestamp: 1_783_963_314_112_000,
  };
}

function loadFixture(): OrderbookMessage {
  const fixturePath = fileURLToPath(
    new URL("../../../docs/fixtures/orderbook.json", import.meta.url),
  );
  const parsed: unknown = JSON.parse(readFileSync(fixturePath, "utf-8"));
  return parsed as OrderbookMessage;
}

describe("parseAndGroup", () => {
  describe("per-symbol × per-ladder-increment sweep", () => {
    for (const symbol of SYMBOLS) {
      const { precision, groupingLadder, range } = SYMBOL_CONFIG[symbol];
      const scale = 10 ** precision;
      const basePrice = range[0] + (range[1] - range[0]) / 2;
      const baseTicks = Math.round(basePrice * scale);

      // 300 raw levels/side at the finest tick resolution — enough to
      // exercise every increment on the symbol's ladder.
      const bids = buildLevels(baseTicks, -1, 300, scale, precision, "1.0000");
      const asks = buildLevels(baseTicks + 1, 1, 300, scale, precision, "1.0000");
      const msg = makeMessage(symbol, bids, asks);

      for (const increment of groupingLadder) {
        it(`${symbol} @ increment ${increment}: grouped levels are valid`, () => {
          const view = parseAndGroup(msg, increment, precision, 12);
          const g = Math.round(increment * scale);

          for (const side of [view.bids, view.asks]) {
            expect(side.length).toBeLessThanOrEqual(12);

            let prevCumulative = 0;
            for (const level of side) {
              expect(Number.isFinite(level.price)).toBe(true);
              expect(Number.isFinite(level.size)).toBe(true);
              expect(level.size).toBeGreaterThan(0);

              // Every displayed price must land exactly on the grouping grid.
              const priceTicks = Math.round(level.price * scale);
              expect(priceTicks % g).toBe(0);

              // Cumulative is a running sum: strictly increasing since sizes > 0.
              expect(level.cumulative).toBeGreaterThan(prevCumulative);
              prevCumulative = level.cumulative;
            }
          }

          expect(Number.isFinite(view.mid)).toBe(true);
          expect(Number.isFinite(view.spreadBps)).toBe(true);
          expect(Number.isFinite(view.imbalance)).toBe(true);
          expect(view.maxCum).toBeGreaterThanOrEqual(0);
        });
      }
    }
  });

  describe("bid/ask boundary rounding (floor vs ceil)", () => {
    it("floors bids and ceils asks to the grouping grid", () => {
      // BTCUSD, precision 1 (scale 10), grouping increment 5 -> g = 50 ticks.
      const precision = 1;

      // 61787.3 -> ticks 617873 -> floor(617873/50)*50 = 617850 -> 61785.0
      const bids: RawLevel[] = [["61787.3", "1.0000"]];
      // 61787.8 -> ticks 617878 -> ceil(617878/50)*50 = 617900 -> 61790.0
      const asks: RawLevel[] = [["61787.8", "1.0000"]];

      const msg = makeMessage("BTCUSD", bids, asks);
      const view = parseAndGroup(msg, 5, precision, 12);

      expect(view.bids[0]?.price).toBe(61785.0);
      expect(view.asks[0]?.price).toBe(61790.0);
    });

    it("leaves a price already exactly on the grid unchanged for both sides", () => {
      const precision = 1;
      // 61785.0 -> ticks 617850, exactly divisible by g=50.
      const bids: RawLevel[] = [["61785.0", "1.0000"]];
      const asks: RawLevel[] = [["61785.0", "1.0000"]];

      const msg = makeMessage("BTCUSD", bids, asks);
      const view = parseAndGroup(msg, 5, precision, 12);

      expect(view.bids[0]?.price).toBe(61785.0);
      expect(view.asks[0]?.price).toBe(61785.0);
    });

    it("a one-tick nudge across the boundary moves the ask bucket up but not the bid bucket", () => {
      const precision = 1;
      // 61785.1 -> ticks 617851, one above the grid line at 617850.
      const bids: RawLevel[] = [["61785.1", "1.0000"]]; // floor -> 617850 -> 61785.0
      const asks: RawLevel[] = [["61785.1", "1.0000"]]; // ceil  -> 617900 -> 61790.0

      const msg = makeMessage("BTCUSD", bids, asks);
      const view = parseAndGroup(msg, 5, precision, 12);

      expect(view.bids[0]?.price).toBe(61785.0);
      expect(view.asks[0]?.price).toBe(61790.0);
    });
  });

  describe("size aggregation across merged levels", () => {
    it("sums sizes of raw levels that fall in the same bucket", () => {
      const precision = 1;
      // g = 50 ticks (increment 5): bucket 617850 spans ticks [617850, 617899]
      // i.e. price [61785.0, 61789.9]. All three land in it.
      const bids: RawLevel[] = [
        ["61789.9", "1.0000"],
        ["61787.3", "0.5000"],
        ["61785.0", "2.5000"],
      ];
      const asks: RawLevel[] = [["61787.8", "1.0000"]];

      const msg = makeMessage("BTCUSD", bids, asks);
      const view = parseAndGroup(msg, 5, precision, 12);

      expect(view.bids).toHaveLength(1);
      expect(view.bids[0]?.size).toBeCloseTo(4.0, 10);
      expect(view.bids[0]?.cumulative).toBeCloseTo(4.0, 10);
    });

    it("keeps distinct buckets separate and accumulates cumulative correctly", () => {
      const precision = 1;
      // g = 50 ticks. First two land in bucket 617850 [61785.0, 61789.9];
      // third falls in the lower bucket 617750 (617790 -> floor -> 617750).
      const bids: RawLevel[] = [
        ["61789.9", "1.0000"], // bucket 617850
        ["61785.0", "2.0000"], // bucket 617850
        ["61779.0", "3.0000"], // bucket 617750
      ];
      const asks: RawLevel[] = [["61787.8", "1.0000"]];

      const msg = makeMessage("BTCUSD", bids, asks);
      const view = parseAndGroup(msg, 5, precision, 12);

      expect(view.bids.length).toBeGreaterThanOrEqual(1);
      const first = view.bids[0];
      expect(first?.size).toBeCloseTo(3.0, 10);
      expect(first?.cumulative).toBeCloseTo(3.0, 10);
      if (view.bids.length > 1) {
        const second = view.bids[1];
        expect(second?.cumulative).toBeGreaterThan(first?.cumulative ?? 0);
      }
    });
  });

  describe("DOGEUSD 6dp exactness", () => {
    it("round-trips prices exactly with no grouping (g = 1 tick)", () => {
      const precision = 6;
      const prices = ["0.012345", "0.012346", "0.099999", "0.000001"];
      const bids: RawLevel[] = prices.map((p) => [p, "10.000000"] as RawLevel);
      const asks: RawLevel[] = [["0.050000", "10.000000"]];

      const msg = makeMessage("DOGEUSD", bids, asks);
      // Finest ladder increment for DOGEUSD is 0.000001 -> g = 1 tick.
      const view = parseAndGroup(msg, 0.000001, precision, 12);

      // Bids come back best->worst, i.e. sorted descending; verify the set
      // of returned prices matches the input exactly (no drift).
      const returned = view.bids.map((l) => l.price).sort((a, b) => a - b);
      const expected = prices.map((p) => Number(p)).sort((a, b) => a - b);
      expect(returned).toEqual(expected);
    });

    it("groups DOGEUSD to a coarser rung without float drift", () => {
      const precision = 6;
      // increment 0.0001 -> g = 100 ticks.
      const bids: RawLevel[] = [["0.012345", "1.000000"]];
      const asks: RawLevel[] = [["0.012399", "1.000000"]];

      const msg = makeMessage("DOGEUSD", bids, asks);
      const view = parseAndGroup(msg, 0.0001, precision, 12);

      // 0.012345 -> ticks 12345 -> floor(12345/100)*100 = 12300 -> 0.0123
      expect(view.bids[0]?.price).toBe(0.0123);
      // 0.012399 -> ticks 12399 -> ceil(12399/100)*100 = 12400 -> 0.0124
      expect(view.asks[0]?.price).toBe(0.0124);
    });
  });

  describe("early exit", () => {
    it("stops scanning once N buckets are complete, ignoring poisoned trailing data", () => {
      const precision = 1;
      const scale = 10;
      const n = 12;
      const baseTicks = Math.round(61785.0 * scale);

      // g = 1 tick (increment 0.1) so every raw level is its own bucket.
      // n+2 valid, strictly descending, distinct-bucket levels...
      const validBids = buildLevels(baseTicks, -1, n + 2, scale, precision, "1.0000");
      // ...followed by entries that would blow up if ever parsed.
      const poisonBids: RawLevel[] = Array.from({ length: 50 }, () => [
        "not-a-number",
        "not-a-number",
      ]);
      const bids = [...validBids, ...poisonBids];
      const asks: RawLevel[] = [["61787.8", "1.0000"]];

      const msg = makeMessage("BTCUSD", bids, asks);
      const view = parseAndGroup(msg, 0.1, precision, n);

      expect(view.bids).toHaveLength(n);
      for (const level of view.bids) {
        expect(Number.isFinite(level.price)).toBe(true);
        expect(Number.isFinite(level.size)).toBe(true);
      }
      // The first n buckets correspond exactly to the first n valid raw levels.
      const expectedPrices = validBids
        .slice(0, n)
        .map(([p]) => Number(p));
      expect(view.bids.map((l) => l.price)).toEqual(expectedPrices);
    });
  });

  describe("spread/mid/imbalance derived from the grouped view", () => {
    it("uses grouped bucket prices, not raw best prices, for mid and spread", () => {
      const precision = 1;
      // g = 50 ticks (increment 5).
      // raw best bid 61787.3 -> bucket 61785.0 ; raw best ask 61787.8 -> bucket 61790.0
      const bids: RawLevel[] = [["61787.3", "1.0000"]];
      const asks: RawLevel[] = [["61787.8", "1.0000"]];

      const msg = makeMessage("BTCUSD", bids, asks);
      const view = parseAndGroup(msg, 5, precision, 12);

      // If mid/spread were computed from raw best prices, mid would be
      // 61787.55 and spreadAbs would be 0.5 — assert the grouped values.
      expect(view.mid).toBeCloseTo(61787.5, 10);
      expect(view.spreadAbs).toBeCloseTo(5.0, 10);
      expect(view.spreadBps).toBeCloseTo((5.0 / 61787.5) * 10000, 6);
    });

    it("computes imbalance as the ratio of total visible bid to ask size", () => {
      const precision = 1;
      const bids: RawLevel[] = [
        ["61785.0", "3.0000"],
        ["61780.0", "1.0000"],
      ];
      const asks: RawLevel[] = [["61790.0", "2.0000"]];

      const msg = makeMessage("BTCUSD", bids, asks);
      const view = parseAndGroup(msg, 5, precision, 12);

      const bidTotal = view.bids.reduce((sum, l) => sum + l.size, 0);
      const askTotal = view.asks.reduce((sum, l) => sum + l.size, 0);
      expect(view.imbalance).toBeCloseTo(bidTotal / askTotal, 10);
    });
  });

  describe("real fixture (BTCUSD live capture)", () => {
    it("produces a sane, fully-derived view from the captured snapshot", () => {
      const msg = loadFixture();
      const { precision } = SYMBOL_CONFIG.BTCUSD;

      const view = parseAndGroup(msg, 5, precision, 12);

      expect(view.symbol).toBe("BTCUSD");
      expect(view.bids.length).toBeGreaterThan(0);
      expect(view.bids.length).toBeLessThanOrEqual(12);
      expect(view.asks.length).toBeGreaterThan(0);
      expect(view.asks.length).toBeLessThanOrEqual(12);

      // Book is bid-below-ask; mid should sit between best bid and best ask.
      const bestBid = view.bids[0];
      const bestAsk = view.asks[0];
      expect(bestBid).toBeDefined();
      expect(bestAsk).toBeDefined();
      if (bestBid && bestAsk) {
        expect(bestAsk.price).toBeGreaterThan(bestBid.price);
        expect(view.mid).toBeGreaterThan(bestBid.price);
        expect(view.mid).toBeLessThan(bestAsk.price);
      }
      expect(view.spreadAbs).toBeGreaterThan(0);
      expect(view.spreadBps).toBeGreaterThan(0);
      expect(view.imbalance).toBeGreaterThan(0);
      expect(view.maxCum).toBeGreaterThan(0);

      // Cumulative sums are monotonic on both sides.
      for (const side of [view.bids, view.asks]) {
        let prev = 0;
        for (const level of side) {
          expect(level.cumulative).toBeGreaterThan(prev);
          prev = level.cumulative;
        }
      }
    });
  });
});
