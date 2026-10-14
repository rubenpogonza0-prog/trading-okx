// Drives the live cycle against an in-memory fake of the OKX API, using
// the real NEAR candles up to a known long-entry candle.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ema4h-"));
process.env.INSTRUMENTS = "NEAR-USDT-SWAP";

const { runEmaTrend4hCycle } = await import("../src/trading/emaTrend4h/live.js");
const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/near-4h-closes.json", import.meta.url)));
const H4 = 4 * 3600 * 1000;
const ENTRY_TS = Date.UTC(2026, 8, 16, 8); // 16/09 08:00 — a long entry in the reference backtest

function fakeOkx({ lastIndex, acctLv, posMode }) {
  const calls = [];
  const algos = [];
  let position = null;
  const rows = () => {
    const out = [];
    for (let i = 0; i <= lastIndex; i++) {
      const c = String(fx.close[i]);
      out.push([String(fx.ts[i]), c, c, c, c, "1", "1", "1", "1"]);
    }
    const lastClose = String(fx.close[lastIndex]);
    out.push([String(fx.ts[lastIndex] + H4), lastClose, lastClose, lastClose, lastClose, "1", "1", "1", "0"]);
    return out.reverse(); // newest first, like OKX
  };
  const api = {
    calls,
    algos,
    get position() {
      return position;
    },
    set position(p) {
      position = p;
    },
    async get(p, q = {}) {
      calls.push(["GET", p, q]);
      switch (p) {
        case "/api/v5/account/config":
          return [{ posMode: posMode ?? "net_mode", acctLv: acctLv ?? "2" }];
        case "/api/v5/account/positions":
          return position ? [position] : [];
        case "/api/v5/account/balance":
          return [{ details: [{ ccy: "USDT", eq: "1000", availEq: "1000" }] }];
        case "/api/v5/public/instruments":
          return [{ instId: q.instId, ctVal: "10", lotSz: "0.01", minSz: "0.01", tickSz: "0.001", state: "live" }];
        case "/api/v5/market/candles":
        case "/api/v5/market/history-candles": {
          const all = rows();
          const after = q.after ? Number(q.after) : Infinity;
          const limit = Number(q.limit);
          return all.filter((r) => Number(r[0]) < after).slice(0, limit);
        }
        case "/api/v5/trade/orders-algo-pending":
          return q.ordType === "conditional" ? algos.filter((a) => a.instId === q.instId) : [];
        default:
          throw new Error(`unexpected GET ${p}`);
      }
    },
    async post(p, body) {
      calls.push(["POST", p, body]);
      switch (p) {
        case "/api/v5/account/set-leverage":
          return [{}];
        case "/api/v5/trade/order": {
          const sl = body.attachAlgoOrds[0].slTriggerPx;
          position = { instId: body.instId, pos: body.side === "buy" ? body.sz : `-${body.sz}`, notionalUsd: "500" };
          algos.push({ instId: body.instId, algoId: "a1", slTriggerPx: sl });
          return [{ ordId: "o1" }];
        }
        case "/api/v5/trade/order-algo":
          algos.push({ instId: body.instId, algoId: `a${algos.length + 1}`, slTriggerPx: body.slTriggerPx });
          return [{ algoId: "new" }];
        case "/api/v5/trade/amend-algos": {
          const a = algos.find((x) => x.algoId === body.algoId);
          a.slTriggerPx = body.newSlTriggerPx;
          return [{}];
        }
        default:
          throw new Error(`unexpected POST ${p}`);
      }
    },
  };
  return api;
}

test("opens a long with an attached stop on the entry candle, once", async () => {
  const lastIndex = fx.ts.indexOf(ENTRY_TS);
  assert.ok(lastIndex > 0);
  const okx = fakeOkx({ lastIndex });

  const dry = await runEmaTrend4hCycle({ okx, dryRun: true });
  assert.equal(dry.trades[0]?.action, "open");
  assert.ok(!okx.calls.some(([m, p]) => m === "POST"), "dry-run must not send orders");

  const r1 = await runEmaTrend4hCycle({ okx });
  const open = r1.trades.find((t) => t.action === "open");
  assert.equal(open.side, "long");
  const order = okx.calls.find(([m, p]) => m === "POST" && p === "/api/v5/trade/order")[2];
  assert.equal(order.side, "buy");
  assert.equal(order.tdMode, "isolated");
  assert.ok(Number(order.attachAlgoOrds[0].slTriggerPx) < open.entry);
  // 2% of 1000 USDT at risk (rounded down to whole lots)
  assert.ok(open.riskUsdt <= 20 && open.riskUsdt > 19);

  // Same candle again: no new order.
  const before = okx.calls.filter(([m]) => m === "POST").length;
  const r2 = await runEmaTrend4hCycle({ okx });
  assert.equal(r2.trades.length, 0);
  assert.equal(okx.calls.filter(([m]) => m === "POST").length, before);

  // Stop order vanished on the exchange: it gets restored.
  okx.algos.length = 0;
  const r3 = await runEmaTrend4hCycle({ okx });
  assert.equal(r3.trades[0].action, "stop-restored");
  const restored = okx.calls.filter(([, p]) => p === "/api/v5/trade/order-algo").at(-1)[2];
  assert.equal(restored.reduceOnly, true);
  assert.equal(restored.side, "sell");
});

test("trails the stop on the next candle and drops positions closed by the exchange", async () => {
  const lastIndex = fx.ts.indexOf(ENTRY_TS);
  fs.rmSync(path.join(process.env.BOT_DATA_DIR, "state.json"), { force: true });
  const okx = fakeOkx({ lastIndex });
  await runEmaTrend4hCycle({ okx });
  const firstStop = Number(okx.algos[0].slTriggerPx);

  // Price rose on the next candles: the stop must move up, never down.
  const next = fakeOkx({ lastIndex: lastIndex + 2 });
  next.position = okx.position;
  next.algos.push(...okx.algos);
  const r = await runEmaTrend4hCycle({ okx: next });
  const moved = r.trades.find((t) => t.action === "stop-moved");
  assert.ok(moved && moved.to > moved.from);
  assert.ok(Number(next.algos[0].slTriggerPx) > firstStop);

  // Exchange stop fired: the position disappears and the bot forgets it.
  next.position = null;
  const later = fakeOkx({ lastIndex: lastIndex + 2 });
  const r2 = await runEmaTrend4hCycle({ okx: later });
  assert.equal(r2.trades[0].action, "closed-by-exchange-stop");
});

test("refuses to run on an account in Spot mode", async () => {
  const okx = fakeOkx({ lastIndex: 500, acctLv: "1" });
  await assert.rejects(runEmaTrend4hCycle({ okx }), /Spot mode/);
  assert.ok(!okx.calls.some(([m]) => m === "POST"));
});

test("hedge (long/short) mode sends posSide on every order", async () => {
  fs.rmSync(path.join(process.env.BOT_DATA_DIR, "state.json"), { force: true });
  const lastIndex = fx.ts.indexOf(ENTRY_TS);
  const okx = fakeOkx({ lastIndex, posMode: "long_short_mode" });
  await runEmaTrend4hCycle({ okx });
  const post = (p) => okx.calls.filter(([m, path]) => m === "POST" && path === p).map((c) => c[2]);
  assert.equal(post("/api/v5/account/set-leverage")[0].posSide, "long");
  const order = post("/api/v5/trade/order")[0];
  assert.equal(order.posSide, "long");
  assert.equal(order.side, "buy");

  okx.algos.length = 0; // force a stop restore
  await runEmaTrend4hCycle({ okx });
  const stop = post("/api/v5/trade/order-algo")[0];
  assert.equal(stop.posSide, "long");
  assert.equal(stop.side, "sell");
  assert.equal(stop.reduceOnly, undefined); // not allowed in hedge mode
});
