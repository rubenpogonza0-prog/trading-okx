// Quick status dump of every tracked grid bot (active and stopped).
// Usage: node src/grid/status.js

import { okxClientFromEnv } from "../okxClient.js";
import { getGridPositions, getGridOrderDetails } from "./gridClient.js";
import { loadGridState } from "./gridState.js";

export async function getStatus({ okx } = {}) {
  const client = okx ?? okxClientFromEnv();
  const state = await loadGridState();
  const bots = [];

  for (const [algoId, bot] of Object.entries(state.bots)) {
    const row = { algoId, ...bot };
    if (bot.status === "active") {
      try {
        const details = await getGridOrderDetails(client, { algoId });
        row.exchangeState = details.state;
        row.floatProfit = details.floatProfit;
        row.totalPnl = details.totalPnl;
      } catch (err) {
        row.error = err.message;
      }
    }
    bots.push(row);
  }
  return bots;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  getStatus()
    .then((bots) => {
      if (bots.length === 0) {
        console.log("No grid bots tracked yet — deploy one with `npm run grid:deploy -- <SYMBOL> <BAR> --live`.");
        return;
      }
      console.log(JSON.stringify(bots, null, 2));
    })
    .catch((err) => {
      console.error("status failed:", err.message);
      process.exitCode = 1;
    });
}
