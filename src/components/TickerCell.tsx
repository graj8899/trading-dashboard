import { memo } from "react";
import { SYMBOL_CONFIG } from "../config/symbols";
import type { Symbol } from "../config/symbols";
import { useMarketStore } from "../stores/market";
import { useTickersStore } from "../stores/tickers";

interface TickerCellProps {
  symbol: Symbol;
}

function TickerCellImpl({ symbol }: TickerCellProps) {
  const view = useTickersStore((s) => s.tickers[symbol]);
  const isFocused = useMarketStore((s) => s.focusedSymbol === symbol);
  const setFocusedSymbol = useMarketStore((s) => s.setFocusedSymbol);

  const precision = SYMBOL_CONFIG[symbol].precision;
  const price = view ? view.price.toFixed(precision) : "—";
  const changePct = view ? view.changePct : null;
  const changeColor =
    changePct === null ? undefined : changePct >= 0 ? "#1f9d55" : "#c0392b";
  const changeLabel =
    changePct === null
      ? ""
      : `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`;

  return (
    <button
      type="button"
      onClick={() => setFocusedSymbol(symbol)}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: "0.15em",
        padding: "0.5em 0.75em",
        minWidth: "7em",
        borderRadius: "6px",
        border: isFocused ? "2px solid #2563eb" : "1px solid #e5e4e7",
        background: isFocused ? "#eff6ff" : "none",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span style={{ fontWeight: 600 }}>{symbol}</span>
      <span>{price}</span>
      <span style={{ color: changeColor }}>{changeLabel}</span>
    </button>
  );
}

export const TickerCell = memo(TickerCellImpl);
