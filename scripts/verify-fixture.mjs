// Phase 0 fixture verification — one channel at a time.
// Subscribes to a SINGLE channel, pulls one fresh message off the wire,
// and structurally compares it against the saved fixture. Read-only:
// it never writes or overwrites anything.
//
// Usage (backend running, from repo root):
//   node scripts/verify-fixture.mjs v2/ticker
//   node scripts/verify-fixture.mjs all_trades
//   node scripts/verify-fixture.mjs l2_orderbook
//
// Requires Node 18+ (built-in global WebSocket).

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHANNEL = process.argv[2];
const SYMBOL = "BTCUSD";
const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/fixtures");

const CHANNELS = {
  "v2/ticker": "ticker.json",
  l2_orderbook: "orderbook.json",
  all_trades: "trades.json",
};

if (!CHANNELS[CHANNEL]) {
  console.error(`Pass one channel: ${Object.keys(CHANNELS).join(" | ")}`);
  process.exit(1);
}

const fixturePath = resolve(FIXTURE_DIR, CHANNELS[CHANNEL]);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

const ws = new WebSocket("ws://localhost:8080");
const timeout = setTimeout(() => {
  console.error("Timed out after 15s — is the backend running on :8080?");
  process.exit(1);
}, 15000);

ws.addEventListener("open", () => {
  ws.send(
    JSON.stringify({
      type: "subscribe",
      payload: { channels: [{ name: CHANNEL, symbols: [SYMBOL] }] },
    }),
  );
});

ws.addEventListener("message", (event) => {
  let live;
  try {
    live = JSON.parse(event.data);
  } catch {
    return;
  }
  if (live.type !== CHANNEL) return; // skip the subscriptions ack

  clearTimeout(timeout);
  compare(CHANNEL, fixture, live);
  ws.close();
  process.exit(0);
});

ws.addEventListener("error", (err) => {
  console.error("WebSocket error — is the backend running on :8080?", err.message ?? err);
  process.exit(1);
});

function keySet(obj) {
  return new Set(Object.keys(obj));
}

function compare(channel, fixt, live) {
  console.log(`\n=== Verifying ${channel} against ${CHANNELS[channel]} ===\n`);

  const fk = keySet(fixt);
  const lk = keySet(live);
  const missing = [...fk].filter((k) => !lk.has(k)); // in fixture, not live
  const extra = [...lk].filter((k) => !fk.has(k)); // in live, not fixture

  console.log(`fixture top-level keys: ${[...fk].sort().join(", ")}`);
  console.log(`live    top-level keys: ${[...lk].sort().join(", ")}`);

  let ok = true;
  if (missing.length) {
    ok = false;
    console.log(`\n  ⚠ in fixture but MISSING live: ${missing.join(", ")}`);
  }
  if (extra.length) {
    ok = false;
    console.log(`\n  ⚠ live has keys NOT in fixture: ${extra.join(", ")}`);
  }

  // Channel-specific spot checks
  if (channel === "l2_orderbook") {
    console.log(`\n  fixture bids/asks: ${fixt.bids.length}/${fixt.asks.length}`);
    console.log(`  live    bids/asks: ${live.bids.length}/${live.asks.length}`);
    console.log(`  sample fixture bid[0]: ${JSON.stringify(fixt.bids[0])}`);
    console.log(`  sample live    bid[0]: ${JSON.stringify(live.bids[0])}`);
  } else {
    console.log(`\n  fixture: ${JSON.stringify(fixt)}`);
    console.log(`  live   : ${JSON.stringify(live)}`);
  }

  console.log(`\n${ok ? "✅ SHAPES MATCH — fixture is representative." : "❌ SHAPE DIFFERENCE — see warnings above."}\n`);
}
