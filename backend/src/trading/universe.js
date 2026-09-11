import { getSwapInstruments, getSwapTickers } from "./marketData.js";

const STABLECOINS = new Set([
  "USDT",
  "USDC",
  "DAI",
  "TUSD",
  "FDUSD",
  "USDD",
  "USDP",
  "PYUSD",
  "GUSD",
  "EURT",
  "USDE",
]);

const DEFAULTS = {
  topN: 20,
  minQuoteVolume24h: 5_000_000, // USDT — liquidity floor
  maxSpreadPct: 0.15, // percent of mid price — abnormal-spread guard
};

// Selects the tradeable universe: live USDT-margined perpetual swaps,
// excluding stablecoin bases, filtered for liquidity/spread, ranked by
// 24h quote volume as a market-cap proxy (OKX has no market-cap field),
// capped at `topN`.
export async function selectUniverse(okx, overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  const [instruments, tickers] = await Promise.all([
    getSwapInstruments(okx),
    getSwapTickers(okx),
  ]);

  const instrumentById = new Map(instruments.map((i) => [i.instId, i]));
  const tickerById = new Map(tickers.map((t) => [t.instId, t]));

  const candidates = [];
  for (const inst of instruments) {
    if (inst.state !== "live") continue;
    if (!inst.instId.endsWith("-USDT-SWAP")) continue;
    const baseCcy = inst.ctValCcy || inst.instId.split("-")[0];
    if (STABLECOINS.has(baseCcy)) continue;

    const ticker = tickerById.get(inst.instId);
    if (!ticker) continue;

    const last = Number(ticker.last);
    const bid = Number(ticker.bidPx);
    const ask = Number(ticker.askPx);
    const volCcy24h = Number(ticker.volCcy24h);
    if (!last || !bid || !ask || !volCcy24h) continue;

    if (volCcy24h < cfg.minQuoteVolume24h) continue;

    const mid = (bid + ask) / 2;
    const spreadPct = ((ask - bid) / mid) * 100;
    if (spreadPct > cfg.maxSpreadPct) continue;

    candidates.push({
      instId: inst.instId,
      baseCcy,
      instrument: inst,
      last,
      volCcy24h,
      spreadPct,
    });
  }

  candidates.sort((a, b) => b.volCcy24h - a.volCcy24h);
  return candidates.slice(0, cfg.topN);
}

export { STABLECOINS };
