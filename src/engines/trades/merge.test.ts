import { describe, expect, it } from "vitest";
import type { TradeMessage } from "../../types/messages";
import {
  deriveSide,
  formatTradeTime,
  mergeIntoRows,
  type TradeRow,
} from "./merge";

const BASE_TIMESTAMP_US = 1_783_963_314_096_000; // matches docs/fixtures/trades.json

function makeTrade(overrides: Partial<TradeMessage> = {}): TradeMessage {
  return {
    type: "all_trades",
    symbol: "BTCUSD",
    price: "63588.4",
    size: 96,
    buyer_role: "taker",
    seller_role: "maker",
    timestamp: BASE_TIMESTAMP_US,
    ...overrides,
  };
}

describe("deriveSide", () => {
  it("is a buy when the buyer is the taker", () => {
    expect(deriveSide(makeTrade({ buyer_role: "taker", seller_role: "maker" }))).toBe(
      "buy",
    );
  });

  it("is a sell when the buyer is the maker (seller is the taker)", () => {
    expect(deriveSide(makeTrade({ buyer_role: "maker", seller_role: "taker" }))).toBe(
      "sell",
    );
  });
});

describe("formatTradeTime", () => {
  it("formats HH:MM:SS.mmm in UTC", () => {
    // 2026-07-14T05:09:07.123Z
    const ms = Date.UTC(2026, 6, 14, 5, 9, 7, 123);
    expect(formatTradeTime(ms)).toBe("05:09:07.123");
  });

  it("zero-pads hours, minutes, seconds, and milliseconds", () => {
    const ms = Date.UTC(2026, 0, 1, 0, 0, 0, 5);
    expect(formatTradeTime(ms)).toBe("00:00:00.005");
  });
});

describe("mergeIntoRows", () => {
  it("creates a new row for the first trade", () => {
    const trade = makeTrade();
    const rows = mergeIntoRows([], trade);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      symbol: "BTCUSD",
      price: 63588.4,
      side: "buy",
      size: 96,
      count: 1,
    });
  });

  it("formats the time label once at ingest, from the first trade's timestamp", () => {
    const trade = makeTrade({ timestamp: Date.UTC(2026, 6, 14, 5, 9, 7, 0) * 1000 });
    const rows = mergeIntoRows([], trade);
    expect(rows[0]?.timeLabel).toBe("05:09:07.000");
  });

  it("merges a same-price trade 99ms after the row's first trade", () => {
    const first = makeTrade({ timestamp: 0 });
    const second = makeTrade({ timestamp: 99_000, size: 10 }); // 99ms later, µs

    const rows = mergeIntoRows(mergeIntoRows([], first), second);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.size).toBe(106);
    expect(rows[0]?.count).toBe(2);
  });

  it("merges a same-price trade exactly 100ms after the row's first trade (inclusive boundary)", () => {
    const first = makeTrade({ timestamp: 0 });
    const second = makeTrade({ timestamp: 100_000, size: 10 });

    const rows = mergeIntoRows(mergeIntoRows([], first), second);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.size).toBe(106);
    expect(rows[0]?.count).toBe(2);
  });

  it("does not merge a same-price trade 101ms after the row's first trade", () => {
    const first = makeTrade({ timestamp: 0 });
    const second = makeTrade({ timestamp: 101_000, size: 10 });

    const rows = mergeIntoRows(mergeIntoRows([], first), second);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.size).toBe(96);
    expect(rows[0]?.count).toBe(1);
    expect(rows[1]?.size).toBe(10);
    expect(rows[1]?.count).toBe(1);
  });

  it("does not merge a different price even within the window", () => {
    const first = makeTrade({ timestamp: 0, price: "63588.4" });
    const second = makeTrade({ timestamp: 50_000, price: "63589.0" });

    const rows = mergeIntoRows(mergeIntoRows([], first), second);

    expect(rows).toHaveLength(2);
  });

  it("measures the window from the row's FIRST trade, not its most recent one", () => {
    // Three trades 60ms apart at the same price: 0, 60ms, 120ms.
    // 120ms is 120ms after the first trade (>100ms, no merge) even though
    // it's only 60ms after the second (which would merge under a
    // "most recent trade" rule).
    let rows: TradeRow[] = [];
    rows = mergeIntoRows(rows, makeTrade({ timestamp: 0 }));
    rows = mergeIntoRows(rows, makeTrade({ timestamp: 60_000, size: 1 }));
    rows = mergeIntoRows(rows, makeTrade({ timestamp: 120_000, size: 1 }));

    expect(rows).toHaveLength(2);
    expect(rows[0]?.count).toBe(2); // trades at 0ms and 60ms merged
    expect(rows[1]?.count).toBe(1); // trade at 120ms starts a new row
  });

  it("only merges into the LAST row, not any earlier matching row", () => {
    let rows: TradeRow[] = [];
    rows = mergeIntoRows(rows, makeTrade({ timestamp: 0, price: "1.0" }));
    rows = mergeIntoRows(rows, makeTrade({ timestamp: 200_000, price: "2.0" }));
    // Same price as the first row, well within 100ms of the second row's
    // first trade — but the first row is no longer "last", so it must not
    // be merged into.
    rows = mergeIntoRows(
      rows,
      makeTrade({ timestamp: 250_000, price: "1.0", size: 5 }),
    );

    expect(rows).toHaveLength(3);
  });

  it("keeps the first trade's side when merging trades with a different side", () => {
    const first = makeTrade({
      timestamp: 0,
      buyer_role: "taker",
      seller_role: "maker",
    });
    const second = makeTrade({
      timestamp: 10_000,
      buyer_role: "maker",
      seller_role: "taker",
    });

    const rows = mergeIntoRows(mergeIntoRows([], first), second);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.side).toBe("buy");
  });
});
