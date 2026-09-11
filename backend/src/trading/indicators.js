// Standard technical indicators operating on oldest-first candle arrays
// ({ open, high, low, close, volume }). Each function returns an array
// aligned to the input (shorter by the indicator's warmup period, padded
// with undefined at the front) unless noted otherwise.

export function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(undefined);
  let prev;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === undefined) {
      // seed with SMA of the first `period` values
      prev = values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(undefined);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) {
        out[i] = rsiFromAvg(avgGain, avgLoss);
      }
      continue;
    }
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFromAvg(avgGain, avgLoss);
  }
  return out;
}

function rsiFromAvg(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] !== undefined && emaSlow[i] !== undefined ? emaFast[i] - emaSlow[i] : undefined
  );
  const macdValues = macdLine.filter((v) => v !== undefined);
  const signalRaw = ema(macdValues, signalPeriod);
  const signalLine = new Array(closes.length).fill(undefined);
  let j = 0;
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] === undefined) continue;
    signalLine[i] = signalRaw[j];
    j++;
  }
  const histogram = closes.map((_, i) =>
    macdLine[i] !== undefined && signalLine[i] !== undefined ? macdLine[i] - signalLine[i] : undefined
  );
  return { macdLine, signalLine, histogram };
}

export function atr(candles, period = 14) {
  const trueRanges = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  return wilderSmooth(trueRanges, period);
}

function wilderSmooth(values, period) {
  const out = new Array(values.length).fill(undefined);
  let prev;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === undefined) {
      prev = values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
    } else {
      prev = (prev * (period - 1) + values[i]) / period;
    }
    out[i] = prev;
  }
  return out;
}

export function adx(candles, period = 14) {
  const plusDM = [0];
  const minusDM = [0];
  const tr = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      )
    );
  }
  const smTR = wilderSmooth(tr, period);
  const smPlusDM = wilderSmooth(plusDM, period);
  const smMinusDM = wilderSmooth(minusDM, period);

  const plusDI = candles.map((_, i) =>
    smTR[i] ? (100 * smPlusDM[i]) / smTR[i] : undefined
  );
  const minusDI = candles.map((_, i) =>
    smTR[i] ? (100 * smMinusDM[i]) / smTR[i] : undefined
  );
  const dx = candles.map((_, i) => {
    if (plusDI[i] === undefined || minusDI[i] === undefined) return undefined;
    const sum = plusDI[i] + minusDI[i];
    return sum === 0 ? 0 : (100 * Math.abs(plusDI[i] - minusDI[i])) / sum;
  });
  const dxValues = dx.filter((v) => v !== undefined);
  const adxRaw = wilderSmooth(dxValues, period);
  const adxLine = new Array(candles.length).fill(undefined);
  let j = 0;
  for (let i = 0; i < candles.length; i++) {
    if (dx[i] === undefined) continue;
    adxLine[i] = adxRaw[j];
    j++;
  }
  return { adx: adxLine, plusDI, minusDI };
}

// Recent swing high/low as a simple support/resistance proxy: the extreme
// close-adjacent high/low over the trailing `lookback` candles, excluding
// the current (still-forming) one.
export function recentSwing(candles, lookback = 50) {
  const slice = candles.slice(-lookback - 1, -1);
  if (slice.length === 0) return { resistance: undefined, support: undefined };
  return {
    resistance: Math.max(...slice.map((c) => c.high)),
    support: Math.min(...slice.map((c) => c.low)),
  };
}

export function sma(values, period) {
  const out = new Array(values.length).fill(undefined);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out[i] = sum / period;
  }
  return out;
}
