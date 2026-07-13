import { describe, expect, it } from "vitest";
import { diffSubscriptions, type ChannelSubscription } from "./SubscriptionManager";

describe("diffSubscriptions", () => {
  it("subscribes to everything when actual is empty", () => {
    const desired: ChannelSubscription[] = [
      { name: "v2/ticker", symbols: ["BTCUSD", "ETHUSD"] },
    ];
    const { toSubscribe, toUnsubscribe } = diffSubscriptions(desired, []);

    expect(toSubscribe).toEqual([
      { name: "v2/ticker", symbols: ["BTCUSD", "ETHUSD"] },
    ]);
    expect(toUnsubscribe).toEqual([]);
  });

  it("unsubscribes from everything when desired is empty", () => {
    const actual: ChannelSubscription[] = [
      { name: "l2_orderbook", symbols: ["BTCUSD"] },
    ];
    const { toSubscribe, toUnsubscribe } = diffSubscriptions([], actual);

    expect(toSubscribe).toEqual([]);
    expect(toUnsubscribe).toEqual([
      { name: "l2_orderbook", symbols: ["BTCUSD"] },
    ]);
  });

  it("produces no messages when desired already matches actual", () => {
    const subs: ChannelSubscription[] = [
      { name: "all_trades", symbols: ["BTCUSD", "ETHUSD"] },
    ];
    const { toSubscribe, toUnsubscribe } = diffSubscriptions(subs, subs);

    expect(toSubscribe).toEqual([]);
    expect(toUnsubscribe).toEqual([]);
  });

  it("computes a minimal diff for a focus switch (symbol swap on one channel)", () => {
    const desired: ChannelSubscription[] = [
      { name: "l2_orderbook", symbols: ["ETHUSD"] },
      { name: "all_trades", symbols: ["ETHUSD"] },
    ];
    const actual: ChannelSubscription[] = [
      { name: "l2_orderbook", symbols: ["BTCUSD"] },
      { name: "all_trades", symbols: ["BTCUSD"] },
    ];

    const { toSubscribe, toUnsubscribe } = diffSubscriptions(desired, actual);

    expect(toSubscribe).toEqual([
      { name: "l2_orderbook", symbols: ["ETHUSD"] },
      { name: "all_trades", symbols: ["ETHUSD"] },
    ]);
    expect(toUnsubscribe).toEqual([
      { name: "l2_orderbook", symbols: ["BTCUSD"] },
      { name: "all_trades", symbols: ["BTCUSD"] },
    ]);
  });

  it("leaves untouched channels out of both diff lists", () => {
    const desired: ChannelSubscription[] = [
      { name: "v2/ticker", symbols: ["BTCUSD"] },
      { name: "l2_orderbook", symbols: ["BTCUSD"] },
    ];
    const actual: ChannelSubscription[] = [
      { name: "v2/ticker", symbols: ["BTCUSD"] },
      { name: "l2_orderbook", symbols: ["ETHUSD"] },
    ];

    const { toSubscribe, toUnsubscribe } = diffSubscriptions(desired, actual);

    expect(toSubscribe).toEqual([{ name: "l2_orderbook", symbols: ["BTCUSD"] }]);
    expect(toUnsubscribe).toEqual([
      { name: "l2_orderbook", symbols: ["ETHUSD"] },
    ]);
  });

  it("dedupes symbols within a channel and sorts output deterministically", () => {
    const desired: ChannelSubscription[] = [
      { name: "v2/ticker", symbols: ["SOLUSD", "BTCUSD", "SOLUSD"] },
    ];
    const { toSubscribe } = diffSubscriptions(desired, []);

    expect(toSubscribe).toEqual([
      { name: "v2/ticker", symbols: ["BTCUSD", "SOLUSD"] },
    ]);
  });

  it("only reports genuinely added/removed symbols, ignoring the overlap", () => {
    const desired: ChannelSubscription[] = [
      { name: "all_trades", symbols: ["BTCUSD", "DOGEUSD"] },
    ];
    const actual: ChannelSubscription[] = [
      { name: "all_trades", symbols: ["BTCUSD", "XRPUSD"] },
    ];

    const { toSubscribe, toUnsubscribe } = diffSubscriptions(desired, actual);

    expect(toSubscribe).toEqual([{ name: "all_trades", symbols: ["DOGEUSD"] }]);
    expect(toUnsubscribe).toEqual([{ name: "all_trades", symbols: ["XRPUSD"] }]);
  });
});
