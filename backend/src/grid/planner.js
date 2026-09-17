// Pure grid-bot decision engine. Implements the rules documented in
// CLAUDE.md — this file and CLAUDE.md must be kept in sync; if you change a
// threshold or formula here, update the doc (and vice versa).

import { analyzeMarket } from "./analyze.js";
import {
  GRID_ADX_NEUTRAL_MAX,
  GRID_ADX_TREND_MIN,
  GRID_MAX_LEVERAGE,
  GRID_MARGIN_USDT,
  GRID_NEUTRAL_SL_ATR_MULT,
  GRID_NEUTRAL_SL_RATIO,
  GRID_TREND_NEAR_ATR_MULT,
  GRID_TREND_FAR_ATR_MULT,
  GRID_TREND_SL_ATR_MULT,
  GRID_SPACING_ATR_FACTOR,
  GRID_MIN_COUNT,
  GRID_MAX_COUNT,
  GRID_ATR_PCT_HIGH,
  GRID_ATR_PCT_MED,
} from "./riskConfig.js";

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function gridCountFromRange(lower, upper, atr14) {
  const width = upper - lower;
  const raw = Math.round(width / (GRID_SPACING_ATR_FACTOR * atr14));
  return clamp(raw, GRID_MIN_COUNT, GRID_MAX_COUNT);
}

// Higher volatility -> lower leverage, capped at GRID_MAX_LEVERAGE regardless.
function leverageFromVolatility(atrPct) {
  if (atrPct >= GRID_ATR_PCT_HIGH) return Math.min(1, GRID_MAX_LEVERAGE);
  if (atrPct >= GRID_ATR_PCT_MED) return Math.min(2, GRID_MAX_LEVERAGE);
  return GRID_MAX_LEVERAGE;
}

function round(n, decimals = 6) {
  return Number(n.toFixed(decimals));
}

// `analysis` is the object returned by analyzeMarket(). Returns a decision
// object with mode ("neutral"|"long"|"short"), price range, grid count,
// leverage, margin, and stop-loss configuration — everything needed to call
// the OKX contract-grid API, plus the human-readable reasoning.
export function planGrid(analysis) {
  const { price, trend, momentum, volatility, bollinger } = analysis;
  const last = price.last;
  const atr14 = volatility.atr14;
  const adx14 = momentum.adx14;
  const leverage = leverageFromVolatility(volatility.atrPct);

  // --- ADX < 20: rangebound market -> NEUTRAL grid on Bollinger Bands(20,2) ---
  if (adx14 < GRID_ADX_NEUTRAL_MAX) {
    const lower = bollinger.lower;
    const upper = bollinger.upper;
    const gridNum = gridCountFromRange(lower, upper, atr14);
    return {
      mode: "neutral",
      reason: `ADX(${adx14.toFixed(1)}) < ${GRID_ADX_NEUTRAL_MAX} — rangebound market, no clear trend`,
      range: { lower: round(lower), upper: round(upper) },
      gridNum,
      leverage,
      marginUsdt: GRID_MARGIN_USDT,
      direction: "neutral",
      stopLoss: {
        type: "ratio",
        slRatio: GRID_NEUTRAL_SL_RATIO,
        note: `stop the grid if unrealized loss reaches ${(GRID_NEUTRAL_SL_RATIO * 100).toFixed(0)}% of margin (range breakout risk isn't one-sided in a neutral grid)`,
        // Directional breakout levels, for monitor.js to detect a regime change
        // even before the ratio-based stop fires.
        breakoutLower: round(lower - GRID_NEUTRAL_SL_ATR_MULT * atr14),
        breakoutUpper: round(upper + GRID_NEUTRAL_SL_ATR_MULT * atr14),
      },
      takeProfit: null,
    };
  }

  // --- 20 <= ADX < 25: transitional / weak trend -> treat as NEUTRAL too ---
  // (Neither the LONG nor SHORT condition below is met, and the market isn't
  // decisively rangebound either — defaulting to neutral keeps the bot out
  // of a directional bet the trend strength doesn't yet support.)
  if (adx14 < GRID_ADX_TREND_MIN) {
    const lower = bollinger.lower;
    const upper = bollinger.upper;
    const gridNum = gridCountFromRange(lower, upper, atr14);
    return {
      mode: "neutral",
      reason: `ADX(${adx14.toFixed(1)}) between ${GRID_ADX_NEUTRAL_MAX} and ${GRID_ADX_TREND_MIN} — trend forming but not yet strong enough for a directional grid`,
      range: { lower: round(lower), upper: round(upper) },
      gridNum,
      leverage,
      marginUsdt: GRID_MARGIN_USDT,
      direction: "neutral",
      stopLoss: {
        type: "ratio",
        slRatio: GRID_NEUTRAL_SL_RATIO,
        note: `stop the grid if unrealized loss reaches ${(GRID_NEUTRAL_SL_RATIO * 100).toFixed(0)}% of margin`,
        breakoutLower: round(lower - GRID_NEUTRAL_SL_ATR_MULT * atr14),
        breakoutUpper: round(upper + GRID_NEUTRAL_SL_ATR_MULT * atr14),
      },
      takeProfit: null,
    };
  }

  // --- Price > EMA200 and ADX >= 25: uptrend -> LONG grid ---
  if (last > trend.ema200) {
    const lower = last - GRID_TREND_NEAR_ATR_MULT * atr14; // staggered buys below
    const upper = last + GRID_TREND_FAR_ATR_MULT * atr14; // TP room above, wider with the trend
    const gridNum = gridCountFromRange(lower, upper, atr14);
    const slTriggerPx = lower - GRID_TREND_SL_ATR_MULT * atr14;
    return {
      mode: "long",
      reason: `price ${last} > EMA200 ${round(trend.ema200)} and ADX(${adx14.toFixed(1)}) >= ${GRID_ADX_TREND_MIN} — confirmed uptrend`,
      range: { lower: round(lower), upper: round(upper) },
      gridNum,
      leverage,
      marginUsdt: GRID_MARGIN_USDT,
      direction: "long",
      stopLoss: {
        type: "price",
        slTriggerPx: round(slTriggerPx),
        note: `hard stop if price closes below the grid's lower bound by ${GRID_TREND_SL_ATR_MULT}x ATR — invalidates the uptrend thesis`,
      },
      takeProfit: {
        type: "price",
        tpTriggerPx: round(upper),
        note: "grid liquidates fully if price reaches the upper bound",
      },
    };
  }

  // --- Price < EMA200 and ADX >= 25: downtrend -> SHORT grid ---
  const upper = last + GRID_TREND_NEAR_ATR_MULT * atr14; // staggered sells above
  const lower = last - GRID_TREND_FAR_ATR_MULT * atr14; // TP room below, wider with the trend
  const gridNum = gridCountFromRange(lower, upper, atr14);
  const slTriggerPx = upper + GRID_TREND_SL_ATR_MULT * atr14;
  return {
    mode: "short",
    reason: `price ${last} < EMA200 ${round(trend.ema200)} and ADX(${adx14.toFixed(1)}) >= ${GRID_ADX_TREND_MIN} — confirmed downtrend`,
    range: { lower: round(lower), upper: round(upper) },
    gridNum,
    leverage,
    marginUsdt: GRID_MARGIN_USDT,
    direction: "short",
    stopLoss: {
      type: "price",
      slTriggerPx: round(slTriggerPx),
      note: `hard stop if price closes above the grid's upper bound by ${GRID_TREND_SL_ATR_MULT}x ATR — invalidates the downtrend thesis`,
    },
    takeProfit: {
      type: "price",
      tpTriggerPx: round(lower),
      note: "grid liquidates fully if price reaches the lower bound",
    },
  };
}

export async function analyzeAndPlan(opts) {
  const analysis = await analyzeMarket(opts);
  const plan = planGrid(analysis);
  return { analysis, plan };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [symbolArg, barArg] = process.argv.slice(2);
  if (!symbolArg) {
    console.error("Usage: node src/grid/planner.js <SYMBOL> [BAR]");
    process.exitCode = 1;
  } else {
    analyzeAndPlan({ instId: symbolArg, bar: barArg })
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((err) => {
        console.error("plan failed:", err.message);
        process.exitCode = 1;
      });
  }
}
