import type { Symbol } from "../../config/symbols";
import type { TradeMessage } from "../../types/messages";

export type TradeSide = "buy" | "sell";

const MERGE_WINDOW_MS = 100;

export interface TradeRow {
  symbol: Symbol;
  price: number;
  side: TradeSide; // the side of the row's FIRST trade — see mergeIntoRows
  size: number; // accumulated size across all merged trades
  count: number; // number of raw trades merged into this row
  firstTimestampMs: number; // merge window is measured from this
  lastTimestampMs: number; // most recent contributing trade, for reference
  timeLabel: string; // "HH:MM:SS.mmm", formatted once at ingest (UTC)
}

// There is no `side` field on the wire — derive it: a taker buyer means the
// trade was initiated by a buy order hitting the book, i.e. a buy.
export function deriveSide(trade: TradeMessage): TradeSide {
  return trade.buyer_role === "taker" ? "buy" : "sell";
}

function pad(n: number, width: number): string {
  return n.toString().padStart(width, "0");
}

// UTC, not local time: keeps formatting deterministic regardless of the
// host machine's timezone (both in tests and in different deployments).
export function formatTradeTime(ms: number): string {
  const date = new Date(ms);
  const hh = pad(date.getUTCHours(), 2);
  const mm = pad(date.getUTCMinutes(), 2);
  const ss = pad(date.getUTCSeconds(), 2);
  const mmm = pad(date.getUTCMilliseconds(), 3);
  return `${hh}:${mm}:${ss}.${mmm}`;
}

// Pure, framework-free. Appends `trade` to `rows`, merging into the last row
// when the price matches AND the trade arrives within MERGE_WINDOW_MS of
// that row's FIRST trade (not its most recent one — a fast run of trades at
// one price is capped at a 100ms window, not extended indefinitely).
//
// Assumption: side is not part of the merge key (the spec only mentions
// price + window). A merged row keeps the side of its first trade.
//
// Does not cap row count — the 200-row visible ring buffer is the
// TradesEngine's concern, layered on top of this pure merge step.
export function mergeIntoRows(
  rows: readonly TradeRow[],
  trade: TradeMessage,
): TradeRow[] {
  const price = parseFloat(trade.price);
  const timestampMs = trade.timestamp / 1000; // µs -> ms, once

  const lastRow = rows[rows.length - 1];
  if (
    lastRow &&
    lastRow.price === price &&
    timestampMs - lastRow.firstTimestampMs <= MERGE_WINDOW_MS
  ) {
    const mergedRow: TradeRow = {
      ...lastRow,
      size: lastRow.size + trade.size,
      count: lastRow.count + 1,
      lastTimestampMs: timestampMs,
    };
    return [...rows.slice(0, -1), mergedRow];
  }

  const newRow: TradeRow = {
    symbol: trade.symbol,
    price,
    side: deriveSide(trade),
    size: trade.size,
    count: 1,
    firstTimestampMs: timestampMs,
    lastTimestampMs: timestampMs,
    timeLabel: formatTradeTime(timestampMs),
  };
  return [...rows, newRow];
}
