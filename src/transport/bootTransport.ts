import { SYMBOLS } from "../config/symbols";
import { OrderBookEngine } from "../engines/OrderBookEngine";
import { TickerEngine } from "../engines/TickerEngine";
import { TradesEngine } from "../engines/TradesEngine";
import { useConnectionStore, setConnectionState } from "../stores/connection";
import { useMarketStore } from "../stores/market";
import { publishOrderbook } from "../stores/orderbook";
import { usePreferencesStore } from "../stores/preferences";
import { publishTickers } from "../stores/tickers";
import { publishTradeStats } from "../stores/tradeStats";
import { publishTrades } from "../stores/trades";
import { SocketClient } from "./SocketClient";
import { SubscriptionManager } from "./SubscriptionManager";

const WS_URL = "ws://localhost:8080";

export interface Transport {
  socket: SocketClient;
  subscriptionManager: SubscriptionManager;
  tickerEngine: TickerEngine;
  orderBookEngine: OrderBookEngine;
  tradesEngine: TradesEngine;
}

let transport: Transport | null = null;

// Idempotent: safe to call more than once (e.g. React StrictMode's double
// effect invocation) — only the first call creates the socket.
export function bootTransport(): Transport {
  if (transport) return transport;

  const socket = new SocketClient(WS_URL);
  const subscriptionManager = new SubscriptionManager(socket);
  const tickerEngine = new TickerEngine(publishTickers);
  const orderBookEngine = new OrderBookEngine({
    publish: publishOrderbook,
    getEpoch: () => useConnectionStore.getState().epoch,
    getGroupingIncrement: (symbol) =>
      usePreferencesStore.getState().grouping[symbol],
  });
  const tradesEngine = new TradesEngine({
    publishTrades,
    publishStats: publishTradeStats,
    getEpoch: () => useConnectionStore.getState().epoch,
  });

  socket.onStatus((status, epoch) => setConnectionState(status, epoch));
  socket.on("v2/ticker", (msg) => tickerEngine.onMessage(msg));
  socket.on("l2_orderbook", (msg) => orderBookEngine.onMessage(msg));
  socket.on("all_trades", (msg) => tradesEngine.onMessage(msg));
  tickerEngine.start();
  orderBookEngine.start();
  tradesEngine.start();

  socket.connect();
  // Orderbook/trades are only subscribed for the focused symbol.
  // Re-subscribing on focus change (unsub old, sub new) is wired in a
  // later phase.
  subscriptionManager.setDesired([
    { name: "v2/ticker", symbols: [...SYMBOLS] },
    {
      name: "l2_orderbook",
      symbols: [useMarketStore.getState().focusedSymbol],
    },
    {
      name: "all_trades",
      symbols: [useMarketStore.getState().focusedSymbol],
    },
  ]);

  transport = {
    socket,
    subscriptionManager,
    tickerEngine,
    orderBookEngine,
    tradesEngine,
  };
  return transport;
}
