import { create } from "zustand";
import type { ConnectionStatus } from "../transport/SocketClient";

interface ConnectionState {
  status: ConnectionStatus;
  epoch: number;
}

export const useConnectionStore = create<ConnectionState>(() => ({
  status: "disconnected",
  epoch: 0,
}));

// The only writer: called by the SocketClient.onStatus adapter in bootTransport.
export function setConnectionState(status: ConnectionStatus, epoch: number): void {
  useConnectionStore.setState({ status, epoch });
}
