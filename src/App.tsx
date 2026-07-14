import { useEffect } from "react";
import { ConnectionBadge } from "./components/ConnectionBadge";
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
    </div>
  );
}

export default App;
