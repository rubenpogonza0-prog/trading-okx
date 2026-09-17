// Grid-bot parameters. All overridable via env so risk posture can be tuned
// without touching code; defaults match the values documented in CLAUDE.md.

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const GRID_ADX_NEUTRAL_MAX = num("GRID_ADX_NEUTRAL_MAX", 20); // ADX below this -> NEUTRAL grid
export const GRID_ADX_TREND_MIN = num("GRID_ADX_TREND_MIN", 25); // ADX at/above this -> directional grid allowed
// Between GRID_ADX_NEUTRAL_MAX and GRID_ADX_TREND_MIN: transitional/weak
// trend, treated as NEUTRAL (see CLAUDE.md) — no directional conviction yet.

export const GRID_MAX_LEVERAGE = Math.min(num("GRID_MAX_LEVERAGE", 3), 3); // hard ceiling, never exceeds 3x regardless of env
export const GRID_MARGIN_USDT = num("GRID_MARGIN_USDT", 20); // investment per grid, in USDT margin

// Grid range width, in multiples of ATR(14) on the analyzed timeframe.
export const GRID_NEUTRAL_SL_ATR_MULT = num("GRID_NEUTRAL_SL_ATR_MULT", 1.5); // buffer beyond BB band before hard stop
export const GRID_NEUTRAL_SL_RATIO = num("GRID_NEUTRAL_SL_RATIO", 0.15); // max loss as a fraction of margin (15%)
export const GRID_TREND_NEAR_ATR_MULT = num("GRID_TREND_NEAR_ATR_MULT", 2); // range extent on the side AGAINST the trend (tighter)
export const GRID_TREND_FAR_ATR_MULT = num("GRID_TREND_FAR_ATR_MULT", 4); // range extent WITH the trend (wider, lets winners run)
export const GRID_TREND_SL_ATR_MULT = num("GRID_TREND_SL_ATR_MULT", 1.5); // hard stop beyond the range, on the against-trend side

// Grid count sizing: number of grid lines so that each cell spans roughly
// GRID_SPACING_ATR_FACTOR * ATR, clamped to [GRID_MIN_COUNT, GRID_MAX_COUNT].
export const GRID_SPACING_ATR_FACTOR = num("GRID_SPACING_ATR_FACTOR", 0.5);
export const GRID_MIN_COUNT = num("GRID_MIN_COUNT", 8);
export const GRID_MAX_COUNT = num("GRID_MAX_COUNT", 50);

// Volatility-scaled leverage: high ATR% -> lower leverage, never above GRID_MAX_LEVERAGE.
export const GRID_ATR_PCT_HIGH = num("GRID_ATR_PCT_HIGH", 5); // atrPct >= this -> leverage 1
export const GRID_ATR_PCT_MED = num("GRID_ATR_PCT_MED", 2); // atrPct >= this -> leverage 2, else GRID_MAX_LEVERAGE
