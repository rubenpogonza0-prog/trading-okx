import { okxClientFromEnv } from "../okxClient.js";
import { getCandles, getOpenPositions, getPositionsHistory } from "./marketData.js";
import { selectUniverse } from "./universe.js";
import { evaluateSymbol } from "./strategy.js";
import { sizePosition, checkEntryAllowed, MAX_OPEN_POSITIONS } from "./riskManager.js";
import { executeTrade } from "./execution.js";
import { checkNews } from "./newsFilter.js";
import { loadState, saveState, appendCycleLog } from "./state.js";

// Reconciles local state against OKX's actual live positions — the source
// of truth. This matters even more when `backend/data/state.json` isn't
// guaranteed to survive between runs (e.g. a stateless CI runner): without
// it, a position OKX already holds but that this process doesn't remember
// opening would be invisible to the max-open-positions and
// no-duplicate-instrument checks, defeating those risk limits.
async function reconcileClosedPositions(okx, state) {
  const live = await getOpenPositions(okx);
  const liveByInstId = new Map(
    live.filter((p) => Number(p.pos) !== 0).map((p) => [p.instId, p])
  );

  for (const instId of Object.keys(state.positions)) {
    if (liveByInstId.has(instId)) continue;

    const tracked = state.positions[instId];
    let hitSl = null;
    try {
      const history = await getPositionsHistory(okx, { instId, limit: 1 });
      const closed = history[0];
      if (closed) {
        const closePx = Number(closed.closeAvgPx);
        const slDist = Math.abs(closePx - tracked.sl);
        const tpDist = Math.abs(closePx - tracked.tp);
        hitSl = slDist < tpDist; // best-effort inference — see state.js note
      }
    } catch {
      hitSl = null; // unable to determine; skip cooldown rather than guess
    }

    if (hitSl) {
      state.stopLosses[instId] = new Date().toISOString();
    }
    delete state.positions[instId];
  }

  // Adopt any live position this process has no record of (SL/TP unknown —
  // it was either opened before state existed, or state was lost). It still
  // counts toward max-open-positions and blocks re-entry on that symbol;
  // it just won't get an SL-cooldown when it eventually closes, since we
  // don't know its stop level to compare against.
  for (const [instId, pos] of liveByInstId) {
    if (state.positions[instId]) continue;
    state.positions[instId] = {
      side: Number(pos.pos) > 0 ? "long" : "short",
      entry: Number(pos.avgPx),
      sl: null,
      tp: null,
      size: Number(pos.pos),
      leverage: Number(pos.lever),
      openedAt: pos.cTime ? new Date(Number(pos.cTime)).toISOString() : new Date().toISOString(),
      adopted: true,
    };
  }

  return state;
}

export async function runCycle({ dryRun = false } = {}) {
  const okx = okxClientFromEnv();
  const now = Date.now();
  const report = { startedAt: new Date(now).toISOString(), trades: [], skipped: [], noTrade: false };

  let state = await loadState();
  state = await reconcileClosedPositions(okx, state);

  const universe = await selectUniverse(okx);

  for (const candidate of universe) {
    const { instId, instrument, last: markPrice } = candidate;

    const allowed = checkEntryAllowed({ instId, state, nowMs: now });
    if (!allowed.allowed) {
      report.skipped.push({ instId, reason: allowed.reason });
      continue;
    }

    let candles1h, candles30m;
    try {
      [candles1h, candles30m] = await Promise.all([
        getCandles(okx, instId, "1H", 300),
        getCandles(okx, instId, "30m", 100),
      ]);
    } catch (err) {
      report.skipped.push({ instId, reason: `candle fetch failed: ${err.message}` });
      continue;
    }

    const evaluation = evaluateSymbol({ instId, candles1h, candles30m });
    if (!evaluation.signal) {
      report.skipped.push({ instId, reason: evaluation.reason });
      continue;
    }

    const news = await checkNews({ instId });
    if (news.blocked) {
      report.skipped.push({ instId, reason: `news filter: ${news.note}` });
      continue;
    }

    const sizing = sizePosition({ instrument, markPrice: evaluation.entry });
    if (!sizing.ok) {
      report.skipped.push({ instId, reason: sizing.reason });
      continue;
    }

    if (Object.keys(state.positions).length >= MAX_OPEN_POSITIONS) {
      report.skipped.push({ instId, reason: `max ${MAX_OPEN_POSITIONS} simultaneous positions already open` });
      continue;
    }

    const tradeRecord = {
      instId,
      side: evaluation.signal.toUpperCase(),
      entry: evaluation.entry,
      sl: evaluation.sl,
      tp: evaluation.tp,
      leverage: sizing.leverage,
      marginUsdt: sizing.marginUsdt,
      sizeContracts: sizing.size,
      rr: Number(evaluation.rr.toFixed(2)),
      reasons: evaluation.reasons,
      news: news.note,
    };

    if (dryRun) {
      tradeRecord.dryRun = true;
      report.trades.push(tradeRecord);
      continue;
    }

    try {
      const exec = await executeTrade(okx, {
        instId,
        plan: evaluation,
        sizing,
        instrument,
      });
      tradeRecord.orderId = exec.orderId;
      state.positions[instId] = {
        side: evaluation.signal,
        entry: evaluation.entry,
        sl: evaluation.sl,
        tp: evaluation.tp,
        size: sizing.size,
        leverage: sizing.leverage,
        openedAt: new Date(now).toISOString(),
        orderId: exec.orderId,
      };
      report.trades.push(tradeRecord);
    } catch (err) {
      report.skipped.push({ instId, reason: `execution failed: ${err.message}` });
    }
  }

  report.noTrade = report.trades.length === 0;
  await saveState(state);
  await appendCycleLog(report);
  return report;
}

function printReport(report) {
  if (report.trades.length === 0) {
    console.log("NO TRADE — No setup currently meets the required criteria.");
  } else {
    for (const t of report.trades) {
      console.log(`\n${t.instId} — ${t.side}${t.dryRun ? " (dry-run)" : ""}`);
      console.log(`  Entry: ${t.entry}`);
      console.log(`  Stop Loss: ${t.sl}`);
      console.log(`  Take Profit: ${t.tp}`);
      console.log(`  Leverage: ${t.leverage}x`);
      console.log(`  Margin: ${t.marginUsdt} USDT`);
      console.log(`  Risk/Reward: 1:${t.rr}`);
      console.log(`  Reasons: ${t.reasons.join("; ")}`);
      console.log(`  News/fundamental context: ${t.news}`);
    }
  }
  if (report.skipped.length) {
    console.log(`\n(${report.skipped.length} symbols skipped — see cycles.log for reasons)`);
  }
}

// Allow `node src/trading/runCycle.js [--dry-run]` for manual/cron invocation.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes("--dry-run");
  runCycle({ dryRun })
    .then(printReport)
    .catch((err) => {
      console.error("Cycle failed:", err);
      process.exitCode = 1;
    });
}
