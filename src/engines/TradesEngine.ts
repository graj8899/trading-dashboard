import type { TradeMessage } from "../types/messages";
import { deriveSide, mergeIntoRows, type TradeRow } from "./trades/merge";
import { RollingStats, type RollingStatsSnapshot } from "./trades/RollingStats";

const MAX_PENDING = 2000; // beyond this, shed oldest pending (stress-mode)
const VISIBLE_ROWS = 200; // ring buffer of visible (merged) rows

export type PublishTradeRows = (
  rows: readonly TradeRow[],
  epoch: number,
) => void;

export type PublishTradeStats = (
  stats: RollingStatsSnapshot,
  epoch: number,
) => void;

export interface TradesEngineDeps {
  publishTrades: PublishTradeRows;
  publishStats: PublishTradeStats;
  getEpoch: () => number;
}

interface PendingTrade {
  trade: TradeMessage;
  epoch: number;
}

// Framework-free. Holding structure is a bounded FIFO queue (unlike the
// ticker/orderbook engines' single-slot overwrite): every trade matters for
// the merged feed and the rolling stats, none can be dropped as "superseded"
// the way a stale orderbook snapshot can. Under sustained overload the queue
// still has to shed something to stay bounded — the oldest *pending* trade,
// documented stress behavior, not a silent drop.
export class TradesEngine {
  private readonly publishTrades: PublishTradeRows;
  private readonly publishStats: PublishTradeStats;
  private readonly getEpoch: () => number;

  private pending: PendingTrade[] = [];
  private rows: TradeRow[] = [];
  private readonly rollingStats = new RollingStats();
  private rafHandle: number | null = null;
  private lastSeenEpoch: number | null = null;
  private lastStatsPublishedSecond: number | null = null;

  constructor(deps: TradesEngineDeps) {
    this.publishTrades = deps.publishTrades;
    this.publishStats = deps.publishStats;
    this.getEpoch = deps.getEpoch;
  }

  onMessage(trade: TradeMessage): void {
    this.pending.push({ trade, epoch: this.getEpoch() });
    if (this.pending.length > MAX_PENDING) {
      this.pending.shift(); // shed oldest pending, not the newest
    }
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
    const currentEpoch = this.getEpoch();

    if (this.lastSeenEpoch !== currentEpoch) {
      // Fresh epoch (reconnect or focus switch): the merged feed and the
      // rolling stats both belong to a different symbol/session now.
      this.rows = [];
      this.rollingStats.reset();
      this.lastSeenEpoch = currentEpoch;
      this.lastStatsPublishedSecond = null; // force an immediate stats publish
    }

    const toProcess = this.pending;
    this.pending = [];

    let rowsChanged = false;

    for (const { trade, epoch } of toProcess) {
      if (epoch < currentEpoch) continue; // buffered under a stale epoch

      this.rows = mergeIntoRows(this.rows, trade);
      this.rollingStats.record(
        deriveSide(trade),
        trade.size,
        trade.timestamp / 1000,
      );
      rowsChanged = true;
    }

    if (this.rows.length > VISIBLE_ROWS) {
      this.rows = this.rows.slice(this.rows.length - VISIBLE_ROWS);
    }

    if (rowsChanged) {
      this.publishTrades(this.rows, currentEpoch);
    }

    // Stats publish at 1Hz, independent of the feed: gated by wall-clock
    // second, not by whether any trades arrived this frame. tick() is
    // idempotent within the same second, so calling it here even right
    // after record() above is harmless.
    const nowSecond = Math.floor(now / 1000);
    if (
      this.lastStatsPublishedSecond === null ||
      nowSecond > this.lastStatsPublishedSecond
    ) {
      this.rollingStats.tick(now);
      this.publishStats(this.rollingStats.getStats(), currentEpoch);
      this.lastStatsPublishedSecond = nowSecond;
    }
  }
}
