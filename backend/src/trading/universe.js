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

// OKX also lists USDT-margined perpetuals on tokenized real-world assets —
// commodities (XAU, CL/crude oil), leveraged ETFs (SOXL), even individual
// equities (SPCX, SKHYNIX) — with identical instrument metadata to crypto
// contracts (same ctType/category/settleCcy), so there's no structural
// field to filter them out by. The spec asks for "top 20 cryptocurrencies",
// so candidates are restricted to this allowlist of actual crypto assets
// before ranking by volume, instead of ranking the raw instrument list
// (which let gold/oil/stock perpetuals crowd out real cryptocurrencies).
const CRYPTO_ALLOWLIST = new Set([
  "BTC", "ETH", "XRP", "BNB", "SOL", "DOGE", "ADA", "TRX", "LINK", "AVAX",
  "XLM", "TON", "SHIB", "SUI", "DOT", "LTC", "BCH", "HBAR", "UNI", "NEAR",
  "APT", "ICP", "POL", "MATIC", "FIL", "ETC", "ATOM", "RENDER", "ARB", "OP",
  "INJ", "TIA", "SEI", "IMX", "GRT", "AAVE", "ALGO", "VET", "STX", "MKR",
  "RUNE", "FTM", "THETA", "EGLD", "SAND", "MANA", "AXS", "XTZ", "FLOW",
  "KAVA", "QNT", "CRV", "LDO", "GALA", "CHZ", "EOS", "ZEC", "XMR", "DASH",
  "NEO", "KAS", "WLD", "PEPE", "BONK", "WIF", "JUP", "PYTH", "STRK", "ENA",
  "JTO", "ONDO", "TAO", "FET",
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
    if (!CRYPTO_ALLOWLIST.has(baseCcy)) continue;

    const ticker = tickerById.get(inst.instId);
    if (!ticker) continue;

    const last = Number(ticker.last);
    const bid = Number(ticker.bidPx);
    const ask = Number(ticker.askPx);
    // OKX reports volCcy24h in the CONTRACT's value currency (ctValCcy —
    // the base asset, e.g. BTC/DOGE/SATS), not in USDT, for linear swaps.
    // Multiplying by last price converts it to actual USDT notional volume.
    // Using volCcy24h as-is (as an earlier version of this code did)
    // ranks by raw base-currency volume, which massively overweights
    // low-unit-price tokens (a micro-cap token can show a huge raw token
    // count) and produced a "top 20" dominated by illiquid meme coins.
    const baseVol24h = Number(ticker.volCcy24h);
    if (!last || !bid || !ask || !baseVol24h) continue;

    const quoteVolume24h = baseVol24h * last;
    if (quoteVolume24h < cfg.minQuoteVolume24h) continue;

    const mid = (bid + ask) / 2;
    const spreadPct = ((ask - bid) / mid) * 100;
    if (spreadPct > cfg.maxSpreadPct) continue;

    candidates.push({
      instId: inst.instId,
      baseCcy,
      instrument: inst,
      last,
      volCcy24h: quoteVolume24h,
      spreadPct,
    });
  }

  candidates.sort((a, b) => b.volCcy24h - a.volCcy24h);
  return candidates.slice(0, cfg.topN);
}

export { STABLECOINS };
