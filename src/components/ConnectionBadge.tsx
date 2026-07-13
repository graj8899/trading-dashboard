import { memo } from "react";
import { useConnectionStore } from "../stores/connection";
import type { ConnectionStatus } from "../transport/SocketClient";

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
};

const STATUS_COLOR: Record<ConnectionStatus, string> = {
  connecting: "#e6a700",
  connected: "#1f9d55",
  reconnecting: "#e6a700",
  disconnected: "#c0392b",
};

function ConnectionBadgeImpl() {
  const status = useConnectionStore((s) => s.status);

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4em",
        fontSize: "0.85em",
      }}
    >
      <span
        style={{
          width: "0.6em",
          height: "0.6em",
          borderRadius: "50%",
          background: STATUS_COLOR[status],
        }}
      />
      {STATUS_LABEL[status]}
    </span>
  );
}

export const ConnectionBadge = memo(ConnectionBadgeImpl);
