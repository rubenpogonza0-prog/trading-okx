// Parameters of the "ema_trend_4h" strategy. The defaults are the exact
// values the strategy was backtested with — change them only after
// re-running `npm run backtest:ema4h` on the new values.

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

export const SIGNAL_PARAMS = Object.freeze({
  bar: "4H",
  fast: 6, // EMA fast
  slow: 21, // EMA slow
  trend: 100, // EMA trend filter
  rsiPeriod: 14,
  volPeriod: 14,
  slopeBars: 6, // EMA100 must be rising/falling vs this many candles ago (24h)
  longRsiMin: 50,
  longRsiMax: 70,
  shortRsiCross: 50, // RSI crosses back below this level...
  shortRsiPeak: 55, // ...after having been above this one...
  shortPeakLookback: 6, // ...within the previous N candles (a rebound that fails)
  stopK: 2.0, // stop distance = stopK × VOL, trailed every candle
});

export function loadRuntimeConfig() {
  const instruments = (process.env.INSTRUMENTS || "auto").trim();
  return {
    // "auto" = top-N liquid cryptocurrencies (see universe.js); otherwise a
    // comma-separated list such as "NEAR-USDT-SWAP,SOL-USDT-SWAP".
    instruments:
      instruments.toLowerCase() === "auto"
        ? "auto"
        : instruments.split(",").map((s) => s.trim()).filter(Boolean),
    universeTopN: num("UNIVERSE_TOP_N", 20),
    riskPerTrade: num("RISK_PER_TRADE", 0.02), // fraction of equity lost if the stop is hit
    maxLeverage: num("MAX_LEVERAGE", 2), // per position, isolated margin
    maxOpenPositions: num("MAX_OPEN_POSITIONS", 3),
    maxTotalExposure: num("MAX_TOTAL_EXPOSURE", 3), // sum of open notionals ≤ this × equity
    candlesToLoad: 600, // EMA100 seeded on the first candle needs a long warm-up
  };
}
