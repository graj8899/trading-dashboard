import type { Symbol } from "../../config/symbols";
import type { OrderbookMessage } from "../../types/messages";

// N ≈ 12/side is the default visible depth; callers may override.
export const DEFAULT_VISIBLE_LEVELS = 12;

export interface OrderbookLevel {
  price: number; // display price at the symbol's precision
  size: number; // aggregated size for this bucket
  cumulative: number; // running sum from best price outward
}

// Pure, framework-free. No React, no store imports — this is the one-pass
// parse+group+derive pipeline the OrderBookEngine calls on rAF flush.
export interface OrderbookView {
  symbol: Symbol;
  bids: OrderbookLevel[]; // best -> worst, length <= n
  asks: OrderbookLevel[]; // best -> worst, length <= n
  mid: number;
  spreadAbs: number;
  spreadBps: number;
  imbalance: number; // Σ visible bid size / Σ visible ask size
  maxCum: number; // scale for depth bars
}

interface RawLevel {
  bucketTicks: number;
  size: number;
}

// Raw arrays are already sorted best->worst, so the bucket key is monotonic
// as we walk them (floor/ceil of a monotonic sequence is monotonic too).
// That means buckets for the same price group are always contiguous: we can
// accumulate into a running "current bucket" and only need to look back one
// step, letting us early-exit the instant N buckets are complete instead of
// scanning all 500 raw tuples.
function groupSide(
  raw: readonly (readonly [string, string])[],
  scale: number,
  g: number,
  n: number,
  rounding: "floor" | "ceil",
): RawLevel[] {
  const levels: RawLevel[] = [];
  let currentBucket: number | null = null;
  let currentSize = 0;

  for (const level of raw) {
    const priceStr = level[0];
    const sizeStr = level[1];
    const ticks = Math.round(parseFloat(priceStr) * scale);
    const bucketTicks =
      rounding === "floor"
        ? Math.floor(ticks / g) * g
        : Math.ceil(ticks / g) * g;

    if (currentBucket === null) {
      currentBucket = bucketTicks;
      currentSize = parseFloat(sizeStr);
      continue;
    }

    if (bucketTicks === currentBucket) {
      currentSize += parseFloat(sizeStr);
      continue;
    }

    // Bucket boundary crossed: the previous bucket is now fully accumulated
    // (every raw tuple that belongs to it has been seen, by monotonicity).
    levels.push({ bucketTicks: currentBucket, size: currentSize });
    if (levels.length >= n) {
      currentBucket = null; // signal: already flushed, nothing trailing
      break;
    }
    currentBucket = bucketTicks;
    currentSize = parseFloat(sizeStr);
  }

  // Raw array exhausted before N buckets were filled (or before the last
  // bucket saw a boundary crossing) — that trailing bucket is complete too.
  if (currentBucket !== null && levels.length < n) {
    levels.push({ bucketTicks: currentBucket, size: currentSize });
  }

  return levels;
}

function toDisplayLevels(
  raw: RawLevel[],
  scale: number,
  precision: number,
): OrderbookLevel[] {
  let cumulative = 0;
  return raw.map(({ bucketTicks, size }) => {
    cumulative += size;
    return {
      // toFixed then reparse: plain division (bucketTicks / scale) can carry
      // float noise at high precision (e.g. DOGEUSD's 6dp); rounding to the
      // symbol's precision keeps the displayed price exact.
      price: Number((bucketTicks / scale).toFixed(precision)),
      size,
      cumulative,
    };
  });
}

export function parseAndGroup(
  msg: OrderbookMessage,
  groupingIncrement: number,
  precision: number,
  n: number = DEFAULT_VISIBLE_LEVELS,
): OrderbookView {
  const scale = 10 ** precision;
  const g = Math.round(groupingIncrement * scale);

  const rawBids = groupSide(msg.bids, scale, g, n, "floor");
  const rawAsks = groupSide(msg.asks, scale, g, n, "ceil");

  const bids = toDisplayLevels(rawBids, scale, precision);
  const asks = toDisplayLevels(rawAsks, scale, precision);

  // All metrics below are derived from the GROUPED view, per spec
  // ("metrics update based on the grouped view"), not the raw tuples.
  const bestBid = bids[0];
  const bestAsk = asks[0];
  const mid = bestBid && bestAsk ? (bestBid.price + bestAsk.price) / 2 : 0;
  const spreadAbs = bestBid && bestAsk ? bestAsk.price - bestBid.price : 0;
  const spreadBps = mid !== 0 ? (spreadAbs / mid) * 10000 : 0;

  const bidTotal = bids[bids.length - 1]?.cumulative ?? 0;
  const askTotal = asks[asks.length - 1]?.cumulative ?? 0;
  const imbalance = askTotal !== 0 ? bidTotal / askTotal : 0;
  const maxCum = Math.max(bidTotal, askTotal);

  return {
    symbol: msg.symbol,
    bids,
    asks,
    mid,
    spreadAbs,
    spreadBps,
    imbalance,
    maxCum,
  };
}
