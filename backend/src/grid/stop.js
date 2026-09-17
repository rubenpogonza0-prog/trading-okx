// Manual stop for a single grid bot.
// Usage: node src/grid/stop.js <algoId> <instId> [--keep-position]

import { okxClientFromEnv } from "../okxClient.js";
import { stopGrid } from "./gridClient.js";
import { loadGridState, saveGridState, appendGridLog } from "./gridState.js";

export async function stopOne({ algoId, instId, keepPosition = false, okx } = {}) {
  const client = okx ?? okxClientFromEnv();
  const result = await stopGrid(client, { algoId, instId, stopType: keepPosition ? "2" : "1" });

  const state = await loadGridState();
  if (state.bots[algoId]) {
    state.bots[algoId].status = "stopped";
    state.bots[algoId].stoppedAt = new Date().toISOString();
    state.bots[algoId].stopReason = "manual stop";
    await saveGridState(state);
  }
  await appendGridLog({ action: "manual-stop", algoId, instId, keepPosition, result });
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const keepPosition = args.includes("--keep-position");
  const [algoId, instId] = args.filter((a) => !a.startsWith("--"));
  if (!algoId || !instId) {
    console.error("Usage: node src/grid/stop.js <algoId> <instId> [--keep-position]");
    process.exitCode = 1;
  } else {
    stopOne({ algoId, instId, keepPosition })
      .then((r) => console.log(JSON.stringify(r, null, 2)))
      .catch((err) => {
        console.error("stop failed:", err.message);
        process.exitCode = 1;
      });
  }
}
