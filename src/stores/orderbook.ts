import { create } from "zustand";
import type { OrderbookSnapshot } from "../engines/OrderBookEngine";

interface OrderbookState {
  view: OrderbookSnapshot | null;
  loading: boolean;
  epoch: number;
}

export const useOrderbookStore = create<OrderbookState>(() => ({
  view: null,
  loading: true,
  epoch: 0,
}));

// The only writer: called by OrderBookEngine's publish callback on each
// successful (non-stale) flush.
export function publishOrderbook(view: OrderbookSnapshot, epoch: number): void {
  useOrderbookStore.setState({ view, loading: false, epoch });
}
