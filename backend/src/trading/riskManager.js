export const FIXED_MARGIN_USDT = 2;
export const MAX_LEVERAGE = 3;
export const MIN_LEVERAGE = 1;
export const MAX_OPEN_POSITIONS = 5;
// After a stop-loss, require this many closed 1H candles before the same
// instId is eligible again ("do not reopen immediately after a stop loss
// unless a new setup has clearly formed").
export const SL_COOLDOWN_HOURS = 2;

function floorToStep(value, step) {
  if (!step) return value;
  return Math.floor(value / step) * step;
}

// Finds the lowest leverage in [MIN_LEVERAGE, MAX_LEVERAGE] that lets the
// fixed 2 USDT margin meet the instrument's minimum contract size. Returns
// null if even MAX_LEVERAGE can't reach minSz (the symbol simply can't be
// traded with this fixed margin — the trade is skipped, not resized).
export function sizePosition({ instrument, markPrice }) {
  const ctVal = Number(instrument.ctVal);
  const lotSz = Number(instrument.lotSz);
  const minSz = Number(instrument.minSz);

  for (let lever = MIN_LEVERAGE; lever <= MAX_LEVERAGE; lever++) {
    const notional = FIXED_MARGIN_USDT * lever;
    const rawSz = notional / (ctVal * markPrice);
    const sz = floorToStep(rawSz, lotSz);
    if (sz >= minSz && sz > 0) {
      return {
        ok: true,
        leverage: lever,
        size: sz,
        notionalUsdt: sz * ctVal * markPrice,
        marginUsdt: FIXED_MARGIN_USDT,
      };
    }
  }
  return {
    ok: false,
    reason: `2 USDT margin cannot reach minimum contract size (${minSz}) for ${instrument.instId} even at ${MAX_LEVERAGE}x`,
  };
}

// Guards applied before any order is placed. `state` is the persisted bot
// state (see state.js): { positions: { [instId]: {...} }, stopLosses: { [instId]: isoTimestamp } }.
export function checkEntryAllowed({ instId, state, nowMs, candleMs1h = 3_600_000 }) {
  const openCount = Object.keys(state.positions).length;
  if (openCount >= MAX_OPEN_POSITIONS) {
    return { allowed: false, reason: `max ${MAX_OPEN_POSITIONS} simultaneous positions already open` };
  }
  if (state.positions[instId]) {
    return { allowed: false, reason: "position already open on this symbol (no averaging down / pyramiding)" };
  }
  const lastSl = state.stopLosses[instId];
  if (lastSl) {
    const elapsedMs = nowMs - new Date(lastSl).getTime();
    if (elapsedMs < SL_COOLDOWN_HOURS * candleMs1h) {
      return { allowed: false, reason: `cooldown after stop-loss active for ${instId}` };
    }
  }
  return { allowed: true };
}
