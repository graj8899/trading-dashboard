import type { ServerMessage } from "../types/messages";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

type StatusListener = (status: ConnectionStatus, epoch: number) => void;

type HandlerMap = {
  [K in ServerMessage["type"]]: Array<
    (msg: Extract<ServerMessage, { type: K }>) => void
  >;
};

const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 30000;

function isServerMessage(value: unknown): value is ServerMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "v2/ticker" ||
    type === "l2_orderbook" ||
    type === "all_trades" ||
    type === "subscriptions"
  );
}

// Framework-free: owns one WebSocket, reconnects with backoff+jitter, and
// routes parsed messages to per-channel handlers. No React imports.
export class SocketClient {
  private readonly url: string;
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = "disconnected";
  private epoch = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitlyClosed = false;

  private readonly statusListeners = new Set<StatusListener>();
  private readonly handlers: HandlerMap = {
    "v2/ticker": [],
    l2_orderbook: [],
    all_trades: [],
    subscriptions: [],
  };

  constructor(url: string) {
    this.url = url;
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getEpoch(): number {
    return this.epoch;
  }

  // Bump the epoch for reasons other than reconnect (e.g. focus switch).
  // Consumers use the epoch to discard stale buffered data.
  bumpEpoch(): void {
    this.epoch += 1;
    this.notifyStatus();
  }

  connect(): void {
    this.explicitlyClosed = false;
    if (this.status !== "reconnecting") {
      this.status = "connecting";
      this.notifyStatus();
    }
    this.openSocket();
  }

  disconnect(): void {
    this.explicitlyClosed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
    } else {
      this.status = "disconnected";
      this.notifyStatus();
    }
  }

  send(message: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  // Emits the current status immediately, then on every change.
  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status, this.epoch);
    return () => this.statusListeners.delete(listener);
  }

  on<K extends ServerMessage["type"]>(
    type: K,
    handler: (msg: Extract<ServerMessage, { type: K }>) => void,
  ): () => void {
    const list = this.handlers[type];
    list.push(handler);
    return () => {
      const idx = list.indexOf(handler);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  private openSocket(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener("open", this.handleOpen);
    ws.addEventListener("close", this.handleClose);
    ws.addEventListener("error", this.handleError);
    ws.addEventListener("message", this.handleMessage);
  }

  private readonly handleOpen = (): void => {
    this.reconnectAttempts = 0;
    this.status = "connected";
    this.notifyStatus();
  };

  private readonly handleClose = (): void => {
    this.ws = null;
    if (this.explicitlyClosed) {
      this.status = "disconnected";
      this.notifyStatus();
      return;
    }
    // Only a drop *after* a successful connection invalidates buffered data.
    if (this.status === "connected") {
      this.epoch += 1;
    }
    this.status = "reconnecting";
    this.notifyStatus();
    this.scheduleReconnect();
  };

  private readonly handleError = (): void => {
    console.error("[SocketClient] socket error");
  };

  private readonly handleMessage = (event: MessageEvent): void => {
    if (typeof event.data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch (err) {
      console.error("[SocketClient] malformed JSON, dropping message", err);
      return;
    }
    if (!isServerMessage(parsed)) {
      console.error("[SocketClient] unknown message shape, dropping", parsed);
      return;
    }
    switch (parsed.type) {
      case "v2/ticker":
        for (const h of this.handlers["v2/ticker"]) h(parsed);
        break;
      case "l2_orderbook":
        for (const h of this.handlers.l2_orderbook) h(parsed);
        break;
      case "all_trades":
        for (const h of this.handlers.all_trades) h(parsed);
        break;
      case "subscriptions":
        for (const h of this.handlers.subscriptions) h(parsed);
        break;
    }
  };

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const capped = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
      RECONNECT_CAP_MS,
    );
    const delay = Math.random() * capped; // full jitter
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private notifyStatus(): void {
    for (const listener of this.statusListeners) {
      listener(this.status, this.epoch);
    }
  }
}
