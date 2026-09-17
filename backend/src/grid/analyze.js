// Technical-analysis CLI: fetches recent candles for an instrument and
// prints a single JSON object (stdout only — logs/warnings go to stderr so
// stdout stays machine-parseable for `planner.js`/`deploy.js` and for any
// external caller that shells out to this script).
//
// Usage: node src/grid/analyze.js <SYMBOL> [BAR] [LIMIT]
//   node src/grid/analyze.js NEAR/USDT 1H
//   node src/grid/analyze.js BTC-USDT-SWAP 4H 300

import { okxClientFromEnv } from "../okxClient.js";
import { getCandles } from "../trading/marketData.js";
import { ema, atr, adx, bollingerBands, stdev } from "../trading/indicators.js";
import { normalizeInstId, normalizeBar } from "./symbols.js";

const MIN_CANDLES = 210; // enough warmup for EMA200

export async function analyzeMarket({ instId, bar = "1H", limit = 300, okx } = {}) {
  const client = okx ?? okxClientFromEnv();
  const resolvedInstId = normalizeInstId(instId);
  const resolvedBar = normalizeBar(bar);

  const candles = await getCandles(client, resolvedInstId, resolvedBar, limit);
  if (candles.length < MIN_CANDLES) {
    throw new Error(
      `insufficient candle history for ${resolvedInstId} on ${resolvedBar} (${candles.length}/${MIN_CANDLES}) — try a lower timeframe or wait for more history`
    );
  }

  const closes = candles.map((c) => c.close);
  const i = closes.length - 1;

  const ema20 = ema(closes, 20)[i];
  const ema50 = ema(closes, 50)[i];
  const ema200 = ema(closes, 200)[i];
  const atr14 = atr(candles, 14)[i];
  const { adx: adxLine, plusDI, minusDI } = adx(candles, 14);
  const adx14 = adxLine[i];
  const bb = bollingerBands(closes, 20, 2);
  const stdev20 = stdev(closes, 20)[i];

  const last = candles[i];
  const price = last.close;
  const atrPct = (atr14 / price) * 100;
  const stdevPct = (stdev20 / price) * 100;
  const bandwidthPct = ((bb.upper[i] - bb.lower[i]) / bb.middle[i]) * 100;

  return {
    instId: resolvedInstId,
    bar: resolvedBar,
    generatedAt: new Date().toISOString(),
    candlesUsed: candles.length,
    price: {
      last: price,
      open: last.open,
      high: last.high,
      low: last.low,
      candleTime: new Date(last.ts).toISOString(),
    },
    trend: {
      ema20,
      ema50,
      ema200,
      priceVsEma200: price > ema200 ? "above" : price < ema200 ? "below" : "on",
    },
    momentum: {
      adx14,
      plusDI: plusDI[i],
      minusDI: minusDI[i],
    },
    volatility: {
      atr14,
      atrPct: Number(atrPct.toFixed(3)),
      stdev20,
      stdevPct: Number(stdevPct.toFixed(3)),
    },
    bollinger: {
      period: 20,
      mult: 2,
      upper: bb.upper[i],
      middle: bb.middle[i],
      lower: bb.lower[i],
      bandwidthPct: Number(bandwidthPct.toFixed(3)),
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [symbolArg, barArg, limitArg] = process.argv.slice(2);
  if (!symbolArg) {
    console.error("Usage: node src/grid/analyze.js <SYMBOL> [BAR] [LIMIT]");
    process.exitCode = 1;
  } else {
    analyzeMarket({ instId: symbolArg, bar: barArg, limit: limitArg ? Number(limitArg) : undefined })
      .then((result) => {
        console.log(JSON.stringify(result, null, 2));
      })
      .catch((err) => {
        console.error("analyze failed:", err.message);
        process.exitCode = 1;
      });
  }
}
