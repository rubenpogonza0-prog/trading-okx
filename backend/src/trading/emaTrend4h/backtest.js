// Backtest of ema_trend_4h on OKX public data (no API key needed).
//
//   npm run backtest:ema4h                         # top-20 liquid cryptos, last 180 days
//   npm run backtest:ema4h -- --inst NEAR-USDT-SWAP,SOL-USDT-SWAP --days 365
//   npm run backtest:ema4h -- --trades             # also list every trade
//
// Uses the same signal functions as the live bot (signals.js).
import { createPublicClient } from "../../okxClient.js";
import { selectUniverse } from "../universe.js";
import { fetchClosedCandles } from "./candles.js";
import { simulate } from "./simulate.js";
import { loadRuntimeConfig } from "./config.js";

const WARMUP = 300; // candles before the test window, so EMA100 is settled
const BARS_PER_DAY = 6;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const pct = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`.padStart(8);
const day = (ts) => new Date(ts).toISOString().slice(0, 10);

async function main() {
  const okx = createPublicClient();
  const cfg = loadRuntimeConfig();
  const days = Number(arg("days", 180));
  const listTrades = process.argv.includes("--trades");
  const instArg = arg("inst", process.env.INSTRUMENTS || "auto");
  const instIds =
    instArg.toLowerCase() === "auto"
      ? (await selectUniverse(okx, { topN: Number(arg("top", cfg.universeTopN)) })).map((c) => c.instId)
      : instArg.split(",").map((s) => s.trim());

  console.log(
    `ema_trend_4h backtest — ${days} days, risk ${cfg.riskPerTrade * 100}%/trade, max ${cfg.maxLeverage}x, ` +
      `fees+slippage 0.1%/side, each coin simulated on its own\n`
  );
  console.log(`${"Instrument".padEnd(18)} ${"Return".padStart(8)} ${"MaxDD".padStart(8)} ${"B&H".padStart(8)}  Trades (L/S)  Win%    PF   Period`);

  const results = [];
  for (const instId of instIds) {
    try {
      const candles = await fetchClosedCandles(okx, instId, "4H", days * BARS_PER_DAY + WARMUP);
      const startIndex = Math.max(WARMUP, candles.length - days * BARS_PER_DAY);
      if (candles.length < startIndex + 50) {
        console.log(`${instId.padEnd(18)} not enough history (${candles.length} candles)`);
        continue;
      }
      const r = simulate(
        { ts: candles.map((c) => c.ts), close: candles.map((c) => c.close) },
        { startIndex, riskPerTrade: cfg.riskPerTrade, maxLeverage: cfg.maxLeverage }
      );
      const bh = (candles.at(-1).close / candles[startIndex].close - 1) * 100;
      results.push({ instId, ...r, bh });
      console.log(
        `${instId.padEnd(18)} ${pct(r.returnPct)} ${pct(r.maxDrawdownPct)} ${pct(bh)}  ${String(r.trades.length).padStart(4)} (${r.longs}/${r.shorts})`.padEnd(64) +
          ` ${r.winRatePct.toFixed(0).padStart(3)}% ${Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2).padStart(5) : "  inf"}   ${day(r.from)} → ${day(r.to)}`
      );
      if (listTrades) {
        for (const t of r.trades) {
          console.log(`     ${t.side.padEnd(5)} ${day(t.openTs)} → ${day(t.closeTs)}  ${pct(t.pnl * 100)} of equity (${t.reason})`);
        }
      }
    } catch (err) {
      console.log(`${instId.padEnd(18)} error: ${err.message}`);
    }
  }

  if (results.length > 1) {
    const avg = (k) => results.reduce((a, r) => a + r[k], 0) / results.length;
    const winners = results.filter((r) => r.returnPct > 0).length;
    console.log(
      `\nAverage over ${results.length} coins: return ${pct(avg("returnPct"))}, max drawdown ${pct(avg("maxDrawdownPct"))}, ` +
        `buy & hold ${pct(avg("bh"))}. Profitable on ${winners}/${results.length} coins.`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
