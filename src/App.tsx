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
    <div className="app">
      <header className="app-header">
        <div className="app-header__inner">
          <div className="brand">
            <span className="brand__mark" aria-hidden="true">
              ◆
            </span>
            <span className="brand__title">Trading Dashboard</span>
            <span className="brand__sub">Real-time market data</span>
          </div>
          <ConnectionBadge />
        </div>
      </header>

      <main className="app-main">
        <TickerBar />
        <div className="panels">
          <OrderBookPanel />
          <TradesPanel />
        </div>
      </main>

      {import.meta.env.DEV && <MetricsOverlay />}
    </div>
  );
}

export default App;
