import { ema, rsi, macd, atr, adx, recentSwing, sma } from "./indicators.js";

// Scalping profile: bias on 15m, entry trigger on 5m. Both loosened
// relative to the original 1H/30M swing profile so the bot finds many more
// setups per cycle — the whole point of "mass scalping" — at the cost of
// each individual setup being lower-conviction. Stops/targets are tighter
// (smaller ATR multiples) to match: scalps aim to be in and out fast, not
// ride a multi-hour trend.
const MIN_RR = 1.3;
const PREFERRED_RR = 1.6;
// Below this ADX(14,15m), price is directionless/ranging and skipped
// outright. Lower than the swing profile's 15 — scalps don't need a strong
// trend, just enough directional lean to not be pure noise.
const ADX_RANGEBOUND_MAX = 12;

function compute15m(candles) {
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
  // Short lookback: the nearest pullback level.
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

function bias15m(m) {
  if ([m.ema20, m.ema50, m.rsi, m.macdHist, m.adx, m.atr].some((v) => v === undefined)) {
    return { direction: null, reason: "insufficient 15m history for indicators" };
  }

  // The one hard veto: a genuinely directionless/ranging market.
  if (m.adx < ADX_RANGEBOUND_MAX) {
    return {
      direction: null,
      reason: `sideways/rangebound market (ADX ${m.adx.toFixed(1)} < ${ADX_RANGEBOUND_MAX}) — no trade`,
    };
  }

  const trendUp = m.ema20 > m.ema50 && m.close > m.ema20;
  const trendDown = m.ema20 < m.ema50 && m.close < m.ema20;
  // Loosened vs. the swing profile (was 55/45) — scalps ride weaker momentum.
  const momentumUp = m.macdHist > 0 || m.rsi > 52;
  const momentumDown = m.macdHist < 0 || m.rsi < 48;
  const reversalUp = m.ema50_5ago !== undefined && m.ema50 > m.ema50_5ago && m.close > m.ema50;
  const reversalDown = m.ema50_5ago !== undefined && m.ema50 < m.ema50_5ago && m.close < m.ema50;

  const longSignals = [trendUp, momentumUp, reversalUp].filter(Boolean).length;
  const shortSignals = [trendDown, momentumDown, reversalDown].filter(Boolean).length;

  // Majority vote (2 of 3), not unanimous.
  if (longSignals >= 2 && longSignals > shortSignals) {
    return { direction: "long", reason: `15m bullish bias (${longSignals}/3 signals, ADX ${m.adx.toFixed(1)})` };
  }
  if (shortSignals >= 2 && shortSignals > longSignals) {
    return { direction: "short", reason: `15m bearish bias (${shortSignals}/3 signals, ADX ${m.adx.toFixed(1)})` };
  }
  return { direction: null, reason: "15m signals mixed — no clear directional bias" };
}

function compute5m(candles) {
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

function entryTrigger5m(m, direction) {
  if ([m.ema20, m.rsi, m.macdHist, m.atr, m.volSma20].some((v) => v === undefined)) {
    return { ok: false, reason: "insufficient 5m history for indicators" };
  }
  // Loosened vs. the swing profile's 0.9x — just rule out a dead moment.
  const volReasonable = m.volSma20 === 0 || m.volume >= m.volSma20 * 0.75;
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
    if (breakout) return { ok: true, reason: "5m breakout above resistance" };
    if (continuation) return { ok: true, reason: "5m trend continuation, momentum accelerating" };
    if (retest) return { ok: true, reason: "5m retest of EMA20/support holding with momentum turning up" };
    if (rejection) return { ok: true, reason: "5m clear rejection off support" };
    return { ok: false, reason: "no valid 5m long trigger" };
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
    if (breakdown) return { ok: true, reason: "5m breakdown below support" };
    if (continuation) return { ok: true, reason: "5m trend continuation, momentum accelerating" };
    if (retest) return { ok: true, reason: "5m retest of EMA20/resistance holding with momentum turning down" };
    if (rejection) return { ok: true, reason: "5m clear rejection off resistance" };
    return { ok: false, reason: "no valid 5m short trigger" };
  }

  return { ok: false, reason: "no direction" };
}

function buildTradePlan(direction, entry, m15, m5) {
  const atr15 = m15.atr;
  const atr5 = m5.atr;

  let slPrice, slBasisNote;
  if (direction === "long") {
    const structural = (m5.support ?? m15.support) - 0.2 * atr5;
    // Tighter than the swing profile's 1.5x — scalps use a quick stop.
    const atrBased = entry - 1.0 * atr15;
    slPrice = Math.min(structural, atrBased);
    slBasisNote = structural < atrBased ? "structure (5m support)" : "1.0x ATR(15m)";
  } else {
    const structural = (m5.resistance ?? m15.resistance) + 0.2 * atr5;
    const atrBased = entry + 1.0 * atr15;
    slPrice = Math.max(structural, atrBased);
    slBasisNote = structural > atrBased ? "structure (5m resistance)" : "1.0x ATR(15m)";
  }

  const slDistance = direction === "long" ? entry - slPrice : slPrice - entry;
  // Cap tighter than the swing profile's 4x — a scalp whose stop needs to
  // be this wide isn't a scalp anymore, skip it.
  if (!(slDistance > 0) || slDistance > 2.5 * atr15) {
    return { valid: false, reason: "stop-loss distance invalid or unreasonably wide" };
  }

  const structuralTarget = direction === "long" ? m15.resistance : m15.support;
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

// Evaluates a single symbol. `candles15m`/`candles5m` are oldest-first
// candle arrays from marketData.getCandles. Returns either a valid signal
// plan or a structured rejection reason (never throws for "no trade").
export function evaluateSymbol({ instId, candles15m, candles5m }) {
  if (candles15m.length < 210 || candles5m.length < 40) {
    return { instId, signal: null, reason: "insufficient candle history" };
  }

  const m15 = compute15m(candles15m);
  const bias = bias15m(m15);
  if (!bias.direction) {
    return { instId, signal: null, reason: bias.reason, m15 };
  }

  const m5 = compute5m(candles5m);
  const trigger = entryTrigger5m(m5, bias.direction);
  if (!trigger.ok) {
    return { instId, signal: null, reason: `15m bias ${bias.direction} (${bias.reason}) but ${trigger.reason}`, m15, m5 };
  }

  const entry = m5.close;
  const plan = buildTradePlan(bias.direction, entry, m15, m5);
  if (!plan.valid) {
    return { instId, signal: null, reason: plan.reason, m15, m5 };
  }

  return {
    instId,
    signal: bias.direction,
    entry: plan.entry,
    sl: plan.sl,
    tp: plan.tp,
    rr: plan.rr,
    reasons: [bias.reason, trigger.reason, `SL basis: ${plan.slBasisNote}`],
    m15,
    m5,
  };
}
