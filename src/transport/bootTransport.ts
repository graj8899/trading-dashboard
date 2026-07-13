import { setConnectionState } from "../stores/connection";
import { SocketClient } from "./SocketClient";
import { SubscriptionManager } from "./SubscriptionManager";

const WS_URL = "ws://localhost:8080";

export interface Transport {
  socket: SocketClient;
  subscriptionManager: SubscriptionManager;
}

let transport: Transport | null = null;

// Idempotent: safe to call more than once (e.g. React StrictMode's double
// effect invocation) — only the first call creates the socket.
export function bootTransport(): Transport {
  if (transport) return transport;

  const socket = new SocketClient(WS_URL);
  const subscriptionManager = new SubscriptionManager(socket);
  socket.onStatus((status, epoch) => setConnectionState(status, epoch));
  socket.connect();

  transport = { socket, subscriptionManager };
  return transport;
}
