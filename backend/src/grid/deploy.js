// End-to-end grid deployment CLI: analyze -> decide -> place the order.
//
// Usage:
//   node src/grid/deploy.js <SYMBOL> [BAR]              # dry-run (default) — prints the plan, places nothing
//   node src/grid/deploy.js <SYMBOL> [BAR] --live        # places a REAL order (real money unless OKX_DEMO=1)
//
// Safety: dry-run is the default specifically so this can never place an
// order by accident (e.g. a copy-pasted command missing a flag). --live is
// required, explicitly, to touch the exchange.

import { okxClientFromEnv } from "../okxClient.js";
import { analyzeAndPlan } from "./planner.js";
import { createContractGrid } from "./gridClient.js";
import { loadGridState, saveGridState, appendGridLog } from "./gridState.js";
import { GRID_MAX_LEVERAGE } from "./riskConfig.js";

export async function deployGrid({ instId, bar, live = false, okx } = {}) {
  const client = okx ?? okxClientFromEnv();
  const { analysis, plan } = await analyzeAndPlan({ instId, bar, okx: client });

  // Belt-and-suspenders: never let a bad env override slip leverage above 3x.
  if (plan.leverage > GRID_MAX_LEVERAGE) plan.leverage = GRID_MAX_LEVERAGE;

  const report = {
    instId: analysis.instId,
    bar: analysis.bar,
    demo: process.env.OKX_DEMO === "1",
    live,
    analysis,
    plan,
  };

  if (!live) {
    report.placed = false;
    await appendGridLog({ action: "dry-run", ...report });
    return report;
  }

  const orderParams = {
    instId: analysis.instId,
    lower: plan.range.lower,
    upper: plan.range.upper,
    gridNum: plan.gridNum,
    direction: plan.direction,
    leverage: plan.leverage,
    marginUsdt: plan.marginUsdt,
    basePos: plan.direction !== "neutral",
    algoClOrdId: `grid${Date.now()}`.slice(0, 32),
  };
  if (plan.stopLoss.type === "price") orderParams.slTriggerPx = plan.stopLoss.slTriggerPx;
  if (plan.stopLoss.type === "ratio") orderParams.slRatio = plan.stopLoss.slRatio;
  if (plan.takeProfit) orderParams.tpTriggerPx = plan.takeProfit.tpTriggerPx;

  const result = await createContractGrid(client, orderParams);

  report.placed = true;
  report.algoId = result.algoId;
  report.orderParams = orderParams;

  const state = await loadGridState();
  state.bots[result.algoId] = {
    instId: analysis.instId,
    bar: analysis.bar,
    mode: plan.mode,
    direction: plan.direction,
    range: plan.range,
    gridNum: plan.gridNum,
    leverage: plan.leverage,
    marginUsdt: plan.marginUsdt,
    stopLoss: plan.stopLoss,
    takeProfit: plan.takeProfit,
    deployedAt: new Date().toISOString(),
    status: "active",
  };
  await saveGridState(state);
  await appendGridLog({ action: "deploy", ...report });

  return report;
}

function printReport(report) {
  const { analysis, plan } = report;
  console.log(`\n${analysis.instId} (${analysis.bar}) — ${report.demo ? "DEMO" : "LIVE ACCOUNT"}`);
  console.log(`  Price: ${analysis.price.last}  ADX: ${analysis.momentum.adx14.toFixed(1)}  ATR%: ${analysis.volatility.atrPct}`);
  console.log(`\nDecision: GRID ${plan.mode.toUpperCase()}`);
  console.log(`  Reason: ${plan.reason}`);
  console.log(`  Range: ${plan.range.lower} - ${plan.range.upper}`);
  console.log(`  Grid count: ${plan.gridNum}`);
  console.log(`  Leverage: ${plan.leverage}x`);
  console.log(`  Margin: ${plan.marginUsdt} USDT`);
  console.log(`  Stop loss: ${JSON.stringify(plan.stopLoss)}`);
  if (plan.takeProfit) console.log(`  Take profit: ${JSON.stringify(plan.takeProfit)}`);
  if (!report.placed) {
    console.log("\n(DRY RUN — no order placed. Re-run with --live to deploy for real.)");
  } else {
    console.log(`\nORDER PLACED — algoId: ${report.algoId}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const positional = args.filter((a) => !a.startsWith("--"));
  const [symbolArg, barArg] = positional;
  if (!symbolArg) {
    console.error("Usage: node src/grid/deploy.js <SYMBOL> [BAR] [--live]");
    process.exitCode = 1;
  } else {
    deployGrid({ instId: symbolArg, bar: barArg, live })
      .then(printReport)
      .catch((err) => {
        console.error("deploy failed:", err.message);
        process.exitCode = 1;
      });
  }
}
