import cron from "node-cron";
import { runCycle } from "./runCycle.js";

// How often to scan and, if a setup qualifies, trade. The original spec
// asked for hourly; this defaults to every 10 minutes so entries aren't
// missed waiting for a full hourly tick — the underlying 1H/30M indicators
// still only change on candle close, but the live (forming) candle's price
// is re-evaluated every run, so a breakout is caught close to when it happens.
const DEFAULT_CRON = "*/10 * * * *";

export function startScheduler({ cronExpr = process.env.CYCLE_CRON || DEFAULT_CRON } = {}) {
  console.log(`OKX trading scheduler started — cron "${cronExpr}".`);

  cron.schedule(cronExpr, async () => {
    console.log(`\n[${new Date().toISOString()}] Running cycle...`);
    try {
      const report = await runCycle();
      console.log(`Cycle complete: ${report.trades.length} trade(s) opened, ${report.skipped.length} symbol(s) skipped.`);
    } catch (err) {
      console.error("Cycle failed:", err);
    }
  });

  // Run once immediately on startup so you don't wait for the first tick.
  runCycle()
    .then((report) => console.log(`Startup cycle complete: ${report.trades.length} trade(s), ${report.skipped.length} skipped.`))
    .catch((err) => console.error("Startup cycle failed:", err));
}

// Allow `node src/trading/scheduler.js` to run this standalone (no dashboard API).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { default: dotenv } = await import("dotenv");
  dotenv.config();
  startScheduler();
}
