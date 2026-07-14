import { describe, expect, it } from "vitest";
import { SYMBOLS } from "../config/symbols";
import {
  publishOrderbook,
  resetOrderbookForFocusSwitch,
  useOrderbookStore,
} from "../stores/orderbook";
import {
  publishTrades,
  resetTradesForFocusSwitch,
  useTradesStore,
} from "../stores/trades";
import type { OrderbookSnapshot } from "../engines/OrderBookEngine";
import type { TradeRow } from "../engines/trades/merge";
import { buildDesiredSubscriptions } from "./bootTransport";

describe("buildDesiredSubscriptions", () => {
  it("always includes all 6 tickers, plus orderbook/trades for the focused symbol only", () => {
    const desired = buildDesiredSubscriptions("ETHUSD");

    expect(desired).toEqual([
      { name: "v2/ticker", symbols: [...SYMBOLS] },
      { name: "l2_orderbook", symbols: ["ETHUSD"] },
      { name: "all_trades", symbols: ["ETHUSD"] },
    ]);
  });

  it("reflects whichever symbol is passed, not a fixed default", () => {
    const desired = buildDesiredSubscriptions("DOGEUSD");

    expect(desired.find((c) => c.name === "l2_orderbook")?.symbols).toEqual([
      "DOGEUSD",
    ]);
    expect(desired.find((c) => c.name === "all_trades")?.symbols).toEqual([
      "DOGEUSD",
    ]);
  });
});

const fakeSnapshot: OrderbookSnapshot = {
  symbol: "BTCUSD",
  bids: [],
  asks: [],
  mid: 100,
  spreadAbs: 1,
  spreadBps: 10,
  imbalance: 1,
  maxCum: 0,
};

const fakeRow: TradeRow = {
  symbol: "BTCUSD",
  price: 100,
  side: "buy",
  size: 1,
  count: 1,
  firstTimestampMs: 0,
  lastTimestampMs: 0,
  timeLabel: "00:00:00.000",
};

describe("focus-switch store resets", () => {
  it("resetOrderbookForFocusSwitch clears the view and sets loading, even if data was already published", () => {
    publishOrderbook(fakeSnapshot, 0);
    expect(useOrderbookStore.getState().loading).toBe(false);

    resetOrderbookForFocusSwitch(1);

    expect(useOrderbookStore.getState()).toEqual({
      view: null,
      loading: true,
      epoch: 1,
    });
  });

  it("resetTradesForFocusSwitch clears rows and sets loading, even if data was already published", () => {
    publishTrades([fakeRow], 0);
    expect(useTradesStore.getState().loading).toBe(false);
    expect(useTradesStore.getState().rows).toHaveLength(1);

    resetTradesForFocusSwitch(1);

    expect(useTradesStore.getState()).toEqual({
      rows: [],
      loading: true,
      epoch: 1,
    });
  });

  it("a subsequent publish clears loading again (first new-symbol message)", () => {
    resetOrderbookForFocusSwitch(1);
    expect(useOrderbookStore.getState().loading).toBe(true);

    publishOrderbook(fakeSnapshot, 1);

    expect(useOrderbookStore.getState().loading).toBe(false);
    expect(useOrderbookStore.getState().view).toEqual(fakeSnapshot);
  });
});
