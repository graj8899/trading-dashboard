import type { CSSProperties } from "react";
import { SYMBOL_CONFIG } from "../config/symbols";
import type { FlashLevel } from "../engines/OrderBookEngine";
import { useMarketStore } from "../stores/market";
import { useOrderbookStore } from "../stores/orderbook";
import { usePreferencesStore } from "../stores/preferences";

const VISIBLE_LEVELS = 12;
const ROW_HEIGHT = "22px";
const COLUMNS = "auto 1fr 1fr 1fr"; // depth-bar gutter is layered, not a column

type Side = "bid" | "ask";

function formatNumber(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

// Fixed-length row list padded with `null` so exactly VISIBLE_LEVELS rows
// are always rendered per side — a stable DOM with zero layout shift,
// regardless of how thin the book or how sparse the grouped view is.
function toFixedRows(levels: FlashLevel[]): (FlashLevel | null)[] {
  const rows: (FlashLevel | null)[] = [];
  for (let i = 0; i < VISIBLE_LEVELS; i++) {
    rows.push(levels[i] ?? null);
  }
  return rows;
}

const rowGridStyle: CSSProperties = {
  position: "relative",
  height: ROW_HEIGHT,
  display: "grid",
  gridTemplateColumns: COLUMNS,
  alignItems: "center",
  fontVariantNumeric: "tabular-nums",
  fontSize: "0.85em",
};

const cellStyle: CSSProperties = {
  position: "relative",
  zIndex: 2,
  padding: "0 0.5em",
  textAlign: "right",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

interface OrderBookRowProps {
  side: Side;
  row: FlashLevel | null;
  maxCum: number;
  precision: number;
}

function OrderBookRow({ side, row, maxCum, precision }: OrderBookRowProps) {
  const ratio = row && maxCum > 0 ? Math.min(row.cumulative / maxCum, 1) : 0;
  const depthColor =
    side === "bid" ? "rgba(31, 157, 85, 0.15)" : "rgba(192, 57, 43, 0.15)";

  return (
    <div style={rowGridStyle}>
      {row && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 0,
            background: depthColor,
            transformOrigin: side === "bid" ? "left" : "right",
            transform: `scaleX(${ratio})`,
          }}
        />
      )}
      {/* Persistent flash overlay: ONE stable element per row, never
          remounted. The tint is driven directly by row.flash and fades out
          via a CSS transition. The previous approach mounted a NEW keyed
          element per flash to restart a keyframe animation; under
          constant-flash stress that churned ~1,400 animated divs/sec, and a
          detached element with a running CSS animation is retained until the
          animation ends — leaking the DOM node count (72k+ and climbing). A
          stable element + transition has zero churn. */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 1,
          pointerEvents: "none",
          transition: "background-color 140ms ease-out",
          backgroundColor:
            row?.flash === "up"
              ? "rgba(31, 157, 85, 0.45)"
              : row?.flash === "down"
                ? "rgba(192, 57, 43, 0.45)"
                : "transparent",
        }}
      />
      <span style={{ ...cellStyle, textAlign: "left" }}>
        {row ? formatNumber(row.price, precision) : ""}
      </span>
      <span style={cellStyle}>{row ? formatNumber(row.size, 4) : ""}</span>
      <span style={cellStyle}>
        {row ? formatNumber(row.cumulative, 4) : ""}
      </span>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div style={rowGridStyle}>
      <span
        className="orderbook-skeleton"
        style={{
          position: "relative",
          zIndex: 2,
          margin: "0 0.5em",
          height: "0.8em",
          borderRadius: "3px",
          background: "var(--border)",
        }}
      />
    </div>
  );
}

export function OrderBookPanel() {
  const focusedSymbol = useMarketStore((s) => s.focusedSymbol);
  const view = useOrderbookStore((s) => s.view);
  const loading = useOrderbookStore((s) => s.loading);
  const grouping = usePreferencesStore((s) => s.grouping[focusedSymbol]);
  const setGrouping = usePreferencesStore((s) => s.setGrouping);

  const { precision, groupingLadder } = SYMBOL_CONFIG[focusedSymbol];

  // Top -> bottom: worst ask ... best ask, spread row, best bid ... worst
  // bid. Best ask (index 0) sits nearest the spread, same as best bid.
  const askRows = [...toFixedRows(view?.asks ?? [])].reverse();
  const bidRows = toFixedRows(view?.bids ?? []);
  const maxCum = view?.maxCum ?? 0;

  const showSkeleton = loading || !view;

  return (
    <section style={{ width: "100%", maxWidth: "24em" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.5em",
        }}
      >
        <h3 style={{ margin: 0, fontSize: "1em" }}>{focusedSymbol} Book</h3>
        <select
          aria-label="Grouping"
          value={grouping}
          onChange={(e) => setGrouping(focusedSymbol, Number(e.target.value))}
        >
          {groupingLadder.map((increment) => (
            <option key={increment} value={increment}>
              {increment}
            </option>
          ))}
        </select>
      </div>

      <div>
        {showSkeleton
          ? Array.from({ length: VISIBLE_LEVELS }, (_, i) => (
              <SkeletonRow key={`ask-skeleton-${i}`} />
            ))
          : askRows.map((row, i) => (
              <OrderBookRow
                key={`ask-${i}`}
                side="ask"
                row={row}
                maxCum={maxCum}
                precision={precision}
              />
            ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr 1fr",
          alignItems: "center",
          padding: "0.4em 0.5em",
          margin: "0.25em 0",
          borderTop: "1px solid var(--border)",
          borderBottom: "1px solid var(--border)",
          fontSize: "0.85em",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {showSkeleton ? (
          <span className="orderbook-skeleton" style={{ gridColumn: "1 / -1" }}>
            &nbsp;
          </span>
        ) : (
          <>
            <span title="Mid">{formatNumber(view.mid, precision)}</span>
            <span title="Spread (abs)">
              {formatNumber(view.spreadAbs, precision)}
            </span>
            <span title="Spread (bps)">{formatNumber(view.spreadBps, 2)} bps</span>
            <span title="Imbalance">{formatNumber(view.imbalance, 2)}</span>
          </>
        )}
      </div>

      <div>
        {showSkeleton
          ? Array.from({ length: VISIBLE_LEVELS }, (_, i) => (
              <SkeletonRow key={`bid-skeleton-${i}`} />
            ))
          : bidRows.map((row, i) => (
              <OrderBookRow
                key={`bid-${i}`}
                side="bid"
                row={row}
                maxCum={maxCum}
                precision={precision}
              />
            ))}
      </div>
    </section>
  );
}
