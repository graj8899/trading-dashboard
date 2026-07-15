import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { SYMBOL_CONFIG } from "../config/symbols";
import type { TradeRow } from "../engines/trades/merge";
import { useMarketStore } from "../stores/market";
import { usePreferencesStore } from "../stores/preferences";
import { useTradeStatsStore } from "../stores/tradeStats";
import { useTradesStore } from "../stores/trades";

const SCROLL_BOTTOM_THRESHOLD_PX = 40;
const BUY_COLOR = "#1f9d55";
const SELL_COLOR = "#c0392b";

function formatPrice(value: number, precision: number): string {
  return value.toFixed(precision);
}

function formatSize(value: number): string {
  return value.toFixed(4);
}

function RollingStatsBar() {
  const stats = useTradeStatsStore((s) => s.stats);
  const total = stats.buyVol + stats.sellVol;
  const buyRatio = total > 0 ? stats.buyVol / total : 0.5;

  return (
    <div style={{ marginBottom: "0.5em" }}>
      <div
        aria-hidden="true"
        style={{
          display: "flex",
          height: "6px",
          borderRadius: "3px",
          overflow: "hidden",
          background: "var(--border)",
        }}
      >
        <div style={{ width: `${buyRatio * 100}%`, background: BUY_COLOR }} />
        <div style={{ flex: 1, background: SELL_COLOR }} />
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "0.8em",
          marginTop: "0.25em",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span title="Buy volume (60s)" style={{ color: BUY_COLOR }}>
          buy {formatSize(stats.buyVol)}
        </span>
        <span title="Trade count (60s)">{stats.count} trades</span>
        <span title="Average size (60s)">avg {formatSize(stats.avgSize)}</span>
        <span title="Sell volume (60s)" style={{ color: SELL_COLOR }}>
          sell {formatSize(stats.sellVol)}
        </span>
      </div>
    </div>
  );
}

const rowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr 1fr auto",
  alignItems: "center",
  gap: "0.5em",
  padding: "0.2em 0.5em",
  fontSize: "0.85em",
  fontVariantNumeric: "tabular-nums",
};

interface TradeRowItemProps {
  row: TradeRow;
  precision: number;
}

function TradeRowItem({ row, precision }: TradeRowItemProps) {
  // Read live, at render time, rather than a flag frozen at ingest — so
  // editing the threshold restyles every visible row immediately, even
  // during a quiet market with no new trades to trigger a recompute.
  const focusedSymbol = useMarketStore((s) => s.focusedSymbol);
  const threshold = usePreferencesStore(
    (s) => s.largeTradeThreshold[focusedSymbol],
  );
  const large = row.price * row.size >= threshold;

  const sideColor = row.side === "buy" ? BUY_COLOR : SELL_COLOR;
  const largeBackground =
    row.side === "buy" ? "rgba(31, 157, 85, 0.12)" : "rgba(192, 57, 43, 0.12)";

  return (
    <div
      style={{
        ...rowStyle,
        fontWeight: large ? 700 : 400,
        background: large ? largeBackground : "transparent",
      }}
    >
      <span style={{ opacity: 0.65 }}>{row.timeLabel}</span>
      <span style={{ color: sideColor }}>
        {formatPrice(row.price, precision)}
      </span>
      <span>{formatSize(row.size)}</span>
      <span style={{ opacity: 0.7 }}>{row.count > 1 ? `×${row.count}` : ""}</span>
    </div>
  );
}

export function TradesPanel() {
  const focusedSymbol = useMarketStore((s) => s.focusedSymbol);
  const rows = useTradesStore((s) => s.rows);
  const loading = useTradesStore((s) => s.loading);
  const threshold = usePreferencesStore(
    (s) => s.largeTradeThreshold[focusedSymbol],
  );
  const setLargeTradeThreshold = usePreferencesStore(
    (s) => s.setLargeTradeThreshold,
  );

  const { precision } = SYMBOL_CONFIG[focusedSymbol];

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [isPinned, setIsPinned] = useState(true);

  // Pinned: scroll to the newest row every time the feed publishes.
  useEffect(() => {
    if (!isPinned) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [rows, isPinned]);

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Unpins on scroll-up past the threshold; repins on scroll-back-to-bottom.
    setIsPinned(distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD_PX);
  };

  const jumpToLatest = (): void => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setIsPinned(true);
  };

  return (
    <section className="panel panel--trades">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.75em",
        }}
      >
        <h3 style={{ margin: 0, fontSize: "1em", color: "var(--text-h)" }}>
          {focusedSymbol} Trades
        </h3>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.4em",
            fontSize: "0.8em",
            color: "var(--muted)",
          }}
        >
          Large ≥
          <input
            type="number"
            min={0}
            value={threshold}
            onChange={(e) =>
              setLargeTradeThreshold(focusedSymbol, Number(e.target.value))
            }
            style={{ width: "6em" }}
          />
        </label>
      </div>

      <RollingStatsBar />

      <div
        style={{
          ...rowStyle,
          padding: "0.2em 0.5em 0.4em",
          marginBottom: "0.15em",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span className="col-head">Time</span>
        <span className="col-head">Price</span>
        <span className="col-head">Size</span>
        <span className="col-head" style={{ textAlign: "right" }} />
      </div>

      <div style={{ position: "relative" }}>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          style={{
            height: "var(--feed-height, 30em)",
            overflowY: "auto",
            border: "1px solid var(--border)",
            borderRadius: "8px",
            background: "var(--panel-2)",
          }}
        >
          {loading || rows.length === 0 ? (
            <div style={{ padding: "1em", fontSize: "0.85em", opacity: 0.6 }}>
              Waiting for trades…
            </div>
          ) : (
            rows.map((row) => (
              <TradeRowItem
                key={`${row.firstTimestampMs}-${row.price}`}
                row={row}
                precision={precision}
              />
            ))
          )}
        </div>

        {!isPinned && (
          <button
            type="button"
            onClick={jumpToLatest}
            style={{
              position: "absolute",
              bottom: "0.5em",
              left: "50%",
              transform: "translateX(-50%)",
              padding: "0.3em 0.8em",
              borderRadius: "999px",
              border: "1px solid var(--border)",
              background: "var(--bg)",
              boxShadow: "var(--shadow)",
              cursor: "pointer",
              fontSize: "0.8em",
            }}
          >
            Jump to latest
          </button>
        )}
      </div>
    </section>
  );
}
