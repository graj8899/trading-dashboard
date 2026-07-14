import { SYMBOLS, type Symbol } from "../config/symbols";
import { OrderBookEngine } from "../engines/OrderBookEngine";
import { TickerEngine } from "../engines/TickerEngine";
import { TradesEngine } from "../engines/TradesEngine";
import { useConnectionStore, setConnectionState } from "../stores/connection";
import { useMarketStore } from "../stores/market";
import { publishOrderbook, resetOrderbookForFocusSwitch } from "../stores/orderbook";
import { usePreferencesStore } from "../stores/preferences";
import { publishTickers } from "../stores/tickers";
import { publishTradeStats } from "../stores/tradeStats";
import { publishTrades, resetTradesForFocusSwitch } from "../stores/trades";
import { SocketClient } from "./SocketClient";
import { SubscriptionManager, type ChannelSubscription } from "./SubscriptionManager";

const WS_URL = "ws://localhost:8080";

export interface Transport {
  socket: SocketClient;
  subscriptionManager: SubscriptionManager;
  tickerEngine: TickerEngine;
  orderBookEngine: OrderBookEngine;
  tradesEngine: TradesEngine;
}

let transport: Transport | null = null;

// Always all 6 tickers, plus orderbook/trades for whichever symbol is
// currently focused. This is the single source of truth for "the current
// desired set" — used both at boot and on every focus switch, so a
// reconnect (which resends `desired` as-is, see SubscriptionManager) always
// replays the CURRENT set, never a stale one from an earlier focus.
export function buildDesiredSubscriptions(
  focusedSymbol: Symbol,
): ChannelSubscription[] {
  return [
    { name: "v2/ticker", symbols: [...SYMBOLS] },
    { name: "l2_orderbook", symbols: [focusedSymbol] },
    { name: "all_trades", symbols: [focusedSymbol] },
  ];
}

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

  // Focus-switch sequence (doc: "no stale flash"):
  //   market store already updated + persisted (that's what fired this) →
  //   epoch++ → orderbook/trades stores reset to {loading: true} →
  //   SubscriptionManager desired set changes (unsub old, sub new) →
  //   engines drop buffered old-epoch data via the epoch guard →
  //   the first new-symbol message clears loading (publishOrderbook/publishTrades).
  useMarketStore.subscribe((state, prevState) => {
    if (state.focusedSymbol === prevState.focusedSymbol) return;

    socket.bumpEpoch();
    const epoch = socket.getEpoch();
    resetOrderbookForFocusSwitch(epoch);
    resetTradesForFocusSwitch(epoch);
    subscriptionManager.setDesired(buildDesiredSubscriptions(state.focusedSymbol));
  });

  socket.connect();
  subscriptionManager.setDesired(
    buildDesiredSubscriptions(useMarketStore.getState().focusedSymbol),
  );

  transport = {
    socket,
    subscriptionManager,
    tickerEngine,
    orderBookEngine,
    tradesEngine,
  };
  return transport;
}
