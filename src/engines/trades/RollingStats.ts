import type { TradeSide } from "./merge";

const RING_SIZE = 60; // one bucket per second, 60s rolling window

interface Bucket {
  second: number | null; // null = never touched
  buyVol: number;
  sellVol: number;
  count: number;
  sizeSum: number;
}

interface Totals {
  buyVol: number;
  sellVol: number;
  count: number;
  sizeSum: number;
}

export interface RollingStatsSnapshot {
  buyVol: number;
  sellVol: number;
  count: number;
  avgSize: number;
}

function emptyBucket(): Bucket {
  return { second: null, buyVol: 0, sellVol: 0, count: 0, sizeSum: 0 };
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

// Pure, framework-free ring buffer: 60 one-second buckets + running totals.
// Adding a trade is two O(1) writes (bucket + totals). Advancing the clock
// evicts at most RING_SIZE buckets, each an O(1) subtract-from-totals — the
// window is NEVER re-scanned, no matter how many trades occurred within it
// or how long a gap with no trades lasts.
export class RollingStats {
  private readonly buckets: Bucket[] = Array.from(
    { length: RING_SIZE },
    emptyBucket,
  );
  private readonly totals: Totals = {
    buyVol: 0,
    sellVol: 0,
    count: 0,
    sizeSum: 0,
  };
  private headSecond: number | null = null;

  // Adds one trade. O(1): advances the ring to the trade's second (which
  // itself does at most RING_SIZE evictions, see advanceTo), then two
  // writes (bucket + totals).
  record(side: TradeSide, size: number, timestampMs: number): void {
    const second = Math.floor(timestampMs / 1000);
    this.advanceTo(second);

    // headSecond is guaranteed non-null after advanceTo. A late/out-of-order
    // trade (second < headSecond) is attributed to the current head bucket
    // rather than dropped — an approximation the spec doesn't otherwise cover.
    const idx = mod(this.headSecond as number, RING_SIZE);
    const bucket = this.buckets[idx] as Bucket;

    if (side === "buy") {
      bucket.buyVol += size;
      this.totals.buyVol += size;
    } else {
      bucket.sellVol += size;
      this.totals.sellVol += size;
    }
    bucket.count += 1;
    bucket.sizeSum += size;
    this.totals.count += 1;
    this.totals.sizeSum += size;
  }

  // Advances the ring to `nowMs` without recording a trade, evicting any
  // buckets that have aged out. Call once per second (independent of trade
  // arrival) so the window stays accurate even during a lull.
  tick(nowMs: number): void {
    this.advanceTo(Math.floor(nowMs / 1000));
  }

  // O(1): a pure read of the already-maintained running totals.
  getStats(): RollingStatsSnapshot {
    const { buyVol, sellVol, count, sizeSum } = this.totals;
    return { buyVol, sellVol, count, avgSize: count > 0 ? sizeSum / count : 0 };
  }

  private advanceTo(second: number): void {
    if (this.headSecond === null) {
      this.headSecond = second;
      const bucket = this.buckets[mod(second, RING_SIZE)] as Bucket;
      bucket.second = second;
      return;
    }

    if (second <= this.headSecond) return; // same second, or out of order

    // Evict one bucket per elapsed second, capped at RING_SIZE: beyond that,
    // every bucket has already been cleared and totals are already zero, so
    // further per-slot work would be redundant.
    const steps = Math.min(second - this.headSecond, RING_SIZE);
    for (let i = 0; i < steps; i++) {
      this.headSecond += 1;
      const bucket = this.buckets[mod(this.headSecond, RING_SIZE)] as Bucket;
      if (bucket.second !== null) {
        this.totals.buyVol -= bucket.buyVol;
        this.totals.sellVol -= bucket.sellVol;
        this.totals.count -= bucket.count;
        this.totals.sizeSum -= bucket.sizeSum;
      }
      bucket.second = this.headSecond;
      bucket.buyVol = 0;
      bucket.sellVol = 0;
      bucket.count = 0;
      bucket.sizeSum = 0;
    }

    if (this.headSecond < second) {
      // Gap exceeded the ring's capacity: every bucket was already cleared
      // above, so just fast-forward the head without further per-slot work.
      this.headSecond = second;
      const bucket = this.buckets[mod(second, RING_SIZE)] as Bucket;
      bucket.second = second;
    }
  }
}
