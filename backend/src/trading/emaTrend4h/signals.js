// Pure signal logic shared by the live bot and the backtester, so both
// make exactly the same decisions on the same candles.
import { ema, rsi, closeVolatility } from "./indicators.js";
import { SIGNAL_PARAMS } from "./config.js";

export function computeIndicators(closes, p = SIGNAL_PARAMS) {
  return {
    close: closes,
    fast: ema(closes, p.fast),
    slow: ema(closes, p.slow),
    trend: ema(closes, p.trend),
    rsi: rsi(closes, p.rsiPeriod),
    vol: closeVolatility(closes, p.volPeriod),
  };
}

// Minimum index at which every lookback used by evaluateBar is defined.
export function firstEvaluableIndex(p = SIGNAL_PARAMS) {
  return Math.max(p.slopeBars, p.shortPeakLookback) + 1;
}

// Decision inputs for candle `i` (a closed candle).
export function evaluateBar(ind, i, p = SIGNAL_PARAMS) {
  const { close, fast, slow, trend, rsi: r, vol } = ind;
  const px = close[i];
  const crossUp = fast[i] > slow[i] && fast[i - 1] <= slow[i - 1];
  const crossDown = fast[i] < slow[i] && fast[i - 1] >= slow[i - 1];

  const trendRising = trend[i] > trend[i - p.slopeBars];
  const enterLong =
    crossUp && r[i] > p.longRsiMin && r[i] < p.longRsiMax && px > trend[i] && trendRising;

  const confirmedDowntrend =
    px < trend[i] && slow[i] < trend[i] && trend[i] < trend[i - p.slopeBars];
  let reboundPeak = -Infinity;
  for (let j = i - p.shortPeakLookback; j < i; j++) reboundPeak = Math.max(reboundPeak, r[j]);
  const enterShort =
    confirmedDowntrend &&
    r[i] < p.shortRsiCross &&
    r[i - 1] >= p.shortRsiCross &&
    reboundPeak > p.shortRsiPeak &&
    fast[i] < slow[i];

  return {
    close: px,
    vol: vol[i],
    crossUp,
    crossDown,
    enterLong,
    enterShort,
    values: {
      emaFast: fast[i],
      emaSlow: slow[i],
      emaTrend: trend[i],
      emaTrendPrev: trend[i - p.slopeBars],
      rsi: r[i],
      rsiPrev: r[i - 1],
      rsiReboundPeak: reboundPeak,
      vol: vol[i],
    },
  };
}

export function initialStop(side, entry, vol, p = SIGNAL_PARAMS) {
  return side === "long" ? entry - p.stopK * vol : entry + p.stopK * vol;
}

// Trailing stop: only ever moves in the trade's favour.
export function trailStop(side, currentStop, close, vol, p = SIGNAL_PARAMS) {
  return side === "long"
    ? Math.max(currentStop, close - p.stopK * vol)
    : Math.min(currentStop, close + p.stopK * vol);
}

export function stopHit(side, stop, close) {
  return side === "long" ? close <= stop : close >= stop;
}

// Exit on the opposite EMA cross.
export function crossExit(side, bar) {
  return side === "long" ? bar.crossDown : bar.crossUp;
}

// Position notional (in quote currency) so that hitting the stop loses
// `riskPerTrade` of equity, capped by per-position leverage.
export function riskNotional({ equity, entry, stop, riskPerTrade, maxLeverage }) {
  const stopFrac = Math.abs(entry - stop) / entry;
  if (!(stopFrac > 0)) return 0;
  return Math.min((equity * riskPerTrade) / stopFrac, equity * maxLeverage);
}
