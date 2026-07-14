import { SYMBOL_CONFIG, type Symbol } from "../config/symbols";
import type { OrderbookMessage } from "../types/messages";
import {
  DEFAULT_VISIBLE_LEVELS,
  parseAndGroup,
  type OrderbookLevel,
  type OrderbookView,
} from "./orderbook/pipeline";

// Assumption (documented per the doc's "data realism caveat"): each backend
// orderbook snapshot is generated around a new random mid, uncorrelated with
// the last one, so an unrated ">10% change" flash rule fires on nearly every
// bucket, every update, and the book strobes. Rate-limiting to one flash per
// bucket per 300ms is a UX compromise, not a backend-accurate signal.
const FLASH_CHANGE_RATIO = 0.1; // >10% size change vs previous snapshot
const FLASH_RATE_LIMIT_MS = 300;

export interface FlashLevel extends OrderbookLevel {
  flash: "up" | "down" | null;
}

export interface OrderbookSnapshot extends Omit<OrderbookView, "bids" | "asks"> {
  bids: FlashLevel[];
  asks: FlashLevel[];
}

export type PublishOrderbookSnapshot = (
  snapshot: OrderbookSnapshot,
  epoch: number,
) => void;

export interface OrderBookEngineDeps {
  publish: PublishOrderbookSnapshot;
  // Reads the connection store's current epoch. Injected (rather than
  // imported directly) to keep this engine framework/store-import-free.
  getEpoch: () => number;
  getGroupingIncrement: (symbol: Symbol) => number;
}

function bucketKey(side: "bid" | "ask", price: number, scale: number): string {
  return `${side}:${Math.round(price * scale)}`;
}

// Framework-free. Holding structure is a single `latestRaw` slot — a new
// message overwrites it outright (latest-snapshot-wins). Since l2_orderbook
// messages are full snapshots, not deltas, dropping an intermediate message
// this way is lossless: zero queue growth by construction.
export class OrderBookEngine {
  private readonly publish: PublishOrderbookSnapshot;
  private readonly getEpoch: () => number;
  private readonly getGroupingIncrement: (symbol: Symbol) => number;

  private latestRaw: OrderbookMessage | null = null;
  private latestRawEpoch = 0;
  private rafHandle: number | null = null;

  // Cross-snapshot state for flash detection, keyed by "side:bucketTicks".
  // Rebuilt every flush to hold ONLY the current snapshot's visible buckets
  // (see applyFlash), so a bucket that scrolls out of view and later scrolls
  // back in is treated as a fresh sighting rather than compared against a
  // stale size from many snapshots ago. This also bounds both maps to at
  // most 2×N entries (N visible levels per side). Cleared outright whenever
  // the epoch advances, since buckets from a different symbol/session are
  // not meaningfully comparable.
  private readonly previousBucketSizes = new Map<string, number>();
  private readonly lastFlashAt = new Map<string, number>();
  private lastSeenEpoch: number | null = null;

  constructor(deps: OrderBookEngineDeps) {
    this.publish = deps.publish;
    this.getEpoch = deps.getEpoch;
    this.getGroupingIncrement = deps.getGroupingIncrement;
  }

  onMessage(msg: OrderbookMessage): void {
    this.latestRaw = msg;
    this.latestRawEpoch = this.getEpoch();
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
  // synchronously in tests without a real animation frame or real clock.
  flush(now: number = Date.now()): void {
    if (!this.latestRaw) return;

    const currentEpoch = this.getEpoch();
    if (this.lastSeenEpoch !== currentEpoch) {
      // Fresh epoch (reconnect or focus switch): prior flash-tracking state
      // belongs to a different symbol/session and is no longer meaningful.
      this.previousBucketSizes.clear();
      this.lastFlashAt.clear();
      this.lastSeenEpoch = currentEpoch;
    }

    if (this.latestRawEpoch < currentEpoch) {
      // Buffered under a stale epoch — a reconnect or focus switch happened
      // after this message arrived. Discard, never publish.
      this.latestRaw = null;
      return;
    }

    const msg = this.latestRaw;
    this.latestRaw = null;

    const { precision } = SYMBOL_CONFIG[msg.symbol];
    const groupingIncrement = this.getGroupingIncrement(msg.symbol);
    const grouped = parseAndGroup(
      msg,
      groupingIncrement,
      precision,
      DEFAULT_VISIBLE_LEVELS,
    );
    const snapshot = this.applyFlash(grouped, precision, now);

    this.publish(snapshot, currentEpoch);
  }

  // Computes flash for every level in the current snapshot, comparing
  // against the OLD previousBucketSizes/lastFlashAt (this flush's "previous
  // snapshot"), then atomically swaps both maps to contain only the keys
  // seen in THIS snapshot — bounding them to at most 2×N entries and
  // guaranteeing "previous" always means "the last time this exact bucket
  // was visible", not "some earlier flush before it scrolled out of view".
  private applyFlash(
    view: OrderbookView,
    precision: number,
    now: number,
  ): OrderbookSnapshot {
    const scale = 10 ** precision;
    const nextSizes = new Map<string, number>();
    const nextFlashAt = new Map<string, number>();

    const flashOne = (side: "bid" | "ask", level: OrderbookLevel): FlashLevel => {
      const key = bucketKey(side, level.price, scale);
      const prevSize = this.previousBucketSizes.get(key);
      let flash: FlashLevel["flash"] = null;
      let flashAt = this.lastFlashAt.get(key);

      if (prevSize !== undefined && prevSize > 0) {
        const changeRatio = Math.abs(level.size - prevSize) / prevSize;
        if (changeRatio > FLASH_CHANGE_RATIO) {
          const lastFlash = flashAt ?? -Infinity;
          if (now - lastFlash >= FLASH_RATE_LIMIT_MS) {
            flash = level.size > prevSize ? "up" : "down";
            flashAt = now;
          }
        }
      }

      nextSizes.set(key, level.size);
      if (flashAt !== undefined) nextFlashAt.set(key, flashAt);

      return { ...level, flash };
    };

    const bids = view.bids.map((level) => flashOne("bid", level));
    const asks = view.asks.map((level) => flashOne("ask", level));

    this.previousBucketSizes.clear();
    for (const [key, size] of nextSizes) this.previousBucketSizes.set(key, size);
    this.lastFlashAt.clear();
    for (const [key, at] of nextFlashAt) this.lastFlashAt.set(key, at);

    return { ...view, bids, asks };
  }
}
