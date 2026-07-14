import { SYMBOLS } from "../config/symbols";
import { TickerEngine } from "../engines/TickerEngine";
import { setConnectionState } from "../stores/connection";
import { publishTickers } from "../stores/tickers";
import { SocketClient } from "./SocketClient";
import { SubscriptionManager } from "./SubscriptionManager";

const WS_URL = "ws://localhost:8080";

export interface Transport {
  socket: SocketClient;
  subscriptionManager: SubscriptionManager;
  tickerEngine: TickerEngine;
}

let transport: Transport | null = null;

// Idempotent: safe to call more than once (e.g. React StrictMode's double
// effect invocation) — only the first call creates the socket.
export function bootTransport(): Transport {
  if (transport) return transport;

  const socket = new SocketClient(WS_URL);
  const subscriptionManager = new SubscriptionManager(socket);
  const tickerEngine = new TickerEngine(publishTickers);

  socket.onStatus((status, epoch) => setConnectionState(status, epoch));
  socket.on("v2/ticker", (msg) => tickerEngine.onMessage(msg));
  tickerEngine.start();

  socket.connect();
  subscriptionManager.setDesired([
    { name: "v2/ticker", symbols: [...SYMBOLS] },
  ]);

  transport = { socket, subscriptionManager, tickerEngine };
  return transport;
}
