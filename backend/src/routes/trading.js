import { Router } from "express";
import { runCycle } from "../trading/runCycle.js";
import { loadState } from "../trading/state.js";
import fs from "node:fs/promises";
import path from "node:path";

const LOG_FILE = path.join(new URL("../../data/", import.meta.url).pathname, "cycles.log");

export function tradingRouter() {
  const router = Router();

  // Current bot-managed positions (source of truth for cooldowns/max-position
  // enforcement) — separate from /api/positions, which reflects the whole account.
  router.get("/state", async (req, res, next) => {
    try {
      res.json(await loadState());
    } catch (err) {
      next(err);
    }
  });

  router.get("/log", async (req, res, next) => {
    try {
      const raw = await fs.readFile(LOG_FILE, "utf8").catch(() => "");
      const lines = raw.trim().split("\n").filter(Boolean).slice(-50).map((l) => JSON.parse(l));
      res.json(lines.reverse());
    } catch (err) {
      next(err);
    }
  });

  // Manual trigger, mainly for testing. Real order placement — the
  // hourly automated run is `npm run trade:scheduler`, not this endpoint.
  router.post("/run-cycle", async (req, res, next) => {
    try {
      const dryRun = req.query.dryRun === "1";
      const report = await runCycle({ dryRun });
      res.json(report);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
