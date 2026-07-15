import { describe, expect, it, vi } from "vitest";
import type { TradeMessage } from "../types/messages";
import { TradesEngine } from "./TradesEngine";
import type { TradeRow } from "./trades/merge";
import type { RollingStatsSnapshot } from "./trades/RollingStats";

function makeTrade(overrides: Partial<TradeMessage> = {}): TradeMessage {
  return {
    type: "all_trades",
    symbol: "BTCUSD",
    price: "63588.4",
    size: 10,
    buyer_role: "taker",
    seller_role: "maker",
    timestamp: 0,
    ...overrides,
  };
}

function lastRowsCall(
  publishTrades: ReturnType<typeof vi.fn>,
): readonly TradeRow[] {
  const calls = publishTrades.mock.calls;
  const last = calls[calls.length - 1] as [readonly TradeRow[], number];
  return last[0];
}

function makeEngine(overrides: { getEpoch?: () => number }) {
  const publishTrades = vi.fn();
  const publishStats = vi.fn();
  const engine = new TradesEngine({
    publishTrades,
    publishStats,
    getEpoch: overrides.getEpoch ?? (() => 0),
  });
  return { engine, publishTrades, publishStats };
}

describe("TradesEngine pending queue", () => {
  it("sheds the oldest pending trades once over the 2000 cap", () => {
    const { engine, publishTrades } = makeEngine({});

    // 2005 trades, distinct prices so none merge, before any flush.
    for (let i = 0; i < 2005; i++) {
      engine.onMessage(
        makeTrade({ price: `${i}.0`, timestamp: i * 1000, size: 1 }),
      );
    }
    engine.flush(0);

    const rows = lastRowsCall(publishTrades);
    // 200-row visible ring further caps it: only the newest 200 of the
    // (already-shed-to-2000) pending trades survive.
    expect(rows).toHaveLength(200);
    expect(rows[0]?.price).toBe(1805);
    expect(rows[rows.length - 1]?.price).toBe(2004);
  });
});

describe("TradesEngine epoch guard", () => {
  it("drops a trade buffered under a stale epoch without merging it in", () => {
    let epoch = 0;
    const { engine, publishTrades } = makeEngine({ getEpoch: () => epoch });

    engine.onMessage(makeTrade({ price: "1.0" }));
    epoch = 1; // reconnect or focus switch happens before the next flush
    engine.flush(0);

    // The stale trade never made it into a published row.
    expect(publishTrades).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ price: 1.0 })]),
      expect.anything(),
    );
  });

  it("clears previously-merged rows once the epoch advances", () => {
    let epoch = 0;
    const { engine, publishTrades } = makeEngine({ getEpoch: () => epoch });

    engine.onMessage(makeTrade({ price: "1.0" }));
    engine.flush(0);
    expect(lastRowsCall(publishTrades)).toHaveLength(1);

    epoch = 1;
    engine.onMessage(makeTrade({ price: "2.0", timestamp: 1000 }));
    engine.flush(1);

    const rows = lastRowsCall(publishTrades);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.price).toBe(2.0);
  });

  it("resets rolling stats once the epoch advances, not just the rows", () => {
    let epoch = 0;
    const publishStats = vi.fn();
    const engine = new TradesEngine({
      publishTrades: vi.fn(),
      publishStats,
      getEpoch: () => epoch,
    });

    engine.onMessage(makeTrade({ size: 50 }));
    engine.flush(0);
    const firstStats = publishStats.mock.calls[0]?.[0] as RollingStatsSnapshot;
    expect(firstStats.buyVol).toBe(50);

    epoch = 1;
    engine.onMessage(makeTrade({ size: 7, timestamp: 2000 }));
    engine.flush(2000);
    const calls = publishStats.mock.calls;
    const secondStats = calls[calls.length - 1]?.[0] as RollingStatsSnapshot;
    expect(secondStats.buyVol).toBe(7); // not 57 — the old trade is gone
  });

  it("does not republish trades on a flush with no new merged data", () => {
    const { engine, publishTrades } = makeEngine({});
    engine.onMessage(makeTrade());
    engine.flush(0);
    expect(publishTrades).toHaveBeenCalledTimes(1);

    engine.flush(16); // next rAF tick, nothing pending
    expect(publishTrades).toHaveBeenCalledTimes(1);
  });
});

describe("TradesEngine merge", () => {
  it("merges same-price trades within 100ms into one row via mergeIntoRows", () => {
    const { engine, publishTrades } = makeEngine({});
    engine.onMessage(makeTrade({ timestamp: 0, size: 10 }));
    engine.onMessage(makeTrade({ timestamp: 50_000, size: 5 })); // 50ms later
    engine.flush(0);

    const rows = lastRowsCall(publishTrades);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.size).toBe(15);
    expect(rows[0]?.count).toBe(2);
  });

  it("publishes the plain merged rows, with no large-trade flag attached", () => {
    const { engine, publishTrades } = makeEngine({});
    engine.onMessage(makeTrade({ price: "10.0", size: 20, timestamp: 0 }));
    engine.flush(0);

    const rows = lastRowsCall(publishTrades);
    expect(rows[0]).not.toHaveProperty("large");
  });
});

describe("TradesEngine perceptual feed throttle", () => {
  it("drains every flush but publishes the feed at most once per refreshMs, as one batch", () => {
    const publishTrades = vi.fn();
    const publishStats = vi.fn();
    const engine = new TradesEngine({
      publishTrades,
      publishStats,
      getEpoch: () => 0,
      refreshMs: 1000,
    });

    engine.onMessage(makeTrade({ price: "1.0", timestamp: 0, size: 1 }));
    engine.flush(0); // first feed publish is immediate
    expect(publishTrades).toHaveBeenCalledTimes(1);

    engine.onMessage(makeTrade({ price: "2.0", timestamp: 100_000, size: 1 }));
    engine.flush(200); // within interval -> row drained internally, not published
    expect(publishTrades).toHaveBeenCalledTimes(1);

    engine.onMessage(makeTrade({ price: "3.0", timestamp: 300_000, size: 1 }));
    engine.flush(1000); // interval elapsed -> one publish carrying the whole batch
    expect(publishTrades).toHaveBeenCalledTimes(2);

    const rows = lastRowsCall(publishTrades);
    expect(rows.map((r) => r.price)).toEqual([1, 2, 3]);
  });
});

describe("TradesEngine 1Hz stats cadence", () => {
  it("publishes stats immediately on the first flush, then at most once per second", () => {
    const { engine, publishStats } = makeEngine({});

    engine.onMessage(makeTrade());
    engine.flush(0);
    expect(publishStats).toHaveBeenCalledTimes(1);

    engine.flush(500); // same wall-clock second, no republish
    expect(publishStats).toHaveBeenCalledTimes(1);

    engine.flush(999);
    expect(publishStats).toHaveBeenCalledTimes(1);

    engine.flush(1000); // new second
    expect(publishStats).toHaveBeenCalledTimes(2);
  });

  it("keeps publishing stats at 1Hz even with no new trades (stats decay during lulls)", () => {
    const { engine, publishStats } = makeEngine({});

    engine.onMessage(makeTrade({ timestamp: 0 }));
    engine.flush(0);
    expect(publishStats).toHaveBeenCalledTimes(1);

    engine.flush(1000);
    engine.flush(2000);
    expect(publishStats).toHaveBeenCalledTimes(3);
  });
});
