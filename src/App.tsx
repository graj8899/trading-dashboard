import { useEffect } from "react";
import { ConnectionBadge } from "./components/ConnectionBadge";
import { bootTransport } from "./transport/bootTransport";

function App() {
  useEffect(() => {
    bootTransport();
  }, []);

  return (
    <div>
      <ConnectionBadge />
    </div>
  );
}

export default App;
