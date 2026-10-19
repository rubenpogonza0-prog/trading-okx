import { ema, rsi, atr, adx, sma } from "./indicators.js";

// "H1 Trend Breakout": trade a close beyond the prior N-bar range, in the
// direction of the 1H EMA200 trend, with volume and RSI confirmation.
// Everything is config-driven so the backtester (src/backtest/) can run the
// original spec and the improved variant side by side on the same code.

// The spec as originally written: fixed 1.5 ATR stop / 3 ATR target.
export const ORIGINAL = {
  name: "original",
  emaPeriod: 200,
  breakoutLookback: 20,
  volSmaPeriod: 20,
  volMult: 1.0,
  rsiPeriod: 14,
  rsiLong: [50, 68],
  rsiShort: [32, 50],
  atrPeriod: 14,
  slAtr: 1.5,
  tpAtr: 3.0,
  // Optional filters/exits, all off in the original spec.
  adxMin: null,
  htfEmaPeriod: null,
  maxExtensionAtr: null,
  breakevenAtR: null,
  trailAtr: null,
  maxBars: null,
};

// Improved variant: the best in-sample result of the backtest in
// backend/backtest-results/ (2023-2026, 8 majors). Breakout of 50 bars
// instead of 20, 4H EMA50 agreement, a 3 ATR stop (so fees+slippage are a
// smaller share of the risk) and a 4 ATR trailing stop instead of a fixed
// target. It roughly breaks even after costs; it is NOT a proven edge:
// out-of-sample it came out slightly negative.
export const IMPROVED = {
  ...ORIGINAL,
  name: "improved",
  breakoutLookback: 50,
  htfEmaPeriod: 50,
  slAtr: 3.0,
  tpAtr: null,
  trailAtr: 4.0,
};

// Oldest-first candles -> indicator arrays aligned to the input.
export function computeIndicators(candles, cfg) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const n = cfg.breakoutLookback;
  const prevHigh = new Array(candles.length).fill(undefined);
  const prevLow = new Array(candles.length).fill(undefined);
  for (let i = n; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - n; j < i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    prevHigh[i] = hi;
    prevLow[i] = lo;
  }
  return {
    ema: ema(closes, cfg.emaPeriod),
    rsi: rsi(closes, cfg.rsiPeriod),
    atr: atr(candles, cfg.atrPeriod),
    adx: cfg.adxMin != null ? adx(candles, 14).adx : null,
    volSma: sma(volumes, cfg.volSmaPeriod),
    htf: cfg.htfEmaPeriod != null ? htfTrend(candles, cfg.htfEmaPeriod) : null,
    prevHigh,
    prevLow,
  };
}

// 4H trend per 1H bar, using only 4H bars that have fully closed by the end
// of that 1H bar (no lookahead): +1 if the 4H close is above a rising 4H
// EMA, -1 if below a falling one, 0 otherwise.
function htfTrend(candles, period) {
  const FOUR_H = 4 * 3_600_000;
  const buckets = [];
  for (const c of candles) {
    const start = Math.floor(c.ts / FOUR_H) * FOUR_H;
    const last = buckets[buckets.length - 1];
    if (!last || last.start !== start) buckets.push({ start, close: c.close, count: 1 });
    else {
      last.close = c.close;
      last.count++;
    }
  }
  const htfEma = ema(buckets.map((b) => b.close), period);
  const state = buckets.map((b, k) => {
    if (htfEma[k] === undefined || htfEma[k - 1] === undefined) return 0;
    if (b.close > htfEma[k] && htfEma[k] > htfEma[k - 1]) return 1;
    if (b.close < htfEma[k] && htfEma[k] < htfEma[k - 1]) return -1;
    return 0;
  });
  const out = new Array(candles.length).fill(0);
  let k = -1;
  for (let i = 0; i < candles.length; i++) {
    const start = Math.floor(candles[i].ts / FOUR_H) * FOUR_H;
    while (k + 1 < buckets.length && buckets[k + 1].start <= start) k++;
    // The 1H bar closing a 4H bucket (the 4th hour) completes it; earlier
    // hours only see the previous finished bucket.
    const closesBucket = candles[i].ts + 3_600_000 === start + FOUR_H;
    const idx = closesBucket ? k : k - 1;
    out[i] = idx >= 0 ? state[idx] : 0;
  }
  return out;
}

// Rule check on closed bar i. Returns { direction: "long"|"short"|null, reasons }.
export function signalAt(candles, ind, i, cfg) {
  const c = candles[i];
  const e = ind.ema[i];
  const r = ind.rsi[i];
  const a = ind.atr[i];
  const v = ind.volSma[i];
  const hi = ind.prevHigh[i];
  const lo = ind.prevLow[i];
  if ([e, r, a, v, hi, lo].some((x) => x === undefined)) {
    return { direction: null, reasons: ["historial insuficiente para los indicadores"] };
  }

  const fails = [];
  let direction = null;
  if (c.close > e && c.close > hi) direction = "long";
  else if (c.close < e && c.close < lo) direction = "short";
  else {
    if (c.close > e) fails.push(`tendencia alcista pero sin ruptura del máximo de ${cfg.breakoutLookback} velas (${hi})`);
    else if (c.close < e) fails.push(`tendencia bajista pero sin ruptura del mínimo de ${cfg.breakoutLookback} velas (${lo})`);
    else fails.push("precio sobre la EMA200, sin tendencia");
    return { direction: null, reasons: fails };
  }

  if (!(c.volume > v * cfg.volMult)) fails.push(`volumen ${c.volume} no supera ${cfg.volMult}x la media (${v.toFixed(2)})`);

  const [rMin, rMax] = direction === "long" ? cfg.rsiLong : cfg.rsiShort;
  if (!(r >= rMin && r <= rMax)) fails.push(`RSI ${r.toFixed(1)} fuera de [${rMin}, ${rMax}]`);

  if (cfg.adxMin != null) {
    const x = ind.adx[i];
    if (!(x >= cfg.adxMin)) fails.push(`ADX ${x?.toFixed(1)} < ${cfg.adxMin} (mercado sin fuerza)`);
  }
  if (cfg.htfEmaPeriod != null) {
    const want = direction === "long" ? 1 : -1;
    if (ind.htf[i] !== want) fails.push("la tendencia de 4H no acompaña");
  }
  if (cfg.maxExtensionAtr != null) {
    const ext = direction === "long" ? c.close - hi : lo - c.close;
    if (ext > cfg.maxExtensionAtr * a) fails.push(`cierre ${(ext / a).toFixed(2)} ATR más allá del nivel (sobreextendido)`);
  }

  if (fails.length) return { direction: null, candidate: direction, reasons: fails };
  return {
    direction,
    reasons: [
      direction === "long"
        ? `cierre > EMA${cfg.emaPeriod} y ruptura del máximo de ${cfg.breakoutLookback} velas`
        : `cierre < EMA${cfg.emaPeriod} y ruptura del mínimo de ${cfg.breakoutLookback} velas`,
      `volumen > ${cfg.volMult}x SMA${cfg.volSmaPeriod}`,
      `RSI ${r.toFixed(1)} en rango`,
    ],
  };
}

export function buildPlan(direction, entry, atrValue, cfg) {
  const s = direction === "long" ? 1 : -1;
  const stopLoss = entry - s * cfg.slAtr * atrValue;
  const takeProfit = cfg.tpAtr != null ? entry + s * cfg.tpAtr * atrValue : null;
  return {
    entry,
    stopLoss,
    takeProfit,
    rr: cfg.tpAtr != null ? cfg.tpAtr / cfg.slAtr : null,
  };
}

// Decision for the last closed candle, in the JSON shape of the original
// prompt spec.
export function evaluateLatest(symbol, candles, cfg = IMPROVED) {
  const ind = computeIndicators(candles, cfg);
  const i = candles.length - 1;
  const sig = signalAt(candles, ind, i, cfg);
  const round = (x) => (x == null ? 0 : Number(x.toPrecision(8)));
  if (!sig.direction) {
    return {
      symbol,
      decision: "NEUTRAL",
      execute: false,
      confidence_score: sig.candidate ? 35 : 10,
      entry_price: round(candles[i].close),
      stop_loss: 0,
      take_profit: 0,
      risk_reward_ratio: 0,
      reason: `Sin entrada: ${sig.reasons.join("; ")}.`,
    };
  }
  const plan = buildPlan(sig.direction, candles[i].close, ind.atr[i], cfg);
  return {
    symbol,
    decision: sig.direction === "long" ? "BUY" : "SELL",
    execute: true,
    confidence_score: 75,
    entry_price: round(plan.entry),
    stop_loss: round(plan.stopLoss),
    take_profit: round(plan.takeProfit),
    risk_reward_ratio: plan.rr ?? 0,
    reason:
      `Todas las reglas se cumplen: ${sig.reasons.join("; ")}.` +
      (cfg.trailAtr != null ? ` Sin TP fijo: trailing stop a ${cfg.trailAtr} ATR del extremo favorable.` : ""),
  };
}
