// Watches every grid bot this system deployed (backend/data/grid-state.json)
// and decides, per cycle, whether to leave it running or stop it.
//
// Two independent triggers to stop a bot:
//   1. HARD STOP-LOSS breach (capital protection) — always acted on
//      immediately when --adjust is passed, regardless of current PnL. This
//      is what "Stop Loss estricto" means: it is not negotiable.
//   2. REGIME CHANGE (market conditions no longer match the mode the grid
//      was deployed under) — only acted on if the bot is currently in
//      profit. A regime change while the bot is underwater is NOT a reason
//      to crystallize the loss by itself; it keeps running (still protected
//      by its own hard stop-loss) until either it recovers into profit and
//      gets closed on the next regime check, or the hard stop fires. This is
//      the best-effort version of "always exit in profit": it is a
//      preference the monitor optimizes for, never a guarantee — a hard
//      stop-loss can still realize a loss, because protecting capital always
//      wins over waiting for a specific outcome.
//
// Usage:
//   node src/grid/monitor.js                 # report only, changes nothing
//   node src/grid/monitor.js --adjust         # stops bots per the rules above
//   node src/grid/monitor.js --adjust --redeploy  # also redeploys (live) into the new regime after a regime-triggered stop

import { okxClientFromEnv } from "../okxClient.js";
import { analyzeAndPlan } from "./planner.js";
import { getGridOrderDetails, getGridPositions, stopGrid } from "./gridClient.js";
import { loadGridState, saveGridState, appendGridLog } from "./gridState.js";
import { deployGrid } from "./deploy.js";

function hardStopBreached(bot, analysis) {
  const price = analysis.price.last;
  const sl = bot.stopLoss;
  if (sl.type === "price") {
    if (bot.direction === "long") return price <= sl.slTriggerPx;
    if (bot.direction === "short") return price >= sl.slTriggerPx;
  }
  if (sl.type === "ratio") {
    // Directional breakout check as an early warning; the ratio-based stop
    // itself is enforced by OKX on slRatio at order time, but a manual
    // breakout check here lets us react a cycle earlier than the exchange's
    // own PnL-ratio evaluation, and covers accounts where slRatio isn't
    // supported on this instrument.
    return price <= sl.breakoutLower || price >= sl.breakoutUpper;
  }
  return false;
}

export async function monitorGrids({ adjust = false, redeploy = false, okx } = {}) {
  const client = okx ?? okxClientFromEnv();
  const state = await loadGridState();
  const report = { checkedAt: new Date().toISOString(), bots: [] };

  for (const [algoId, bot] of Object.entries(state.bots)) {
    if (bot.status !== "active") continue;
    const entry = { algoId, instId: bot.instId, mode: bot.mode, action: "hold" };

    let details;
    try {
      details = await getGridOrderDetails(client, { algoId });
    } catch (err) {
      entry.action = "error";
      entry.error = `could not fetch order details: ${err.message}`;
      report.bots.push(entry);
      continue;
    }

    if (details.state !== "running") {
      // Already stopped/liquidated on the exchange (SL/TP fired, or someone
      // stopped it manually) — reconcile local state and move on.
      entry.action = "reconciled";
      entry.exchangeState = details.state;
      bot.status = "stopped";
      bot.stoppedAt = new Date().toISOString();
      bot.stopReason = `exchange reports state=${details.state}`;
      report.bots.push(entry);
      continue;
    }

    let positions;
    try {
      positions = await getGridPositions(client, { algoId });
    } catch (err) {
      entry.action = "error";
      entry.error = `could not fetch positions: ${err.message}`;
      report.bots.push(entry);
      continue;
    }
    const uPnl = positions.reduce((sum, p) => sum + Number(p.upl || 0), 0);
    entry.uPnl = uPnl;

    let analysis, plan;
    try {
      ({ analysis, plan } = await analyzeAndPlan({ instId: bot.instId, bar: bot.bar, okx: client }));
    } catch (err) {
      entry.action = "error";
      entry.error = `re-analysis failed: ${err.message}`;
      report.bots.push(entry);
      continue;
    }
    entry.currentPrice = analysis.price.last;
    entry.recommendedMode = plan.mode;

    const hardStop = hardStopBreached(bot, analysis);
    const regimeChanged = plan.mode !== bot.mode;

    if (hardStop) {
      entry.action = "stop";
      entry.stopReason = "hard stop-loss breached — capital protection overrides everything else";
    } else if (regimeChanged && uPnl > 0) {
      entry.action = "stop";
      entry.stopReason = `regime changed (${bot.mode} -> ${plan.mode}) while in profit (uPnl ${uPnl}) — locking in gains`;
    } else if (regimeChanged && uPnl <= 0) {
      entry.action = "hold";
      entry.note = `regime changed (${bot.mode} -> ${plan.mode}) but position is underwater (uPnl ${uPnl}) — holding, protected by hard stop-loss, not crystallizing a loss on a regime read alone`;
    } else {
      entry.note = "regime unchanged";
    }

    if (adjust && entry.action === "stop") {
      try {
        await stopGrid(client, { algoId, instId: bot.instId, stopType: "1" });
        bot.status = "stopped";
        bot.stoppedAt = new Date().toISOString();
        bot.stopReason = entry.stopReason;
        entry.stopped = true;

        if (redeploy && !hardStop) {
          // Only auto-redeploy on a profit-lock regime change, never right
          // after a hard stop-loss (that's a signal to pause and reassess,
          // not immediately re-enter).
          const redeployResult = await deployGrid({ instId: bot.instId, bar: bot.bar, live: true, okx: client });
          entry.redeployed = { algoId: redeployResult.algoId, mode: redeployResult.plan.mode };
        }
      } catch (err) {
        entry.action = "stop-failed";
        entry.error = err.message;
      }
    }

    report.bots.push(entry);
  }

  await saveGridState(state);
  await appendGridLog({ action: "monitor", adjust, redeploy, ...report });
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const adjust = args.includes("--adjust");
  const redeploy = args.includes("--redeploy");
  monitorGrids({ adjust, redeploy })
    .then((report) => {
      if (report.bots.length === 0) {
        console.log("No active grid bots tracked in grid-state.json.");
        return;
      }
      for (const b of report.bots) {
        console.log(`\n${b.instId} (${b.algoId}) — action: ${b.action}`);
        if (b.uPnl !== undefined) console.log(`  uPnL: ${b.uPnl}`);
        if (b.recommendedMode) console.log(`  mode: ${b.mode} -> recommended: ${b.recommendedMode}`);
        if (b.stopReason) console.log(`  ${b.stopReason}`);
        if (b.note) console.log(`  ${b.note}`);
        if (b.error) console.log(`  ERROR: ${b.error}`);
      }
    })
    .catch((err) => {
      console.error("monitor failed:", err.message);
      process.exitCode = 1;
    });
}
