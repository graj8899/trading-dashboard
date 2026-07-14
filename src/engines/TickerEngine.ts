import type { Symbol } from "../config/symbols";
import type { TickerMessage } from "../types/messages";

export interface TickerView {
  symbol: Symbol;
  price: number;
  changePct: number;
  dir: "up" | "down" | "flat";
}

export type TickerViewUpdates = Partial<Record<Symbol, TickerView>>;

// Framework-free. Ingest is two O(1) writes (Map set + Set add), safe at any
// message rate. Publishing is decoupled onto a requestAnimationFrame loop so
// React never sees the wire message rate.
export class TickerEngine {
  private readonly publish: (updates: TickerViewUpdates) => void;
  private readonly latest = new Map<Symbol, TickerMessage>();
  private readonly dirty = new Set<Symbol>();
  private readonly lastPublishedPrice = new Map<Symbol, number>();
  private rafHandle: number | null = null;

  constructor(publish: (updates: TickerViewUpdates) => void) {
    this.publish = publish;
  }

  onMessage(msg: TickerMessage): void {
    this.latest.set(msg.symbol, msg);
    this.dirty.add(msg.symbol);
  }

  start(): void {
    if (this.rafHandle !== null) return;
    const loop = (): void => {
      this.flush();
      this.rafHandle = requestAnimationFrame(loop);
    };
    this.rafHandle = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  // Exposed directly (not just via the rAF loop) so it can be driven
  // synchronously in tests without a real animation frame.
  flush(): void {
    if (this.dirty.size === 0) return;

    const updates: TickerViewUpdates = {};
    for (const symbol of this.dirty) {
      const msg = this.latest.get(symbol);
      if (!msg) continue;

      const price = msg.close;
      // ltp_change_24h is a RATIO ("1.0123" = +1.23%), not a percent.
      const changePct = (parseFloat(msg.ltp_change_24h) - 1) * 100;

      const prevPrice = this.lastPublishedPrice.get(symbol);
      let dir: TickerView["dir"] = "flat";
      if (prevPrice !== undefined) {
        if (price > prevPrice) dir = "up";
        else if (price < prevPrice) dir = "down";
      }
      this.lastPublishedPrice.set(symbol, price);

      updates[symbol] = { symbol, price, changePct, dir };
    }

    this.dirty.clear();
    this.publish(updates);
  }
}
