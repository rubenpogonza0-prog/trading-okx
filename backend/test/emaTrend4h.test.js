import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ema, rsi, closeVolatility } from "../src/trading/emaTrend4h/indicators.js";
import {
  computeIndicators,
  evaluateBar,
  trailStop,
  initialStop,
  riskNotional,
} from "../src/trading/emaTrend4h/signals.js";
import { simulate } from "../src/trading/emaTrend4h/simulate.js";
import { contractsFor } from "../src/trading/emaTrend4h/live.js";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("ema is seeded on the first value and follows the recursive formula", () => {
  const out = ema([10, 20, 20], 3); // k = 0.5
  close(out[0], 10);
  close(out[1], 15);
  close(out[2], 17.5);
});

test("rsi and volatility use Wilder smoothing of close changes", () => {
  const closes = [10, 11, 10, 12];
  const r = rsi(closes, 2); // alpha 0.5
  assert.equal(r[0], undefined);
  assert.equal(r[1], 100); // only gains so far
  // up: 1 → 0.5 → 1.25 ; down: 0 → 0.5 → 0.25
  close(r[3], 100 - 100 / (1 + 1.25 / 0.25));
  const v = closeVolatility(closes, 2);
  close(v[3], 0.5 * 2 + 0.5 * (0.5 * 1 + 0.5 * 1));
});

function rampThenFlat() {
  // long uptrend, a dip, then a renewed push: should produce a long entry
  const c = [];
  for (let i = 0; i < 150; i++) c.push(100 + i * 0.5);
  for (let i = 0; i < 8; i++) c.push(c.at(-1) - 0.8);
  for (let i = 0; i < 4; i++) c.push(c.at(-1) + 1.2);
  return c;
}

test("long entry needs an EMA cross with rising EMA100 and RSI 50-70", () => {
  const c = rampThenFlat();
  const ind = computeIndicators(c);
  const idx = c.findIndex((_, i) => i > 150 && evaluateBar(ind, i).crossUp);
  assert.ok(idx > 0, "expected a bullish cross after the dip");
  const bar = evaluateBar(ind, idx);
  assert.equal(bar.enterLong, bar.values.rsi > 50 && bar.values.rsi < 70);
  assert.ok(bar.values.emaTrend > bar.values.emaTrendPrev);
  assert.equal(bar.enterShort, false);

  // Same shape mirrored in a falling market must never trigger a long.
  const mirrored = c.map((x) => 400 - x);
  const mind = computeIndicators(mirrored);
  for (let i = 10; i < mirrored.length; i++) assert.equal(evaluateBar(mind, i).enterLong, false);
});

test("short entry sells a failed rebound inside a confirmed downtrend", () => {
  const c = [300];
  for (let i = 1; i < 200; i++) c.push(c.at(-1) + (i % 2 ? 0.9 : -1.5)); // choppy downtrend
  for (let i = 0; i < 2; i++) c.push(c.at(-1) + 3); // sharp rebound pushes RSI above 55
  for (let i = 0; i < 8; i++) c.push(c.at(-1) - 2); // rebound fails
  const ind = computeIndicators(c);
  const hits = c.map((_, i) => (i > 200 ? evaluateBar(ind, i).enterShort : false));
  const idx = hits.indexOf(true);
  assert.ok(idx > 200, "expected a short entry after the rebound");
  const bar = evaluateBar(ind, idx);
  assert.equal(bar.enterLong, false);
  assert.ok(bar.values.rsi < 50 && bar.values.rsiPrev >= 50 && bar.values.rsiReboundPeak > 55);
  assert.ok(bar.close < bar.values.emaTrend && bar.values.emaTrend < bar.values.emaTrendPrev);
});

test("trailing stop never moves against the position", () => {
  close(trailStop("long", 95, 100, 1), 98);
  close(trailStop("long", 98, 97, 1), 98); // price fell: stop stays
  close(trailStop("short", 105, 100, 1), 102);
  close(trailStop("short", 102, 104, 1), 102);
  close(initialStop("long", 100, 1.5), 97);
  close(initialStop("short", 100, 1.5), 103);
});

test("position sizing risks the configured fraction, capped by leverage", () => {
  // 2% risk with a 4% stop → 50% of equity notional
  close(riskNotional({ equity: 1000, entry: 100, stop: 96, riskPerTrade: 0.02, maxLeverage: 2 }), 500);
  // 2% risk with a 0.5% stop would be 4x → capped at 2x
  close(riskNotional({ equity: 1000, entry: 100, stop: 99.5, riskPerTrade: 0.02, maxLeverage: 2 }), 2000);
  const inst = { ctVal: "10", lotSz: "0.1", minSz: "0.1" };
  const s = contractsFor({ notional: 500, price: 5, instrument: inst });
  assert.equal(s.size, 10); // 500 / (10 × 5)
  assert.equal(contractsFor({ notional: 1, price: 5, instrument: inst }).ok, false);
});

test("reproduces the reference NEAR backtest (03/06–14/10/2026)", () => {
  const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/near-4h-closes.json", import.meta.url)));
  const r = simulate(fx, { startIndex: 100 });
  assert.equal(r.trades.length, 12);
  assert.equal(r.longs, 10);
  assert.equal(r.shorts, 2);
  close(r.returnPct, 32.27, 0.01);
  close(r.maxDrawdownPct, -10.63, 0.01);
});
