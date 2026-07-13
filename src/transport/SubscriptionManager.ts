import type { Symbol } from "../config/symbols";
import type { ChannelName } from "../types/messages";
import type { SocketClient } from "./SocketClient";

export interface ChannelSubscription {
  name: ChannelName;
  symbols: Symbol[];
}

type ClientMessage = {
  type: "subscribe" | "unsubscribe";
  payload: { channels: ChannelSubscription[] };
};

export interface SubscriptionDiff {
  toSubscribe: ChannelSubscription[];
  toUnsubscribe: ChannelSubscription[];
}

// Fixed order so diff output (and therefore sent messages) is deterministic.
const CHANNEL_ORDER: ChannelName[] = ["v2/ticker", "l2_orderbook", "all_trades"];

function toSymbolSets(subs: ChannelSubscription[]): Map<ChannelName, Set<Symbol>> {
  const map = new Map<ChannelName, Set<Symbol>>();
  for (const sub of subs) {
    const existing = map.get(sub.name) ?? new Set<Symbol>();
    for (const symbol of sub.symbols) existing.add(symbol);
    map.set(sub.name, existing);
  }
  return map;
}

// Pure diff: what to subscribe/unsubscribe to move `actual` to `desired`.
export function diffSubscriptions(
  desired: ChannelSubscription[],
  actual: ChannelSubscription[],
): SubscriptionDiff {
  const desiredMap = toSymbolSets(desired);
  const actualMap = toSymbolSets(actual);

  const toSubscribe: ChannelSubscription[] = [];
  const toUnsubscribe: ChannelSubscription[] = [];

  for (const name of CHANNEL_ORDER) {
    const desiredSymbols = desiredMap.get(name) ?? new Set<Symbol>();
    const actualSymbols = actualMap.get(name) ?? new Set<Symbol>();

    const added = [...desiredSymbols]
      .filter((s) => !actualSymbols.has(s))
      .sort();
    const removed = [...actualSymbols]
      .filter((s) => !desiredSymbols.has(s))
      .sort();

    if (added.length > 0) toSubscribe.push({ name, symbols: added });
    if (removed.length > 0) toUnsubscribe.push({ name, symbols: removed });
  }

  return { toSubscribe, toUnsubscribe };
}

// Holds the DESIRED subscription set (derived from app state) and keeps the
// server's actual state converged to it: full resend on (re)connect, diffed
// resend on drift detected via the `subscriptions` ack.
export class SubscriptionManager {
  private readonly socket: SocketClient;
  private desired: ChannelSubscription[] = [];
  private acked: ChannelSubscription[] = [];

  private readonly unsubscribeStatus: () => void;
  private readonly unsubscribeAck: () => void;

  constructor(socket: SocketClient) {
    this.socket = socket;
    this.unsubscribeStatus = socket.onStatus((status) => {
      if (status === "connected") this.sendFullDesired();
    });
    this.unsubscribeAck = socket.on("subscriptions", (msg) => {
      this.reconcile(msg.payload.channels);
    });
  }

  setDesired(subscriptions: ChannelSubscription[]): void {
    this.desired = subscriptions;
    if (this.socket.getStatus() !== "connected") return;
    this.sendDiff(this.acked);
  }

  dispose(): void {
    this.unsubscribeStatus();
    this.unsubscribeAck();
  }

  private sendFullDesired(): void {
    if (this.desired.length === 0) return;
    this.send({ type: "subscribe", payload: { channels: this.desired } });
  }

  private reconcile(actual: ChannelSubscription[]): void {
    this.acked = actual;
    this.sendDiff(actual);
  }

  private sendDiff(actual: ChannelSubscription[]): void {
    const { toSubscribe, toUnsubscribe } = diffSubscriptions(
      this.desired,
      actual,
    );
    if (toSubscribe.length > 0) {
      this.send({ type: "subscribe", payload: { channels: toSubscribe } });
    }
    if (toUnsubscribe.length > 0) {
      this.send({ type: "unsubscribe", payload: { channels: toUnsubscribe } });
    }
  }

  private send(message: ClientMessage): void {
    this.socket.send(message);
  }
}
