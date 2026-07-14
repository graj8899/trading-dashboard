import { create } from "zustand";
import type { RollingStatsSnapshot } from "../engines/trades/RollingStats";

interface TradeStatsState {
  stats: RollingStatsSnapshot;
  epoch: number;
}

const EMPTY_STATS: RollingStatsSnapshot = {
  buyVol: 0,
  sellVol: 0,
  count: 0,
  avgSize: 0,
};

// A separate store slice (not part of trades.ts) so the stats bar re-renders
// at 1Hz, independent of the trade feed's rAF-coalesced but much higher rate.
export const useTradeStatsStore = create<TradeStatsState>(() => ({
  stats: EMPTY_STATS,
  epoch: 0,
}));

// The only writer: called by TradesEngine's publish callback, once per
// second (driven by the same rAF loop, gated to a 1Hz cadence).
export function publishTradeStats(
  stats: RollingStatsSnapshot,
  epoch: number,
): void {
  useTradeStatsStore.setState({ stats, epoch });
}
