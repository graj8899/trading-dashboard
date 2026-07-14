import { create } from "zustand";
import type { TradeRow } from "../engines/trades/merge";

interface TradesState {
  rows: readonly TradeRow[];
  loading: boolean;
  epoch: number;
}

export const useTradesStore = create<TradesState>(() => ({
  rows: [],
  loading: true,
  epoch: 0,
}));

// The only writer: called by TradesEngine's publish callback on each flush
// that actually merged new trades in.
export function publishTrades(rows: readonly TradeRow[], epoch: number): void {
  useTradesStore.setState({ rows, loading: false, epoch });
}

// Called synchronously on a focus switch, before the SubscriptionManager
// even sends the new subscribe message — clears the old symbol's feed
// immediately so nothing stale is visible while the new one loads.
export function resetTradesForFocusSwitch(epoch: number): void {
  useTradesStore.setState({ rows: [], loading: true, epoch });
}
