import { ema, rsi, macd, atr, adx, recentSwing, sma } from "./indicators.js";

// Active scalping setup per spec: 1H sets the main trend (EMA200 side), 5M
// times entry and sizes SL/TP off ATR(14,5M). Two earlier, stricter
// versions of this strategy went long stretches — and in one manual
// backtest, ~2 trades in a year — without qualifying a single trade, so
// this cuts confirmation requirements down to what the spec asks for:
// trend direction + "not a dead range", nothing more. Every trade still
// gets a real SL and TP attached at entry.
const SL_ATR_MULT = 1.5;
const TP_ATR_MULT = 3;
const MIN_RR_SANITY = 1.2; // floor only to catch degenerate structural clamps, not a target
// Below this ADX(14,1H), price is treated as directionless/ranging and
// skipped outright — the "no operar en rango lateral" rule.
const ADX_RANGEBOUND_MAX = 15;
// A bot position open this long with neither SL nor TP hit and momentum
// gone is a scalp that stopped working — see shouldCloseStale() below.
export const STALE_POSITION_HOURS = 2;

function computeBias(candles) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const { histogram } = macd(closes);
  const { adx: adxLine } = adx(candles, 14);
  const atr14 = atr(candles, 14);
  const volSma20 = sma(volumes, 20);
  const swing = recentSwing(candles, 50);

  const i = closes.length - 1;
  return {
    close: closes[i],
    ema200: ema200[i],
    rsi: rsi14[i],
    macdHist: histogram[i],
    adx: adxLine[i],
    atr: atr14[i],
    volume: volumes[i],
    volSma20: volSma20[i],
    support: swing.support,
    resistance: swing.resistance,
  };
}

// Trend side is decided purely by price vs EMA200 on 1H, per spec — the one
// thing that must hold. ADX below the rangebound floor is the one veto.
// Momentum/volume are read on the entry timeframe instead of gating bias.
function biasDirection(m) {
  if ([m.ema200, m.adx].some((v) => v === undefined)) {
    return { direction: null, reason: "insufficient 1H history for indicators" };
  }

  if (m.adx < ADX_RANGEBOUND_MAX) {
    return {
      direction: null,
      reason: `sideways/rangebound market (ADX ${m.adx.toFixed(1)} < ${ADX_RANGEBOUND_MAX}) — no trade`,
    };
  }

  if (m.close > m.ema200) {
    return { direction: "long", reason: `1H trend up (price above EMA200, ADX ${m.adx.toFixed(1)})` };
  }
  if (m.close < m.ema200) {
    return { direction: "short", reason: `1H trend down (price below EMA200, ADX ${m.adx.toFixed(1)})` };
  }
  return { direction: null, reason: "1H price sitting exactly on EMA200 — no clear trend side" };
}

function computeEntry(candles) {
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

// Fires on any one of: a MACD histogram crossover, a breakout, accelerating
// momentum continuation, an EMA20 retest, a rejection off support/
// resistance, or — the broadest — price simply still trading on the bias
// side of EMA20 with momentum not opposing it. "No esperes una señal
// perfecta": any single one of these is enough, they aren't ANDed together.
function entryTrigger(m, direction) {
  if ([m.ema20, m.rsi, m.macdHist, m.atr, m.volSma20].some((v) => v === undefined)) {
    return { ok: false, reason: "insufficient 5M history for indicators" };
  }
  // "Volumen como confirmación", not a hard spike requirement.
  const volReasonable = m.volSma20 === 0 || m.volume >= m.volSma20 * 0.9;
  const macdCrossUp = m.macdHistPrev !== undefined && m.macdHistPrev <= 0 && m.macdHist > 0;
  const macdCrossDown = m.macdHistPrev !== undefined && m.macdHistPrev >= 0 && m.macdHist < 0;
  const accelUp = m.macdHistPrev !== undefined && m.macdHist > m.macdHistPrev && m.macdHist > 0;
  const accelDown = m.macdHistPrev !== undefined && m.macdHist < m.macdHistPrev && m.macdHist < 0;

  if (direction === "long") {
    const breakout = m.resistance !== undefined && m.close > m.resistance && volReasonable;
    const retest =
      m.close > m.ema20 &&
      m.low <= m.ema20 + 0.5 * m.atr &&
      (m.macdHist > m.macdHistPrev || (m.rsiPrev <= 50 && m.rsi > 50));
    const rejection =
      m.support !== undefined &&
      m.low <= m.support + 0.3 * m.atr &&
      m.close > m.support + 0.3 * m.atr &&
      m.close > m.open;
    const trendAligned = m.close > m.ema20 && m.macdHist >= 0 && volReasonable;
    if (macdCrossUp) return { ok: true, reason: "5M MACD bullish crossover" };
    if (breakout) return { ok: true, reason: "5M breakout above resistance" };
    if (accelUp) return { ok: true, reason: "5M momentum continuation, MACD accelerating up" };
    if (retest) return { ok: true, reason: "5M retest of EMA20/support holding with momentum turning up" };
    if (rejection) return { ok: true, reason: "5M clear rejection off support" };
    if (trendAligned) return { ok: true, reason: "5M price action aligned with bias (above EMA20, momentum not opposing)" };
    return { ok: false, reason: "no valid 5M long trigger" };
  }

  if (direction === "short") {
    const breakdown = m.support !== undefined && m.close < m.support && volReasonable;
    const retest =
      m.close < m.ema20 &&
      m.high >= m.ema20 - 0.5 * m.atr &&
      (m.macdHist < m.macdHistPrev || (m.rsiPrev >= 50 && m.rsi < 50));
    const rejection =
      m.resistance !== undefined &&
      m.high >= m.resistance - 0.3 * m.atr &&
      m.close < m.resistance - 0.3 * m.atr &&
      m.close < m.open;
    const trendAligned = m.close < m.ema20 && m.macdHist <= 0 && volReasonable;
    if (macdCrossDown) return { ok: true, reason: "5M MACD bearish crossover" };
    if (breakdown) return { ok: true, reason: "5M breakdown below support" };
    if (accelDown) return { ok: true, reason: "5M momentum continuation, MACD accelerating down" };
    if (retest) return { ok: true, reason: "5M retest of EMA20/resistance holding with momentum turning down" };
    if (rejection) return { ok: true, reason: "5M clear rejection off resistance" };
    if (trendAligned) return { ok: true, reason: "5M price action aligned with bias (below EMA20, momentum not opposing)" };
    return { ok: false, reason: "no valid 5M short trigger" };
  }

  return { ok: false, reason: "no direction" };
}

// SL/TP come straight off ATR(14,5M) per spec (1.5x / 3x — a fixed ~1:2
// plan, not a floor to hit), with a light structural nudge: tighten the SL
// if a real support/resistance level sits inside the ATR distance, and cap
// the TP at the next 1H structural level if that's closer than the ATR target.
function buildTradePlan(direction, entry, mBias, mEntry) {
  const atrEntry = mEntry.atr;

  let slPrice = direction === "long" ? entry - SL_ATR_MULT * atrEntry : entry + SL_ATR_MULT * atrEntry;
  let tpPrice = direction === "long" ? entry + TP_ATR_MULT * atrEntry : entry - TP_ATR_MULT * atrEntry;
  let slBasisNote = `${SL_ATR_MULT}x ATR(5M)`;
  let tpBasisNote = `${TP_ATR_MULT}x ATR(5M)`;

  if (direction === "long") {
    const support = mEntry.support ?? mBias.support;
    if (support !== undefined && support > slPrice && support < entry - 0.3 * atrEntry) {
      slPrice = support - 0.15 * atrEntry;
      slBasisNote = "structure (5M/1H support), ATR-adjusted";
    }
    const resistance = mBias.resistance;
    if (resistance !== undefined && resistance > entry && resistance < tpPrice) {
      tpPrice = resistance * 0.999;
      tpBasisNote = "next 1H structural resistance (closer than ATR target)";
    }
  } else {
    const resistance = mEntry.resistance ?? mBias.resistance;
    if (resistance !== undefined && resistance < slPrice && resistance > entry + 0.3 * atrEntry) {
      slPrice = resistance + 0.15 * atrEntry;
      slBasisNote = "structure (5M/1H resistance), ATR-adjusted";
    }
    const support = mBias.support;
    if (support !== undefined && support < entry && support > tpPrice) {
      tpPrice = support * 1.001;
      tpBasisNote = "next 1H structural support (closer than ATR target)";
    }
  }

  const slDistance = direction === "long" ? entry - slPrice : slPrice - entry;
  if (!(slDistance > 0)) {
    return { valid: false, reason: "stop-loss distance invalid" };
  }
  const rewardDistance = direction === "long" ? tpPrice - entry : entry - tpPrice;
  if (!(rewardDistance > 0)) {
    return { valid: false, reason: "take-profit distance invalid" };
  }

  const rr = rewardDistance / slDistance;
  if (rr < MIN_RR_SANITY) {
    return { valid: false, reason: `risk/reward ${rr.toFixed(2)} too low after structural adjustment` };
  }

  return { valid: true, entry, sl: slPrice, tp: tpPrice, rr, slBasisNote, tpBasisNote };
}

// Evaluates a single symbol. `candlesBias`/`candlesEntry` are oldest-first
// candle arrays from marketData.getCandles (1H and 5M respectively — see
// runCycle.js). Returns either a valid signal plan or a structured
// rejection reason (never throws for "no trade").
export function evaluateSymbol({ instId, candlesBias, candlesEntry }) {
  if (candlesBias.length < 210 || candlesEntry.length < 30) {
    return { instId, signal: null, reason: "insufficient candle history" };
  }

  const mBias = computeBias(candlesBias);
  const bias = biasDirection(mBias);
  if (!bias.direction) {
    return { instId, signal: null, reason: bias.reason, mBias };
  }

  const mEntry = computeEntry(candlesEntry);
  const trigger = entryTrigger(mEntry, bias.direction);
  if (!trigger.ok) {
    return { instId, signal: null, reason: `1H bias ${bias.direction} (${bias.reason}) but ${trigger.reason}`, mBias, mEntry };
  }

  const entry = mEntry.close;
  const plan = buildTradePlan(bias.direction, entry, mBias, mEntry);
  if (!plan.valid) {
    return { instId, signal: null, reason: plan.reason, mBias, mEntry };
  }

  return {
    instId,
    signal: bias.direction,
    entry: plan.entry,
    sl: plan.sl,
    tp: plan.tp,
    rr: plan.rr,
    reasons: [bias.reason, trigger.reason, `SL basis: ${plan.slBasisNote}`, `TP basis: ${plan.tpBasisNote}`],
    mBias,
    mEntry,
  };
}

// A stale scalp: open past STALE_POSITION_HOURS, hasn't hit SL/TP, and
// momentum on the entry timeframe has faded or flipped against it — MACD
// histogram no longer favors the position's side, or the market has gone
// rangebound (ADX below the floor). Doesn't touch SL/TP levels themselves
// (never move a stop to avoid a loss); this only decides whether to flatten
// early because the setup that justified the trade is gone.
export function shouldCloseStale({ position, nowMs, candlesEntry, candlesBias }) {
  const openedAtMs = new Date(position.openedAt).getTime();
  const ageHours = (nowMs - openedAtMs) / 3_600_000;
  if (!(ageHours >= STALE_POSITION_HOURS)) {
    return { close: false, reason: `position age ${ageHours.toFixed(1)}h < ${STALE_POSITION_HOURS}h` };
  }
  if (candlesEntry.length < 30 || candlesBias.length < 20) {
    return { close: false, reason: "insufficient candle history to judge momentum" };
  }

  const mEntry = computeEntry(candlesEntry);
  const { adx: adxLine } = adx(candlesBias, 14);
  const biasAdx = adxLine[adxLine.length - 1];

  if (mEntry.macdHist === undefined) {
    return { close: false, reason: "insufficient 5M history to judge momentum" };
  }

  const momentumAgainst = position.side === "long" ? mEntry.macdHist < 0 : mEntry.macdHist > 0;
  const gonelRangebound = biasAdx !== undefined && biasAdx < ADX_RANGEBOUND_MAX;

  if (momentumAgainst || gonelRangebound) {
    const why = momentumAgainst
      ? `5M momentum flipped against the ${position.side} (MACD hist ${mEntry.macdHist.toFixed(4)})`
      : `market gone rangebound (1H ADX ${biasAdx.toFixed(1)} < ${ADX_RANGEBOUND_MAX})`;
    return { close: true, reason: `stale position (${ageHours.toFixed(1)}h open), ${why}` };
  }
  return { close: false, reason: `${ageHours.toFixed(1)}h open but momentum still favors the ${position.side}` };
}
