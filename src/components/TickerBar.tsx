import { SYMBOLS } from "../config/symbols";
import { TickerCell } from "./TickerCell";

export function TickerBar() {
  return (
    <div style={{ display: "flex", gap: "0.5em", flexWrap: "wrap" }}>
      {SYMBOLS.map((symbol) => (
        <TickerCell key={symbol} symbol={symbol} />
      ))}
    </div>
  );
}
