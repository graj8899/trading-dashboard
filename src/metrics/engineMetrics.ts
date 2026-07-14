// Dev-only instrumentation counters. Framework-free, no store imports.
// Everything here is a no-op unless `setMetricsEnabled(true)` has been
// called (the overlay does this on toggle-on) — so when the overlay is
// hidden, engines pay only a single boolean check per message/flush, not
// the cost of counting or timing anything.

export type EngineName = "ticker" | "orderbook" | "trades";

export const ENGINE_NAMES: readonly EngineName[] = [
  "ticker",
  "orderbook",
  "trades",
];

// ~2s of samples at 60fps — enough for a stable p95 without unbounded growth.
const MAX_FLUSH_SAMPLES = 120;

class EngineMetricsCounters {
  messagesIn = 0;
  flushesOut = 0; // flushes that actually published (vs. coalesced away)
  lastFlushMs = 0;
  private readonly flushDurations: number[] = [];

  recordMessage(): void {
    this.messagesIn += 1;
  }

  recordFlush(durationMs: number, published: boolean): void {
    this.lastFlushMs = durationMs;
    this.flushDurations.push(durationMs);
    if (this.flushDurations.length > MAX_FLUSH_SAMPLES) {
      this.flushDurations.shift();
    }
    if (published) this.flushesOut += 1;
  }

  p95FlushMs(): number {
    if (this.flushDurations.length === 0) return 0;
    const sorted = [...this.flushDurations].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    return sorted[idx] ?? 0;
  }

  reset(): void {
    this.messagesIn = 0;
    this.flushesOut = 0;
    this.lastFlushMs = 0;
    this.flushDurations.length = 0;
  }
}

const counters: Record<EngineName, EngineMetricsCounters> = {
  ticker: new EngineMetricsCounters(),
  orderbook: new EngineMetricsCounters(),
  trades: new EngineMetricsCounters(),
};

let enabled = false;

export function isMetricsEnabled(): boolean {
  return enabled;
}

// Resets all counters on enable, so a session that was briefly toggled on
// once doesn't leave a huge messagesIn/flushesOut total muddying the next.
export function setMetricsEnabled(value: boolean): void {
  enabled = value;
  if (value) {
    for (const name of ENGINE_NAMES) counters[name].reset();
  }
}

export function recordMessage(engine: EngineName): void {
  if (!enabled) return;
  counters[engine].recordMessage();
}

export function recordFlush(
  engine: EngineName,
  durationMs: number,
  published: boolean,
): void {
  if (!enabled) return;
  counters[engine].recordFlush(durationMs, published);
}

export interface EngineMetricsSnapshot {
  messagesIn: number;
  flushesOut: number;
  lastFlushMs: number;
  p95FlushMs: number;
}

// A pure O(1) read of the current cumulative counters (except p95, which
// sorts the bounded sample window — at most 120 entries, negligible).
export function readEngineMetrics(engine: EngineName): EngineMetricsSnapshot {
  const c = counters[engine];
  return {
    messagesIn: c.messagesIn,
    flushesOut: c.flushesOut,
    lastFlushMs: c.lastFlushMs,
    p95FlushMs: c.p95FlushMs(),
  };
}
