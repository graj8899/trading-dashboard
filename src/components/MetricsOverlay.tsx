import { useEffect, useState } from "react";
import {
  ENGINE_NAMES,
  readEngineMetrics,
  setMetricsEnabled,
  type EngineMetricsSnapshot,
  type EngineName,
} from "../metrics/engineMetrics";

const UPDATE_INTERVAL_MS = 500;

interface PerformanceMemory {
  usedJSHeapSize: number;
}

// performance.memory is a non-standard, Chrome-only API — not in lib.dom.d.ts.
interface PerformanceWithMemory extends Performance {
  memory?: PerformanceMemory;
}

function readHeapMB(): number | null {
  const perf = performance as PerformanceWithMemory;
  if (!perf.memory) return null;
  return perf.memory.usedJSHeapSize / (1024 * 1024);
}

interface EngineDisplayRow {
  name: EngineName;
  messagesPerSec: number;
  flushesPerSec: number;
  dropRatio: number;
  lastFlushMs: number;
  p95FlushMs: number;
}

interface OverlayState {
  fps: number;
  heapMB: number | null;
  rows: EngineDisplayRow[];
}

const EMPTY_STATE: OverlayState = { fps: 0, heapMB: null, rows: [] };

type SnapshotByEngine = Partial<Record<EngineName, EngineMetricsSnapshot>>;

function buildRows(
  previous: SnapshotByEngine,
  elapsedSec: number,
): { rows: EngineDisplayRow[]; current: SnapshotByEngine } {
  const current: SnapshotByEngine = {};
  const rows: EngineDisplayRow[] = [];

  for (const name of ENGINE_NAMES) {
    const snapshot = readEngineMetrics(name);
    current[name] = snapshot;

    const prev = previous[name];
    const messagesDelta = snapshot.messagesIn - (prev?.messagesIn ?? 0);
    const flushesDelta = snapshot.flushesOut - (prev?.flushesOut ?? 0);
    const messagesPerSec = elapsedSec > 0 ? messagesDelta / elapsedSec : 0;
    const flushesPerSec = elapsedSec > 0 ? flushesDelta / elapsedSec : 0;
    const dropRatio = messagesDelta > 0 ? 1 - flushesDelta / messagesDelta : 0;

    rows.push({
      name,
      messagesPerSec,
      flushesPerSec,
      dropRatio: Math.max(0, Math.min(1, dropRatio)),
      lastFlushMs: snapshot.lastFlushMs,
      p95FlushMs: snapshot.p95FlushMs,
    });
  }

  return { rows, current };
}

// Dev-only. Toggled with the backtick key. When hidden, no rAF loop runs,
// no metrics are recorded by the engines (setMetricsEnabled(false)), and
// this component renders nothing — zero cost beyond one keydown listener.
export function MetricsOverlay() {
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<OverlayState>(EMPTY_STATE);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "`") setVisible((v) => !v);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    setMetricsEnabled(visible);
    // Nothing renders while hidden (see the early return below), so there's
    // no need to eagerly clear `state` here — it's simply repopulated by
    // the loop the next time this effect turns the panel back on.
    if (!visible) return;

    let rafHandle: number;
    let frameCount = 0;
    let windowStart = performance.now();
    let lastUpdate = windowStart;
    let previousSnapshots: SnapshotByEngine = {};

    const loop = (now: number): void => {
      frameCount += 1;

      if (now - lastUpdate >= UPDATE_INTERVAL_MS) {
        const elapsedSec = (now - windowStart) / 1000;
        const fps = elapsedSec > 0 ? frameCount / elapsedSec : 0;
        const { rows, current } = buildRows(previousSnapshots, elapsedSec);

        setState({ fps, heapMB: readHeapMB(), rows });

        previousSnapshots = current;
        frameCount = 0;
        windowStart = now;
        lastUpdate = now;
      }

      rafHandle = requestAnimationFrame(loop);
    };
    rafHandle = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(rafHandle);
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: "0.5em",
        right: "0.5em",
        zIndex: 9999,
        padding: "0.5em 0.6em",
        borderRadius: "6px",
        background: "rgba(20, 20, 24, 0.88)",
        color: "#e5e4e7",
        fontFamily:
          "ui-monospace, Consolas, monospace",
        fontSize: "11px",
        lineHeight: 1.5,
        pointerEvents: "none",
      }}
    >
      <div style={{ marginBottom: "0.3em" }}>
        {state.fps.toFixed(0)} fps
        {state.heapMB !== null && ` · ${state.heapMB.toFixed(1)} MB heap`}
      </div>
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ opacity: 0.6 }}>
            <th style={{ textAlign: "left", padding: "0 0.6em 0 0" }}>engine</th>
            <th style={{ textAlign: "right", padding: "0 0.6em" }}>in/s</th>
            <th style={{ textAlign: "right", padding: "0 0.6em" }}>out/s</th>
            <th style={{ textAlign: "right", padding: "0 0.6em" }}>drop</th>
            <th style={{ textAlign: "right", padding: "0 0.6em" }}>last</th>
            <th style={{ textAlign: "right", padding: "0 0 0 0.6em" }}>p95</th>
          </tr>
        </thead>
        <tbody>
          {state.rows.map((row) => (
            <tr key={row.name}>
              <td style={{ padding: "0 0.6em 0 0" }}>{row.name}</td>
              <td style={{ textAlign: "right", padding: "0 0.6em" }}>
                {row.messagesPerSec.toFixed(0)}
              </td>
              <td style={{ textAlign: "right", padding: "0 0.6em" }}>
                {row.flushesPerSec.toFixed(0)}
              </td>
              <td style={{ textAlign: "right", padding: "0 0.6em" }}>
                {(row.dropRatio * 100).toFixed(0)}%
              </td>
              <td style={{ textAlign: "right", padding: "0 0.6em" }}>
                {row.lastFlushMs.toFixed(2)}ms
              </td>
              <td style={{ textAlign: "right", padding: "0 0 0 0.6em" }}>
                {row.p95FlushMs.toFixed(2)}ms
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
