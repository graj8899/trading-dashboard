import type { Symbol } from "../config/symbols";

// All backend timestamps are microseconds (`Date.now() * 1000`), not milliseconds.
export type Microseconds = number;

// Wire prices/sizes come as decimal strings formatted to the symbol's precision.
export type DecimalString = string;

// v2/ticker — one message per symbol per tick.
// Backend also sends turnover_usd, oi, funding_rate, quotes, price_band, greeks,
// and other fields we don't use; only the fields below are modeled.
export interface TickerMessage {
  type: "v2/ticker";
  symbol: Symbol;
  close: number; // last traded price
  // Ratio, not a percent: "1.0123" means +1.23%.
  // changePct = (parseFloat(ltp_change_24h) - 1) * 100
  ltp_change_24h: DecimalString;
  timestamp: Microseconds;
}

// l2_orderbook — full snapshot every message, not a delta. Bids/asks are
// pre-sorted best-to-worst, up to 500 levels/side, as [price, size] tuples.
export interface OrderbookMessage {
  type: "l2_orderbook";
  symbol: Symbol;
  bids: [DecimalString, DecimalString][];
  asks: [DecimalString, DecimalString][];
  timestamp: Microseconds;
}

// all_trades — one message per executed trade. There is no `side` field;
// side must be derived: buyer_role === "taker" -> buy, else sell.
export interface TradeMessage {
  type: "all_trades";
  symbol: Symbol;
  price: DecimalString;
  size: number; // trade size, observed range ~96-106
  buyer_role: "maker" | "taker";
  seller_role: "maker" | "taker";
  timestamp: Microseconds;
}

export type ChannelName = "v2/ticker" | "l2_orderbook" | "all_trades";

// subscriptions — sent on every subscribe/unsubscribe ack, carrying the full
// current subscription state. Treat as the source of truth for reconciliation.
export interface SubscriptionsMessage {
  type: "subscriptions";
  payload: {
    channels: {
      name: ChannelName;
      symbols: Symbol[];
    }[];
  };
}

export type ServerMessage =
  | TickerMessage
  | OrderbookMessage
  | TradeMessage
  | SubscriptionsMessage;
