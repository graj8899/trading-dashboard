// Phase 0 fixture capture.
// Connects to the backend, subscribes to BTCUSD on all three channels,
// grabs ONE message of each type + the subscriptions ack, writes them
// pretty-printed to docs/fixtures/, then exits.
//
// Run from the repo root with the backend already running:
//   node scripts/capture-fixtures.mjs
//
// Requires Node 18+ (uses the built-in global WebSocket).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const URL = "ws://localhost:8080";
const SYMBOL = "BTCUSD";
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/fixtures");

// type -> output filename. `subscriptions` is the ack.
const WANT = {
  subscriptions: "ack.json",
  "v2/ticker": "ticker.json",
  l2_orderbook: "orderbook.json",
  all_trades: "trades.json",
};

const captured = new Map();

const subscribe = {
  type: "subscribe",
  payload: {
    channels: [
      { name: "v2/ticker", symbols: [SYMBOL] },
      { name: "l2_orderbook", symbols: [SYMBOL] },
      { name: "all_trades", symbols: [SYMBOL] },
    ],
  },
};

const ws = new WebSocket(URL);

const timeout = setTimeout(() => {
  console.error("Timed out after 15s. Captured:", [...captured.keys()]);
  process.exit(1);
}, 15000);

ws.addEventListener("open", () => {
  console.log("Connected. Subscribing…");
  ws.send(JSON.stringify(subscribe));
});

ws.addEventListener("message", async (event) => {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return; // ignore malformed
  }
  const file = WANT[msg.type];
  if (!file || captured.has(msg.type)) return;

  captured.set(msg.type, msg);
  console.log(`  captured ${msg.type} -> ${file}`);

  if (captured.size === Object.keys(WANT).length) {
    clearTimeout(timeout);
    await mkdir(OUT_DIR, { recursive: true });
    for (const [type, m] of captured) {
      await writeFile(resolve(OUT_DIR, WANT[type]), JSON.stringify(m, null, 2) + "\n");
    }
    console.log(`\nWrote 4 fixtures to docs/fixtures/`);
    ws.close();
    process.exit(0);
  }
});

ws.addEventListener("error", (err) => {
  console.error("WebSocket error — is the backend running on :8080?", err.message ?? err);
  process.exit(1);
});
