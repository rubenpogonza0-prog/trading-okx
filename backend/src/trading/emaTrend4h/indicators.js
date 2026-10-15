// Indicators for the ema_trend_4h strategy, on an oldest-first array of
// closes. They intentionally differ from ../indicators.js (SMA-seeded):
// these are the recursive forms the strategy was backtested with, seeded on
// the first value, so live signals match the backtest bar for bar.

export function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length);
  let prev;
  for (let i = 0; i < values.length; i++) {
    prev = prev === undefined ? values[0] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder smoothing (alpha = 1/period) of the per-candle close changes.
// Index 0 has no change, so outputs start at index 1.
function wilderOfChanges(closes, period, mapChange) {
  const a = 1 / period;
  const out = new Array(closes.length).fill(undefined);
  let prev;
  for (let i = 1; i < closes.length; i++) {
    const v = mapChange(closes[i] - closes[i - 1]);
    prev = prev === undefined ? v : a * v + (1 - a) * prev;
    out[i] = prev;
  }
  return out;
}

export function rsi(closes, period = 14) {
  const up = wilderOfChanges(closes, period, (d) => Math.max(d, 0));
  const down = wilderOfChanges(closes, period, (d) => Math.max(-d, 0));
  return closes.map((_, i) => {
    if (up[i] === undefined) return undefined;
    if (down[i] === 0) return up[i] === 0 ? 50 : 100;
    return 100 - 100 / (1 + up[i] / down[i]);
  });
}

// "VOL": average absolute close-to-close move. Used instead of a
// high/low ATR because the stop multiples were validated against it.
export function closeVolatility(closes, period = 14) {
  return wilderOfChanges(closes, period, (d) => Math.abs(d));
}
