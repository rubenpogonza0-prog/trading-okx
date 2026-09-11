import "dotenv/config";
import cron from "node-cron";
import { runCycle } from "./runCycle.js";

// Runs the strategy at the top of every hour, matching the spec's
// "hourly execution" requirement. Deploy this with a process manager
// (pm2, systemd, docker) so it stays alive between hourly ticks — it is
// meant to run on infrastructure you control, independent of any chat
// session, since this is placing real orders unattended.
console.log("OKX trading scheduler started — running every hour on the hour (server local time).");

cron.schedule("0 * * * *", async () => {
  console.log(`\n[${new Date().toISOString()}] Running hourly cycle...`);
  try {
    const report = await runCycle();
    console.log(`Cycle complete: ${report.trades.length} trade(s) opened, ${report.skipped.length} symbol(s) skipped.`);
  } catch (err) {
    console.error("Hourly cycle failed:", err);
  }
});

// Run once immediately on startup so you don't wait up to an hour to see it work.
runCycle()
  .then((report) => console.log(`Startup cycle complete: ${report.trades.length} trade(s), ${report.skipped.length} skipped.`))
  .catch((err) => console.error("Startup cycle failed:", err));
