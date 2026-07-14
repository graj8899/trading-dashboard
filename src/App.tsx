import { useEffect } from "react";
import { ConnectionBadge } from "./components/ConnectionBadge";
import { MetricsOverlay } from "./components/MetricsOverlay";
import { OrderBookPanel } from "./components/OrderBookPanel";
import { TickerBar } from "./components/TickerBar";
import { TradesPanel } from "./components/TradesPanel";
import { bootTransport } from "./transport/bootTransport";

function App() {
  useEffect(() => {
    bootTransport();
  }, []);

  return (
    <div>
      <ConnectionBadge />
      <TickerBar />
      <div style={{ display: "flex", gap: "1em", flexWrap: "wrap" }}>
        <OrderBookPanel />
        <TradesPanel />
      </div>
      {import.meta.env.DEV && <MetricsOverlay />}
    </div>
  );
}

export default App;
