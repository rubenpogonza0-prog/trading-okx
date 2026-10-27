// Backtest of an EMA fast/slow crossover filtered by RSI, on OKX candles.
//
//   Long  when EMA(fast) crosses above EMA(slow) and RSI > rsiLong
//   Short when EMA(fast) crosses below EMA(slow) and RSI < rsiShort
//   Exit  on the opposite crossover (flipping to the other side if that
//         crossover also passes its RSI filter, otherwise going flat).
//
// Entries/exits fill at the close of the signal candle, with a taker fee
// charged on each side. No leverage, no SL/TP: it measures the raw edge of
// the signal. Also runs the same crossover without the RSI filter so you
// can see what the filter adds.
//
// Usage (from backend/):
//   node src/trading/backtestEmaRsi.js --inst BTC-USDT-SWAP --bar 1H --days 365
//   node src/trading/backtestEmaRsi.js --file candles.csv   # lines: ts,close
//
// Options: --fast 6 --slow 21 --rsi 14 --rsi-long 50 --rsi-short 50
//          --fee 0.0005 (per side) --no-short
import fs from "node:fs";
import fetch from "node-fetch";
import { ema, rsi } from "./indicators.js";

const BAR_MS = {
  "5m": 3e5, "15m": 9e5, "30m": 18e5, "1H": 36e5, "2H": 72e5,
  "4H": 144e5, "6H": 216e5, "12H": 432e5, "1D": 864e5,
};

function parseArgs(argv) {
  const args = {
    inst: "BTC-USDT-SWAP", bar: "1H", days: 365, file: undefined,
    fast: 6, slow: 21, rsi: 14, rsiLong: 50, rsiShort: 50, fee: 0.0005, short: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (key === "no-short") { args.short = false; continue; }
    const val = argv[++i];
    const camel = key.replace(/-(\w)/g, (_, c) => c.toUpperCase());
    args[camel] = ["inst", "bar", "file"].includes(camel) ? val : Number(val);
  }
  return args;
}

// Public endpoint, no API key needed. history-candles pages backwards 100 at a time.
async function fetchCandles(instId, bar, days) {
  const since = Date.now() - days * 864e5;
  const out = new Map();
  let after;
  for (;;) {
    const qs = new URLSearchParams({ instId, bar, limit: "100", ...(after && { after }) });
    const res = await fetch(`https://www.okx.com/api/v5/market/history-candles?${qs}`);
    const json = await res.json();
    if (json.code !== "0") throw new Error(`OKX error ${json.code}: ${json.msg}`);
    if (!json.data.length) break;
    for (const [ts, , , , c, , , , confirm] of json.data) {
      if (confirm === "1") out.set(Number(ts), Number(c));
    }
    after = json.data[json.data.length - 1][0];
    if (Number(after) <= since) break;
    await new Promise((r) => setTimeout(r, 120)); // stay under the 20 req/2s limit
  }
  return [...out].filter(([ts]) => ts >= since).sort((a, b) => a[0] - b[0])
    .map(([ts, close]) => ({ ts, close }));
}

function readCsv(path) {
  return fs.readFileSync(path, "utf8").trim().split(/\r?\n/)
    .map((line) => line.split(","))
    .filter(([ts]) => /^\d+$/.test(ts))
    .map(([ts, close]) => ({ ts: Number(ts), close: Number(close) }))
    .sort((a, b) => a.ts - b.ts);
}

export function backtest(candles, opts) {
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, opts.fast);
  const slow = ema(closes, opts.slow);
  const r = rsi(closes, opts.rsi);
  const trades = [];
  let pos = null; // { side, entry, entryTs }
  let equity = 1;
  let peak = 1;
  let maxDd = 0;

  const close = (i) => {
    const gross = pos.side === "long" ? closes[i] / pos.entry - 1 : pos.entry / closes[i] - 1;
    const net = (1 + gross) * (1 - opts.fee) ** 2 - 1;
    equity *= 1 + net;
    trades.push({ ...pos, exit: closes[i], exitTs: candles[i].ts, ret: net });
    pos = null;
  };

  for (let i = 1; i < closes.length; i++) {
    if ([fast[i - 1], slow[i - 1], r[i]].some((v) => v === undefined)) continue;
    const crossUp = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
    const crossDown = fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];

    if (pos?.side === "long" && crossDown) close(i);
    if (pos?.side === "short" && crossUp) close(i);

    if (!pos && crossUp && r[i] > opts.rsiLong) {
      pos = { side: "long", entry: closes[i], entryTs: candles[i].ts };
    } else if (!pos && opts.short && crossDown && r[i] < opts.rsiShort) {
      pos = { side: "short", entry: closes[i], entryTs: candles[i].ts };
    }

    // mark-to-market drawdown on the equity curve
    let mtm = equity;
    if (pos) {
      const g = pos.side === "long" ? closes[i] / pos.entry - 1 : pos.entry / closes[i] - 1;
      mtm = equity * (1 + g) * (1 - opts.fee);
    }
    peak = Math.max(peak, mtm);
    maxDd = Math.max(maxDd, 1 - mtm / peak);
  }
  if (pos) close(closes.length - 1);

  const wins = trades.filter((t) => t.ret > 0);
  const losses = trades.filter((t) => t.ret <= 0);
  const sum = (a) => a.reduce((s, t) => s + t.ret, 0);
  return {
    trades,
    totalReturn: equity - 1,
    buyHold: closes[closes.length - 1] / closes[0] - 1,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgWin: wins.length ? sum(wins) / wins.length : 0,
    avgLoss: losses.length ? sum(losses) / losses.length : 0,
    profitFactor: losses.length ? sum(wins) / -sum(losses) : Infinity,
    maxDrawdown: maxDd,
  };
}

const pct = (x) => `${(x * 100).toFixed(2)}%`;
const day = (ts) => new Date(ts).toISOString().slice(0, 16).replace("T", " ");

function report(label, res) {
  const longs = res.trades.filter((t) => t.side === "long").length;
  console.log(`\n== ${label} ==`);
  console.log(`trades ${res.trades.length} (${longs} long / ${res.trades.length - longs} short)`);
  console.log(`total return ${pct(res.totalReturn)}  | buy & hold ${pct(res.buyHold)}`);
  console.log(`win rate ${pct(res.winRate)}  | avg win ${pct(res.avgWin)}  | avg loss ${pct(res.avgLoss)}`);
  console.log(`profit factor ${res.profitFactor.toFixed(2)}  | max drawdown ${pct(res.maxDrawdown)}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const candles = opts.file ? readCsv(opts.file) : await fetchCandles(opts.inst, opts.bar, opts.days);
  if (candles.length < opts.slow + opts.rsi) throw new Error(`only ${candles.length} candles`);
  console.log(
    `${opts.file ?? `${opts.inst} ${opts.bar}`}: ${candles.length} candles, ` +
      `${day(candles[0].ts)} -> ${day(candles[candles.length - 1].ts)} UTC`
  );
  console.log(`EMA ${opts.fast}/${opts.slow}, RSI(${opts.rsi}) long>${opts.rsiLong} short<${opts.rsiShort}, fee ${pct(opts.fee)}/side`);

  const withRsi = backtest(candles, opts);
  report("EMA cross + RSI filter", withRsi);
  report("EMA cross only (no RSI filter)", backtest(candles, { ...opts, rsiLong: -1, rsiShort: 101 }));

  console.log("\nlast trades (EMA + RSI):");
  for (const t of withRsi.trades.slice(-10)) {
    console.log(`  ${t.side.padEnd(5)} ${day(t.entryTs)} @ ${t.entry} -> ${day(t.exitTs)} @ ${t.exit}  ${pct(t.ret)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
