// Thin wrappers around OKX public/market endpoints used by the strategy engine.

export async function getSwapInstruments(okx) {
  return okx.get("/api/v5/public/instruments", { instType: "SWAP" });
}

export async function getSwapTickers(okx) {
  return okx.get("/api/v5/market/tickers", { instType: "SWAP" });
}

// bar: "1H" or "30m". OKX returns candles newest-first, with the very
// first entry usually being the still-forming current bar (confirm="0").
// We reverse to oldest-first and drop any trailing unconfirmed bar: its
// volume is a partial-period count, not comparable to a full-period
// average (the volume-confirmation checks in strategy.js would otherwise
// almost always fail right after a new bar opens, for reasons that have
// nothing to do with actual market strength).
export async function getCandles(okx, instId, bar, limit = 300) {
  const raw = await okx.get("/api/v5/market/candles", { instId, bar, limit });
  const parsed = raw
    .map(([ts, o, h, l, c, vol, volCcy, , confirm]) => ({
      ts: Number(ts),
      open: Number(o),
      high: Number(h),
      low: Number(l),
      close: Number(c),
      volume: Number(vol),
      volCcy: Number(volCcy),
      confirm,
    }))
    .reverse();
  while (parsed.length && parsed[parsed.length - 1].confirm === "0") {
    parsed.pop();
  }
  return parsed;
}

export async function setLeverage(okx, { instId, lever, mgnMode }) {
  return okx.post("/api/v5/account/set-leverage", {
    instId,
    lever: String(lever),
    mgnMode,
  });
}

export async function getAccountConfig(okx) {
  const [cfg] = await okx.get("/api/v5/account/config");
  return cfg; // includes posMode: "net_mode" | "long_short_mode"
}

export async function getOpenPositions(okx, instType = "SWAP") {
  return okx.get("/api/v5/account/positions", { instType });
}

// Recently closed positions, used to infer whether a position the bot no
// longer sees open was closed by its SL or its TP.
export async function getPositionsHistory(okx, { instType = "SWAP", instId, limit = 10 } = {}) {
  return okx.get("/api/v5/account/positions-history", { instType, instId, limit });
}
