import cron from "node-cron";
import { runCycle } from "./runCycle.js";

// How often to scan and, if a setup qualifies, trade — every 10 minutes per
// spec for an active scalping cadence. Only meaningful for an always-on
// deployment (Railway/VPS); GitHub Actions' own scheduler can't reliably
// go this fast (see .github/workflows/trade-cycle.yml).
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
