import { isMetricsEnabled, recordFlush, type EngineName } from "./engineMetrics";

// Wraps a publish callback (already the thing engines are constructed
// with) to flag "something was published this flush" — see consume().
export function withPublishFlag<Args extends unknown[]>(
  fn: (...args: Args) => void,
  onPublish: () => void,
): (...args: Args) => void {
  return (...args: Args) => {
    onPublish();
    fn(...args);
  };
}

export function createPublishedFlag(): {
  onPublish: () => void;
  consume: () => boolean;
} {
  let published = false;
  return {
    onPublish: () => {
      published = true;
    },
    consume: () => {
      const was = published;
      published = false;
      return was;
    },
  };
}

// Monkey-patches `target.flush` to time each call and record it, but ONLY
// when metrics are enabled — when disabled, the wrapped flush is just the
// original call plus one boolean check, so toggling the overlay off removes
// essentially all of the cost.
//
// Uses a performance.now() delta rather than the User Timing API
// (mark/measure): mark/measure entries accumulate and are not reliably
// reclaimed by clearMarks/clearMeasures, leaking the heap over a long dev
// session. A now() delta gives the same duration at the same resolution
// while creating zero timeline entries.
//
// This has to patch the instance rather than wrap at the call site because
// engines drive their own flush internally via start()'s rAF loop; there is
// no external hook into those internal calls other than the flush() method
// itself, which is deliberately public for exactly this kind of use.
export function instrumentFlush(
  engine: EngineName,
  target: { flush: (now?: number) => void },
  consumePublished: () => boolean,
): void {
  const originalFlush = target.flush.bind(target);
  target.flush = (now?: number) => {
    if (!isMetricsEnabled()) {
      originalFlush(now);
      return;
    }
    const start = performance.now();
    originalFlush(now);
    const duration = performance.now() - start;
    recordFlush(engine, duration, consumePublished());
  };
}
