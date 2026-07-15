import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderbookMessage } from "../types/messages";
import { OrderBookEngine, type OrderbookSnapshot } from "./OrderBookEngine";

function makeMessage(
  bids: [string, string][],
  asks: [string, string][],
): OrderbookMessage {
  return {
    type: "l2_orderbook",
    symbol: "BTCUSD",
    bids,
    asks,
    timestamp: 1_783_963_314_112_000,
  };
}

function lastSnapshot(
  publish: ReturnType<typeof vi.fn>,
): OrderbookSnapshot {
  const calls = publish.mock.calls;
  const lastCall = calls[calls.length - 1] as [OrderbookSnapshot, number];
  return lastCall[0];
}

describe("OrderBookEngine epoch guard", () => {
  it("discards a flush buffered under a stale epoch without publishing", () => {
    let epoch = 0;
    const publish = vi.fn();
    const engine = new OrderBookEngine({
      publish,
      getEpoch: () => epoch,
      getGroupingIncrement: () => 1,
      refreshMs: 0, // disable perceptual throttle; drive flash logic directly
    });

    // Message arrives while epoch is 0 (captured at ingestion time).
    engine.onMessage(
      makeMessage([["61785.0", "1.0000"]], [["61790.0", "1.0000"]]),
    );

    // A reconnect or focus switch bumps the epoch before the next flush.
    epoch = 1;
    engine.flush();

    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes normally when the flush epoch matches the current epoch", () => {
    const epoch = 0;
    const publish = vi.fn();
    const engine = new OrderBookEngine({
      publish,
      getEpoch: () => epoch,
      getGroupingIncrement: () => 1,
      refreshMs: 0, // disable perceptual throttle; drive flash logic directly
    });

    engine.onMessage(
      makeMessage([["61785.0", "1.0000"]], [["61790.0", "1.0000"]]),
    );
    engine.flush();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(expect.anything(), 0);
  });

  it("drops a message ingested under an old epoch even if a newer message arrives under the new epoch first", () => {
    let epoch = 0;
    const publish = vi.fn();
    const engine = new OrderBookEngine({
      publish,
      getEpoch: () => epoch,
      getGroupingIncrement: () => 1,
      refreshMs: 0, // disable perceptual throttle; drive flash logic directly
    });

    // Stale message buffered pre-reconnect, never flushed in time.
    engine.onMessage(
      makeMessage([["61785.0", "1.0000"]], [["61790.0", "1.0000"]]),
    );
    epoch = 1;
    // Fresh message arrives post-reconnect and overwrites the slot (the
    // engine holds only one latestRaw at a time), captured under epoch 1.
    engine.onMessage(
      makeMessage([["61800.0", "2.0000"]], [["61805.0", "2.0000"]]),
    );
    engine.flush();

    expect(publish).toHaveBeenCalledTimes(1);
    const snapshot = lastSnapshot(publish);
    expect(snapshot.bids[0]?.price).toBe(61800.0);
  });

  it("does not re-flush after the raw slot has already been consumed", () => {
    const publish = vi.fn();
    const engine = new OrderBookEngine({
      publish,
      getEpoch: () => 0,
      getGroupingIncrement: () => 1,
      refreshMs: 0, // disable perceptual throttle; drive flash logic directly
    });

    engine.onMessage(
      makeMessage([["61785.0", "1.0000"]], [["61790.0", "1.0000"]]),
    );
    engine.flush();
    engine.flush(); // no new message since the last flush

    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe("OrderBookEngine perceptual throttle", () => {
  it("publishes immediately, then at most once per refreshMs, always the latest snapshot", () => {
    const publish = vi.fn();
    const engine = new OrderBookEngine({
      publish,
      getEpoch: () => 0,
      getGroupingIncrement: () => 1,
      refreshMs: 1000,
    });

    engine.onMessage(makeMessage([["100.0", "1.0000"]], [["101.0", "1.0000"]]));
    engine.flush(0); // first publish is immediate
    expect(publish).toHaveBeenCalledTimes(1);

    engine.onMessage(makeMessage([["102.0", "1.0000"]], [["103.0", "1.0000"]]));
    engine.flush(500); // within the interval -> throttled, still buffered
    expect(publish).toHaveBeenCalledTimes(1);

    engine.onMessage(makeMessage([["104.0", "1.0000"]], [["105.0", "1.0000"]]));
    engine.flush(1000); // interval elapsed -> publishes the freshest snapshot
    expect(publish).toHaveBeenCalledTimes(2);
    expect(lastSnapshot(publish).bids[0]?.price).toBe(104.0);
  });

  it("bypasses the throttle on an epoch change for an immediate publish", () => {
    let epoch = 0;
    const publish = vi.fn();
    const engine = new OrderBookEngine({
      publish,
      getEpoch: () => epoch,
      getGroupingIncrement: () => 1,
      refreshMs: 1000,
    });

    engine.onMessage(makeMessage([["100.0", "1.0000"]], [["101.0", "1.0000"]]));
    engine.flush(0);
    expect(publish).toHaveBeenCalledTimes(1);

    epoch = 1; // focus switch / reconnect
    engine.onMessage(makeMessage([["200.0", "1.0000"]], [["201.0", "1.0000"]]));
    engine.flush(100); // only 100ms later, but a new epoch paints immediately
    expect(publish).toHaveBeenCalledTimes(2);
    expect(lastSnapshot(publish).bids[0]?.price).toBe(200.0);
  });
});

describe("OrderBookEngine flash rate limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not flash on the first sighting of a bucket", () => {
    const publish = vi.fn();
    const engine = new OrderBookEngine({
      publish,
      getEpoch: () => 0,
      getGroupingIncrement: () => 1,
      refreshMs: 0, // disable perceptual throttle; drive flash logic directly
    });

    engine.onMessage(
      makeMessage([["61785.0", "1.0000"]], [["61790.0", "1.0000"]]),
    );
    engine.flush();

    expect(lastSnapshot(publish).bids[0]?.flash).toBeNull();
  });

  it("flashes when a bucket's size changes by more than 10% vs the previous snapshot", () => {
    const publish = vi.fn();
    const engine = new OrderBookEngine({
      publish,
      getEpoch: () => 0,
      getGroupingIncrement: () => 1,
      refreshMs: 0, // disable perceptual throttle; drive flash logic directly
    });

    engine.onMessage(
      makeMessage([["61785.0", "1.0000"]], [["61790.0", "1.0000"]]),
    );
    engine.flush();

    vi.setSystemTime(50);
    engine.onMessage(
      makeMessage([["61785.0", "2.5000"]], [["61790.0", "1.0000"]]),
    );
    engine.flush();

    expect(lastSnapshot(publish).bids[0]?.flash).toBe("up");
  });

  it("does not flash on a <=10% size change", () => {
    const publish = vi.fn();
    const engine = new OrderBookEngine({
      publish,
      getEpoch: () => 0,
      getGroupingIncrement: () => 1,
      refreshMs: 0, // disable perceptual throttle; drive flash logic directly
    });

    engine.onMessage(
      makeMessage([["61785.0", "1.0000"]], [["61790.0", "1.0000"]]),
    );
    engine.flush();

    vi.setSystemTime(50);
    // 5% change -> well under the >10% threshold, must not flash.
    engine.onMessage(
      makeMessage([["61785.0", "1.0500"]], [["61790.0", "1.0000"]]),
    );
    engine.flush();

    expect(lastSnapshot(publish).bids[0]?.flash).toBeNull();
  });

  it("suppresses a second flash on the same bucket within the 300ms window", () => {
    const publish = vi.fn();
    const engine = new OrderBookEngine({
      publish,
      getEpoch: () => 0,
      getGroupingIncrement: () => 1,
      refreshMs: 0, // disable perceptual throttle; drive flash logic directly
    });

    engine.onMessage(
      makeMessage([["61785.0", "1.0000"]], [["61790.0", "1.0000"]]),
    );
    engine.flush(); // t=0: first sighting, no flash

    vi.setSystemTime(50);
    engine.onMessage(
      makeMessage([["61785.0", "2.5000"]], [["61790.0", "1.0000"]]),
    );
    engine.flush(); // t=50: big change, flashes
    expect(lastSnapshot(publish).bids[0]?.flash).toBe("up");

    vi.setSystemTime(100);
    engine.onMessage(
      makeMessage([["61785.0", "5.0000"]], [["61790.0", "1.0000"]]),
    );
    engine.flush(); // t=100: another big change, only 50ms after last flash
    expect(lastSnapshot(publish).bids[0]?.flash).toBeNull();
  });

  it("allows a new flash once 300ms have elapsed since the last one", () => {
    const publish = vi.fn();
    const engine = new OrderBookEngine({
      publish,
      getEpoch: () => 0,
      getGroupingIncrement: () => 1,
      refreshMs: 0, // disable perceptual throttle; drive flash logic directly
    });

    engine.onMessage(
      makeMessage([["61785.0", "1.0000"]], [["61790.0", "1.0000"]]),
    );
    engine.flush(); // t=0

    vi.setSystemTime(50);
    engine.onMessage(
      makeMessage([["61785.0", "2.5000"]], [["61790.0", "1.0000"]]),
    );
    engine.flush(); // t=50: flashes, lastFlashAt = 50

    vi.setSystemTime(100);
    engine.onMessage(
      makeMessage([["61785.0", "5.0000"]], [["61790.0", "1.0000"]]),
    );
    engine.flush(); // t=100: rate-limited, no flash

    vi.setSystemTime(400); // 350ms after the last real flash at t=50
    engine.onMessage(
      makeMessage([["61785.0", "6.0000"]], [["61790.0", "1.0000"]]),
    );
    engine.flush(); // t=400: >=300ms since t=50, flash allowed again

    expect(lastSnapshot(publish).bids[0]?.flash).toBe("up");
  });

  it("still updates the tracked size for a rate-limited bucket, so the next real change is measured from it", () => {
    const publish = vi.fn();
    const engine = new OrderBookEngine({
      publish,
      getEpoch: () => 0,
      getGroupingIncrement: () => 1,
      refreshMs: 0, // disable perceptual throttle; drive flash logic directly
    });

    engine.onMessage(
      makeMessage([["61785.0", "1.0000"]], [["61790.0", "1.0000"]]),
    );
    engine.flush(); // t=0

    vi.setSystemTime(50);
    engine.onMessage(
      makeMessage([["61785.0", "2.0000"]], [["61790.0", "1.0000"]]),
    );
    engine.flush(); // t=50: flashes; tracked size becomes 2.0

    vi.setSystemTime(100);
    // Rate-limited (only 50ms later), but tracked size still updates to 2.1.
    engine.onMessage(
      makeMessage([["61785.0", "2.1000"]], [["61790.0", "1.0000"]]),
    );
    engine.flush();
    expect(lastSnapshot(publish).bids[0]?.flash).toBeNull();

    vi.setSystemTime(500);
    // A modest change from 2.1 (not from the stale 2.0) after the window reopens.
    engine.onMessage(
      makeMessage([["61785.0", "2.15000"]], [["61790.0", "1.0000"]]),
    );
    engine.flush();
    expect(lastSnapshot(publish).bids[0]?.flash).toBeNull();
  });
});

// Reach into the engine's private flash-tracking state. A type-only cast
// (no `any`) rather than a new public API, since this is purely a test hook.
interface FlashTrackingInternals {
  previousBucketSizes: Map<string, number>;
  lastFlashAt: Map<string, number>;
}

function flashTrackingSizes(engine: OrderBookEngine): {
  sizes: number;
  flashAt: number;
} {
  const internals = engine as unknown as FlashTrackingInternals;
  return {
    sizes: internals.previousBucketSizes.size,
    flashAt: internals.lastFlashAt.size,
  };
}

describe("OrderBookEngine flash-tracking memory bound", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps previousBucketSizes and lastFlashAt bounded to 2×N as the mid wanders over many snapshots", () => {
    const N = 12;
    const publish = vi.fn();
    const engine = new OrderBookEngine({
      publish,
      getEpoch: () => 0,
      getGroupingIncrement: () => 1, // BTCUSD, precision 1 -> g = 10 ticks = 1.0
      refreshMs: 0, // disable perceptual throttle; drive flash logic directly
    });

    // 20 raw levels/side, one tick apart, so 20 distinct buckets are
    // produced before the pipeline's own N=12 early-exit caps the view —
    // exercising the same "more buckets exist than are visible" scrolling
    // that would otherwise leak stale entries into the tracking maps.
    const buildSide = (start: number, direction: 1 | -1): [string, string][] =>
      Array.from({ length: 20 }, (_, i) =>
        [(start + direction * i).toFixed(1), "1.0000"] as [string, string],
      );

    let time = 0;
    for (let i = 0; i < 200; i++) {
      // A deterministic "wandering" mid, in whole price units so bucket
      // boundaries stay aligned to g=10 ticks.
      const center = 61700 + ((i * 37) % 500);

      time += 350; // clear of the 300ms flash rate-limit window each time
      vi.setSystemTime(time);

      engine.onMessage(
        makeMessage(buildSide(center - 1, -1), buildSide(center + 1, 1)),
      );
      engine.flush();

      const { sizes, flashAt } = flashTrackingSizes(engine);
      expect(sizes).toBeLessThanOrEqual(2 * N);
      expect(flashAt).toBeLessThanOrEqual(2 * N);
    }

    // The mid visited far more than 2×N distinct buckets across 200
    // snapshots; if the maps weren't pruned each flush they'd have grown
    // roughly linearly with iteration count instead of staying capped.
    const final = flashTrackingSizes(engine);
    expect(final.sizes).toBeLessThanOrEqual(2 * N);
    expect(final.sizes).toBeGreaterThan(0);
  });
});
