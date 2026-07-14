import { create } from "zustand";
import type { Symbol } from "../config/symbols";
import type { TickerView, TickerViewUpdates } from "../engines/TickerEngine";

interface TickersState {
  tickers: Partial<Record<Symbol, TickerView>>;
}

export const useTickersStore = create<TickersState>(() => ({
  tickers: {},
}));

// The only writer: called by TickerEngine's publish callback. Spreads the
// previous record and overwrites only the changed keys, so untouched
// symbols keep referential identity — that's what render isolation hangs on.
export function publishTickers(updates: TickerViewUpdates): void {
  useTickersStore.setState((state) => ({
    tickers: { ...state.tickers, ...updates },
  }));
}
