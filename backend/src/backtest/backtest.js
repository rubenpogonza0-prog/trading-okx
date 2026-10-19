// Backtest of the H1 Trend Breakout strategy (src/trading/h1Breakout.js)
// on OKX USDT perpetual swaps, using public 1H history (no API key needed).
//
//   node src/backtest/backtest.js [--from 2023-01-01] [--symbols BTC,ETH]
//
// Signals are read on a closed 1H bar and filled at the next bar's open.
// If a bar touches both the stop and the target, the stop is assumed to be
// hit first. Each trade pays taker fees and slippage on both sides. Results
// are measured in R (multiples of the initial risk) and as a compounded
// equity curve risking RISK_PCT of equity per trade.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ORIGINAL, IMPROVED, computeIndicators, signalAt } from "../trading/h1Breakout.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(here, "../..");
const CACHE_DIR = path.join(BACKEND, "data", "candles");
const OUT_DIR = path.join(BACKEND, "backtest-results");

const FEE = 0.0005; // OKX taker, per side
const SLIPPAGE = 0.0003; // per side
const RISK_PCT = 0.01;
const IS_FRACTION = 0.7; // first 70% of the period is in-sample, rest out-of-sample

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, k, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[k + 1]]);
    return acc;
  }, [])
);
const FROM = Date.parse(args.from ?? "2023-01-01T00:00:00Z");
const SYMBOLS = (args.symbols ?? "BTC,ETH,SOL,XRP,DOGE,BNB,ADA,LINK")
  .split(",")
  .map((s) => `${s.trim()}-USDT-SWAP`);

// Variants: the original spec, each change on its own, and combinations.
const VARIANTS = [
  ORIGINAL,
  { ...ORIGINAL, name: "+adx20", adxMin: 20 },
  { ...ORIGINAL, name: "+htf4h", htfEmaPeriod: 50 },
  { ...ORIGINAL, name: "+ext1atr", maxExtensionAtr: 1.0 },
  { ...ORIGINAL, name: "+vol1.5x", volMult: 1.5 },
  { ...ORIGINAL, name: "no-rsi", rsiLong: [0, 100], rsiShort: [0, 100] },
  { ...ORIGINAL, name: "+be1R", breakevenAtR: 1.0 },
  { ...ORIGINAL, name: "+time48", maxBars: 48 },
  { ...ORIGINAL, name: "trail3atr", tpAtr: null, trailAtr: 3.0, breakevenAtR: 1.0 },
  { ...ORIGINAL, name: "sl2-tp4", slAtr: 2.0, tpAtr: 4.0 },
  { ...ORIGINAL, name: "filters", adxMin: 20, htfEmaPeriod: 50, maxExtensionAtr: 1.0 },
  { ...ORIGINAL, name: "filters+be+time", adxMin: 20, htfEmaPeriod: 50, maxExtensionAtr: 1.0, breakevenAtR: 1.0, maxBars: 48 },
  { ...ORIGINAL, name: "filters+trail", adxMin: 20, htfEmaPeriod: 50, maxExtensionAtr: 1.0, tpAtr: null, trailAtr: 3.0, breakevenAtR: 1.0 },
  { ...ORIGINAL, name: "filters+norsi+trail", adxMin: 20, htfEmaPeriod: 50, maxExtensionAtr: 1.0, rsiLong: [0, 100], rsiShort: [0, 100], tpAtr: null, trailAtr: 3.0, breakevenAtR: 1.0 },
  IMPROVED,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url);
      const body = await res.json();
      if (body.code === "0") return body.data;
      if (body.code === "50011") {
        await sleep(2000);
        continue;
      }
      throw new Error(`${body.code} ${body.msg}`);
    } catch (err) {
      if (attempt === 4) throw err;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

// Oldest-first confirmed 1H candles from FROM until now, cached on disk.
async function loadCandles(instId) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${instId}-1H.json`);
  if (fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, "utf8"));
    if (cached.from <= FROM && Date.now() - cached.fetchedAt < 6 * 3_600_000) return cached.candles;
  }
  const rows = new Map();
  let after = "";
  for (;;) {
    const url = `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=1H&limit=100${after ? `&after=${after}` : ""}`;
    const data = await fetchJson(url);
    if (!data.length) break;
    for (const r of data) if (r[8] === "1") rows.set(r[0], r);
    const oldest = Number(data[data.length - 1][0]);
    if (oldest <= FROM) break;
    after = String(oldest);
    await sleep(110);
  }
  const candles = [...rows.values()]
    .map(([ts, o, h, l, c, vol]) => ({ ts: Number(ts), open: +o, high: +h, low: +l, close: +c, volume: +vol }))
    .filter((c) => c.ts >= FROM - 300 * 3_600_000) // keep warmup bars for EMA200
    .sort((a, b) => a.ts - b.ts);
  fs.writeFileSync(file, JSON.stringify({ from: FROM, fetchedAt: Date.now(), candles }));
  console.log(`  ${instId}: ${candles.length} candles`);
  return candles;
}

function simulate(instId, candles, cfg) {
  const ind = computeIndicators(candles, cfg);
  const trades = [];
  let pos = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (pos) {
      const s = pos.dir;
      let exit = null;
      // Gap through the stop: filled at the open.
      if (s * (c.open - pos.stop) <= 0) exit = { px: c.open, why: "stop" };
      else if (s === 1 ? c.low <= pos.stop : c.high >= pos.stop) exit = { px: pos.stop, why: "stop" };
      else if (pos.tp != null && (s === 1 ? c.high >= pos.tp : c.low <= pos.tp)) exit = { px: pos.tp, why: "tp" };
      else if (cfg.maxBars != null && i - pos.entryIdx + 1 >= cfg.maxBars) exit = { px: c.close, why: "time" };
      if (exit) {
        const gross = (s * (exit.px - pos.entry)) / pos.risk;
        const cost = ((FEE + SLIPPAGE) * (pos.entry + exit.px)) / pos.risk;
        trades.push({
          instId,
          dir: s,
          entryTs: candles[pos.entryIdx].ts,
          exitTs: c.ts,
          bars: i - pos.entryIdx + 1,
          why: exit.why === "stop" && pos.movedStop ? "be/trail" : exit.why,
          r: gross - cost,
        });
        pos = null;
      } else {
        // Manage the stop at bar close for the next bar.
        const best = s === 1 ? c.high : c.low;
        if (cfg.breakevenAtR != null && !pos.movedStop && s * (best - pos.entry) >= cfg.breakevenAtR * pos.risk) {
          pos.stop = pos.entry * (1 + s * 2 * (FEE + SLIPPAGE));
          pos.movedStop = true;
        }
        if (cfg.trailAtr != null && ind.atr[i] !== undefined) {
          const trail = best - s * cfg.trailAtr * ind.atr[i];
          if (s * (trail - pos.stop) > 0 && (cfg.breakevenAtR == null || pos.movedStop)) {
            pos.stop = trail;
            pos.movedStop = true;
          }
        }
      }
    }
    if (pos || i + 1 >= candles.length || c.ts < FROM) continue;
    const sig = signalAt(candles, ind, i, cfg);
    if (!sig.direction) continue;
    const s = sig.direction === "long" ? 1 : -1;
    const entry = candles[i + 1].open; // slippage is charged in the trade cost
    const risk = cfg.slAtr * ind.atr[i];
    pos = {
      dir: s,
      entry,
      risk,
      stop: entry - s * risk,
      tp: cfg.tpAtr != null ? entry + s * cfg.tpAtr * ind.atr[i] : null,
      entryIdx: i + 1,
      movedStop: false,
    };
  }
  return trades;
}

function stats(trades) {
  const n = trades.length;
  if (!n) return { trades: 0 };
  const rs = trades.map((t) => t.r);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const sumW = wins.reduce((a, b) => a + b, 0);
  const sumL = -losses.reduce((a, b) => a + b, 0);
  // Compounded equity in exit-time order, RISK_PCT risked per trade.
  const ordered = [...trades].sort((a, b) => a.exitTs - b.exitTs);
  let eq = 1;
  let peak = 1;
  let maxDd = 0;
  let cumR = 0;
  let peakR = 0;
  let maxDdR = 0;
  for (const t of ordered) {
    eq *= 1 + RISK_PCT * t.r;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, 1 - eq / peak);
    cumR += t.r;
    peakR = Math.max(peakR, cumR);
    maxDdR = Math.max(maxDdR, peakR - cumR);
  }
  const mean = cumR / n;
  const sd = Math.sqrt(rs.reduce((a, r) => a + (r - mean) ** 2, 0) / n);
  return {
    trades: n,
    winRate: wins.length / n,
    profitFactor: sumL ? sumW / sumL : Infinity,
    expectancyR: mean,
    totalR: cumR,
    maxDdR,
    sqn: sd ? (Math.sqrt(Math.min(n, 100)) * mean) / sd : 0,
    returnPct: (eq - 1) * 100,
    maxDdPct: maxDd * 100,
    avgBars: trades.reduce((a, t) => a + t.bars, 0) / n,
  };
}

const fmt = (x, d = 2) => (x === undefined ? "-" : x === Infinity ? "∞" : x.toFixed(d));
function row(name, s) {
  if (!s.trades) return `| ${name} | 0 | - | - | - | - | - | - | - |`;
  return `| ${name} | ${s.trades} | ${fmt(s.winRate * 100, 1)}% | ${fmt(s.profitFactor)} | ${fmt(s.expectancyR, 3)} | ${fmt(s.totalR, 1)} | ${fmt(s.maxDdR, 1)} | ${fmt(s.returnPct, 1)}% | ${fmt(s.maxDdPct, 1)}% |`;
}
const HEADER =
  "| Variante | Trades | Win% | PF | Expect. (R) | Total R | MaxDD (R) | Retorno (1% riesgo) | MaxDD % |\n|---|---|---|---|---|---|---|---|---|";

async function main() {
  console.log(`Downloading 1H candles since ${new Date(FROM).toISOString()}...`);
  const data = {};
  for (const s of SYMBOLS) data[s] = await loadCandles(s);

  const end = Math.max(...Object.values(data).map((c) => c[c.length - 1].ts));
  const split = FROM + IS_FRACTION * (end - FROM);

  const results = {};
  for (const cfg of VARIANTS) {
    const all = SYMBOLS.flatMap((s) => simulate(s, data[s], cfg));
    results[cfg.name] = {
      cfg,
      all: stats(all),
      is: stats(all.filter((t) => t.entryTs < split)),
      oos: stats(all.filter((t) => t.entryTs >= split)),
      bySymbol: Object.fromEntries(SYMBOLS.map((s) => [s, stats(all.filter((t) => t.instId === s))])),
      byYear: Object.fromEntries(
        [...new Set(all.map((t) => new Date(t.entryTs).getUTCFullYear()))].sort().map((y) => [y, stats(all.filter((t) => new Date(t.entryTs).getUTCFullYear() === y))])
      ),
      exits: all.reduce((acc, t) => ((acc[t.why] = (acc[t.why] ?? 0) + 1), acc), {}),
      longs: stats(all.filter((t) => t.dir === 1)),
      shorts: stats(all.filter((t) => t.dir === -1)),
    };
  }

  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  let md = `# Backtest H1 Trend Breakout\n\n`;
  md += `- Periodo: ${iso(FROM)} → ${iso(end)} (in-sample hasta ${iso(split)}, out-of-sample después)\n`;
  md += `- Símbolos: ${SYMBOLS.join(", ")}\n`;
  md += `- Entrada en la apertura de la vela siguiente a la señal; comisión ${FEE * 100}% + slippage ${SLIPPAGE * 100}% por lado; si SL y TP caen en la misma vela, se asume SL.\n`;
  md += `- Retorno compuesto arriesgando ${RISK_PCT * 100}% del capital por operación (posiciones de distintos símbolos pueden solaparse).\n\n`;
  for (const [label, key] of [["Periodo completo", "all"], ["In-sample", "is"], ["Out-of-sample", "oos"]]) {
    md += `## ${label}\n\n${HEADER}\n`;
    for (const name of Object.keys(results)) md += row(name, results[name][key]) + "\n";
    md += "\n";
  }
  for (const name of ["original", "improved"]) {
    const r = results[name];
    md += `## Detalle: ${name}\n\nSalidas: ${JSON.stringify(r.exits)}\n\n${HEADER}\n`;
    md += row("longs", r.longs) + "\n" + row("shorts", r.shorts) + "\n";
    for (const [y, s] of Object.entries(r.byYear)) md += row(String(y), s) + "\n";
    for (const [s, st] of Object.entries(r.bySymbol)) md += row(s, st) + "\n";
    md += "\n";
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "REPORT.md"), md);
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify({ from: FROM, end, split, symbols: SYMBOLS, results }, null, 2));
  console.log(md);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
