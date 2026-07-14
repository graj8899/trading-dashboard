import { create } from "zustand";
import { persist } from "zustand/middleware";
import { SYMBOL_CONFIG, SYMBOLS, type Symbol } from "../config/symbols";

// Defaults only — both are user-configurable and persisted, so these just
// seed first-run state. Grouping starts at each symbol's finest ladder rung.
// Large-trade thresholds are USD notional (price × size) placeholders sized
// per symbol: DOGE notionals are ~10^4x smaller than BTC's, so a single
// global default would either never fire or always fire.
const DEFAULT_GROUPING: Record<Symbol, number> = Object.fromEntries(
  SYMBOLS.map((symbol) => [symbol, SYMBOL_CONFIG[symbol].groupingLadder[0]]),
) as Record<Symbol, number>;

const DEFAULT_LARGE_TRADE_THRESHOLD: Record<Symbol, number> = {
  BTCUSD: 100_000,
  ETHUSD: 50_000,
  XRPUSD: 5_000,
  SOLUSD: 5_000,
  PAXGUSD: 50_000,
  DOGEUSD: 1_000,
};

interface PreferencesState {
  grouping: Record<Symbol, number>;
  largeTradeThreshold: Record<Symbol, number>;
  setGrouping: (symbol: Symbol, increment: number) => void;
  setLargeTradeThreshold: (symbol: Symbol, threshold: number) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      grouping: DEFAULT_GROUPING,
      largeTradeThreshold: DEFAULT_LARGE_TRADE_THRESHOLD,
      setGrouping: (symbol, increment) =>
        set((state) => ({
          grouping: { ...state.grouping, [symbol]: increment },
        })),
      setLargeTradeThreshold: (symbol, threshold) =>
        set((state) => ({
          largeTradeThreshold: {
            ...state.largeTradeThreshold,
            [symbol]: threshold,
          },
        })),
    }),
    { name: "preferences" },
  ),
);
