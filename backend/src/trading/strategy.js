import { ema, rsi, macd, atr, adx, recentSwing, sma } from "./indicators.js";

const MIN_RR = 1.5;
const PREFERRED_RR = 2.0;
// Below this ADX(14,1H), price is treated as directionless/ranging and
// skipped outright — the one hard "don't trade" rule the looser prompt
// still asks for. Everything else is evaluated as a majority of signals,
// not a strict AND of all of them.
const ADX_RANGEBOUND_MAX = 15;

function last(arr) {
  return arr[arr.length - 1];
}
function at(arr, i) {
  return arr[arr.length - 1 + i]; // i is negative offset from the end, e.g. -1 = previous
}

function compute1h(candles) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const { histogram } = macd(closes);
  const { adx: adxLine } = adx(candles, 14);
  const atr14 = atr(candles, 14);
  const volSma20 = sma(volumes, 20);
  // Long lookback: broad structural level, used as a take-profit target.
  const swing = recentSwing(candles, 50);
  // Short lookback: the nearest pullback level, used to check price is
  // still "respecting" support/resistance rather than the trend's origin
  // (a 50-candle swing low is always far away deep into a sustained trend).
  const swingNear = recentSwing(candles, 12);

  const i = closes.length - 1;
  return {
    close: closes[i],
    closePrev: closes[i - 1],
    ema20: ema20[i],
    ema50: ema50[i],
    ema50Prev: ema50[i - 1],
    ema50_5ago: ema50[i - 5],
    ema200: ema200[i],
    rsi: rsi14[i],
    macdHist: histogram[i],
    adx: adxLine[i],
    atr: atr14[i],
    volume: volumes[i],
    volSma20: volSma20[i],
    support: swing.support,
    resistance: swing.resistance,
    supportNear: swingNear.support,
    resistanceNear: swingNear.resistance,
  };
}

function bias1h(m) {
  if ([m.ema20, m.ema50, m.rsi, m.macdHist, m.adx, m.atr].some((v) => v === undefined)) {
    return { direction: null, reason: "insufficient 1H history for indicators" };
  }

  // The one hard veto: a genuinely directionless/ranging market. Everything
  // else below is "does price action + momentum lean one way", not a strict
  // checklist every indicator must pass.
  if (m.adx < ADX_RANGEBOUND_MAX) {
    return {
      direction: null,
      reason: `sideways/rangebound market (ADX ${m.adx.toFixed(1)} < ${ADX_RANGEBOUND_MAX}) — no trade`,
    };
  }

  const trendUp = m.ema20 > m.ema50 && m.close > m.ema20;
  const trendDown = m.ema20 < m.ema50 && m.close < m.ema20;
  const momentumUp = m.macdHist > 0 || m.rsi > 55;
  const momentumDown = m.macdHist < 0 || m.rsi < 45;
  // EMA50 itself turning (not just a single-candle poke across it) —
  // catches a reversal already in progress, not only the exact crossover bar.
  const reversalUp = m.ema50_5ago !== undefined && m.ema50 > m.ema50_5ago && m.close > m.ema50;
  const reversalDown = m.ema50_5ago !== undefined && m.ema50 < m.ema50_5ago && m.close < m.ema50;

  const longSignals = [trendUp, momentumUp, reversalUp].filter(Boolean).length;
  const shortSignals = [trendDown, momentumDown, reversalDown].filter(Boolean).length;

  // Majority vote (2 of 3), not unanimous — "no es necesario que todos los
  // indicadores coincidan". Price action/momentum carry the same weight as
  // trend structure rather than requiring EMA stack + ADX + volume all at once.
  if (longSignals >= 2 && longSignals > shortSignals) {
    return { direction: "long", reason: `1H bullish bias (${longSignals}/3 signals, ADX ${m.adx.toFixed(1)})` };
  }
  if (shortSignals >= 2 && shortSignals > longSignals) {
    return { direction: "short", reason: `1H bearish bias (${shortSignals}/3 signals, ADX ${m.adx.toFixed(1)})` };
  }
  return { direction: null, reason: "1H signals mixed — no clear directional bias" };
}

function compute30m(candles) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const ema20 = ema(closes, 20);
  const rsi14 = rsi(closes, 14);
  const { histogram } = macd(closes);
  const atr14 = atr(candles, 14);
  const volSma20 = sma(volumes, 20);
  const swing = recentSwing(candles, 20);

  const i = closes.length - 1;
  return {
    close: closes[i],
    open: candles[i].open,
    high: candles[i].high,
    low: candles[i].low,
    ema20: ema20[i],
    rsi: rsi14[i],
    rsiPrev: rsi14[i - 1],
    macdHist: histogram[i],
    macdHistPrev: histogram[i - 1],
    atr: atr14[i],
    volume: volumes[i],
    volSma20: volSma20[i],
    support: swing.support,
    resistance: swing.resistance,
  };
}

function entryTrigger30m(m, direction) {
  if ([m.ema20, m.rsi, m.macdHist, m.atr, m.volSma20].some((v) => v === undefined)) {
    return { ok: false, reason: "insufficient 30M history for indicators" };
  }
  // "Volumen razonable", not a spike requirement — just rule out a dead/illiquid
  // moment rather than demanding above-average volume on every entry.
  const volReasonable = m.volSma20 === 0 || m.volume >= m.volSma20 * 0.9;
  const accelUp = m.macdHistPrev !== undefined && m.macdHist > m.macdHistPrev && m.macdHist > 0;
  const accelDown = m.macdHistPrev !== undefined && m.macdHist < m.macdHistPrev && m.macdHist < 0;

  if (direction === "long") {
    const breakout = m.resistance !== undefined && m.close > m.resistance && volReasonable;
    const continuation = m.close > m.ema20 && accelUp && volReasonable;
    const retest =
      m.close > m.ema20 &&
      m.low <= m.ema20 + 0.5 * m.atr &&
      (m.macdHist > m.macdHistPrev || (m.rsiPrev <= 50 && m.rsi > 50));
    const rejection =
      m.support !== undefined &&
      m.low <= m.support + 0.3 * m.atr &&
      m.close > m.support + 0.3 * m.atr &&
      m.close > m.open;
    if (breakout) return { ok: true, reason: "30M breakout above resistance" };
    if (continuation) return { ok: true, reason: "30M trend continuation, momentum accelerating" };
    if (retest) return { ok: true, reason: "30M retest of EMA20/support holding with momentum turning up" };
    if (rejection) return { ok: true, reason: "30M clear rejection off support" };
    return { ok: false, reason: "no valid 30M long trigger" };
  }

  if (direction === "short") {
    const breakdown = m.support !== undefined && m.close < m.support && volReasonable;
    const continuation = m.close < m.ema20 && accelDown && volReasonable;
    const retest =
      m.close < m.ema20 &&
      m.high >= m.ema20 - 0.5 * m.atr &&
      (m.macdHist < m.macdHistPrev || (m.rsiPrev >= 50 && m.rsi < 50));
    const rejection =
      m.resistance !== undefined &&
      m.high >= m.resistance - 0.3 * m.atr &&
      m.close < m.resistance - 0.3 * m.atr &&
      m.close < m.open;
    if (breakdown) return { ok: true, reason: "30M breakdown below support" };
    if (continuation) return { ok: true, reason: "30M trend continuation, momentum accelerating" };
    if (retest) return { ok: true, reason: "30M retest of EMA20/resistance holding with momentum turning down" };
    if (rejection) return { ok: true, reason: "30M clear rejection off resistance" };
    return { ok: false, reason: "no valid 30M short trigger" };
  }

  return { ok: false, reason: "no direction" };
}

function buildTradePlan(direction, entry, m1h, m30) {
  const atr1h = m1h.atr;
  const atr30 = m30.atr;

  let slPrice, slBasisNote;
  if (direction === "long") {
    const structural = (m30.support ?? m1h.support) - 0.25 * atr30;
    const atrBased = entry - 1.5 * atr1h;
    slPrice = Math.min(structural, atrBased);
    slBasisNote = structural < atrBased ? "structure (30M support)" : "1.5x ATR(1H)";
  } else {
    const structural = (m30.resistance ?? m1h.resistance) + 0.25 * atr30;
    const atrBased = entry + 1.5 * atr1h;
    slPrice = Math.max(structural, atrBased);
    slBasisNote = structural > atrBased ? "structure (30M resistance)" : "1.5x ATR(1H)";
  }

  const slDistance = direction === "long" ? entry - slPrice : slPrice - entry;
  if (!(slDistance > 0) || slDistance > 4 * atr1h) {
    return { valid: false, reason: "stop-loss distance invalid or unreasonably wide" };
  }

  const structuralTarget = direction === "long" ? m1h.resistance : m1h.support;
  let tpPrice = direction === "long" ? entry + PREFERRED_RR * slDistance : entry - PREFERRED_RR * slDistance;
  if (structuralTarget !== undefined) {
    if (direction === "long" && structuralTarget > entry) {
      tpPrice = Math.min(tpPrice, structuralTarget * 0.999);
    } else if (direction === "short" && structuralTarget < entry) {
      tpPrice = Math.max(tpPrice, structuralTarget * 1.001);
    }
  }

  const rewardDistance = direction === "long" ? tpPrice - entry : entry - tpPrice;
  const rr = rewardDistance / slDistance;
  if (rr < MIN_RR) {
    return { valid: false, reason: `risk/reward ${rr.toFixed(2)} below minimum ${MIN_RR}` };
  }

  return {
    valid: true,
    entry,
    sl: slPrice,
    tp: tpPrice,
    rr,
    slBasisNote,
  };
}

// Evaluates a single symbol. `candles1h`/`candles30m` are oldest-first
// candle arrays from marketData.getCandles. Returns either a valid signal
// plan or a structured rejection reason (never throws for "no trade").
export function evaluateSymbol({ instId, candles1h, candles30m }) {
  if (candles1h.length < 210 || candles30m.length < 40) {
    return { instId, signal: null, reason: "insufficient candle history" };
  }

  const m1h = compute1h(candles1h);
  const bias = bias1h(m1h);
  if (!bias.direction) {
    return { instId, signal: null, reason: bias.reason, m1h };
  }

  const m30 = compute30m(candles30m);
  const trigger = entryTrigger30m(m30, bias.direction);
  if (!trigger.ok) {
    return { instId, signal: null, reason: `1H bias ${bias.direction} (${bias.reason}) but ${trigger.reason}`, m1h, m30 };
  }

  const entry = m30.close;
  const plan = buildTradePlan(bias.direction, entry, m1h, m30);
  if (!plan.valid) {
    return { instId, signal: null, reason: plan.reason, m1h, m30 };
  }

  return {
    instId,
    signal: bias.direction,
    entry: plan.entry,
    sl: plan.sl,
    tp: plan.tp,
    rr: plan.rr,
    reasons: [bias.reason, trigger.reason, `SL basis: ${plan.slBasisNote}`],
    m1h,
    m30,
  };
}
