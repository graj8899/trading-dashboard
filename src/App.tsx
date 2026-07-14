import { useEffect } from "react";
import { ConnectionBadge } from "./components/ConnectionBadge";
import { OrderBookPanel } from "./components/OrderBookPanel";
import { TickerBar } from "./components/TickerBar";
import { bootTransport } from "./transport/bootTransport";

function App() {
  useEffect(() => {
    bootTransport();
  }, []);

  return (
    <div>
      <ConnectionBadge />
      <TickerBar />
      <OrderBookPanel />
    </div>
  );
}

export default App;
