import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Symbol } from "../config/symbols";

interface MarketState {
  focusedSymbol: Symbol;
  setFocusedSymbol: (symbol: Symbol) => void;
}

export const useMarketStore = create<MarketState>()(
  persist(
    (set) => ({
      focusedSymbol: "BTCUSD",
      setFocusedSymbol: (symbol) => set({ focusedSymbol: symbol }),
    }),
    { name: "market" },
  ),
);
