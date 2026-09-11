// Thin wrappers around OKX public/market endpoints used by the strategy engine.

export async function getSwapInstruments(okx) {
  return okx.get("/api/v5/public/instruments", { instType: "SWAP" });
}

export async function getSwapTickers(okx) {
  return okx.get("/api/v5/market/tickers", { instType: "SWAP" });
}

// bar: "1H" or "30m". OKX returns candles newest-first; we reverse to oldest-first
// so indicator math can walk forward in time.
export async function getCandles(okx, instId, bar, limit = 300) {
  const raw = await okx.get("/api/v5/market/candles", { instId, bar, limit });
  return raw
    .map(([ts, o, h, l, c, vol, volCcy]) => ({
      ts: Number(ts),
      open: Number(o),
      high: Number(h),
      low: Number(l),
      close: Number(c),
      volume: Number(vol),
      volCcy: Number(volCcy),
    }))
    .reverse();
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
