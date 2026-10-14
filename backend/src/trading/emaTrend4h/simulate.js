// Single-instrument backtest of ema_trend_4h on closed-candle closes.
// Stops are checked on candle closes (the live bot uses an exchange stop
// order, which can fill intrabar — see README).
import {
  computeIndicators,
  evaluateBar,
  firstEvaluableIndex,
  initialStop,
  trailStop,
  stopHit,
  crossExit,
  riskNotional,
} from "./signals.js";
import { SIGNAL_PARAMS } from "./config.js";

export function simulate(
  { ts, close },
  {
    startIndex = 100,
    riskPerTrade = 0.02,
    maxLeverage = 2,
    fee = 0.0005, // taker, per side
    slippage = 0.0005, // per side
    params = SIGNAL_PARAMS,
  } = {}
) {
  const ind = computeIndicators(close, params);
  const start = Math.max(startIndex, firstEvaluableIndex(params));
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let pos = null;
  const trades = [];

  const closePos = (i, px, reason, slip) => {
    const dir = pos.side === "long" ? 1 : -1;
    const exit = px * (1 - slippage * dir * slip);
    const pnl = pos.notional * (exit / pos.entry - 1) * dir - pos.notional * 2 * fee;
    equity += pnl;
    trades.push({ side: pos.side, openTs: pos.ts, closeTs: ts[i], entry: pos.entry, exit, pnl, reason });
    pos = null;
  };

  for (let i = start; i < close.length; i++) {
    const bar = evaluateBar(ind, i, params);

    if (pos) {
      pos.stop = trailStop(pos.side, pos.stop, bar.close, bar.vol, params);
      const hit = stopHit(pos.side, pos.stop, bar.close);
      if (hit || crossExit(pos.side, bar)) closePos(i, bar.close, hit ? "stop" : "cross", 1);
    }

    if (!pos && (bar.enterLong || bar.enterShort)) {
      const side = bar.enterLong ? "long" : "short";
      const dir = side === "long" ? 1 : -1;
      const entry = bar.close * (1 + slippage * dir);
      const stop = initialStop(side, entry, bar.vol, params);
      const notional = riskNotional({ equity, entry, stop, riskPerTrade, maxLeverage });
      pos = { side, entry, stop, notional, ts: ts[i] };
    }

    const dir = pos ? (pos.side === "long" ? 1 : -1) : 0;
    const mtm = equity + (pos ? pos.notional * (bar.close / pos.entry - 1) * dir : 0);
    peak = Math.max(peak, mtm);
    maxDrawdown = Math.min(maxDrawdown, mtm / peak - 1);
  }
  if (pos) closePos(close.length - 1, close[close.length - 1], "open-at-end", 0);

  const wins = trades.filter((t) => t.pnl > 0);
  const lossSum = -trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  return {
    returnPct: (equity - 1) * 100,
    maxDrawdownPct: maxDrawdown * 100,
    trades,
    longs: trades.filter((t) => t.side === "long").length,
    shorts: trades.filter((t) => t.side === "short").length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: lossSum > 0 ? wins.reduce((a, t) => a + t.pnl, 0) / lossSum : Infinity,
    from: ts[start],
    to: ts[ts.length - 1],
  };
}
