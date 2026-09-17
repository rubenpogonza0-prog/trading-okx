// Normalizes loose user input ("NEAR/USDT", "near-usdt", "NEARUSDT") into
// OKX's USDT-margined perpetual swap instId format ("NEAR-USDT-SWAP"), and
// loose bar input ("1h", "4H", "1d") into OKX's bar format ("1H", "4H", "1D").

export function normalizeInstId(input) {
  if (!input) throw new Error("instrument symbol is required");
  let s = input.trim().toUpperCase();
  if (s.endsWith("-SWAP")) return s;
  s = s.replace(/[\s_]/g, "-").replace(/\//g, "-");
  if (!s.includes("-")) {
    // "NEARUSDT" -> "NEAR-USDT"
    if (s.endsWith("USDT")) s = `${s.slice(0, -4)}-USDT`;
    else throw new Error(`cannot parse symbol "${input}" — use e.g. "NEAR/USDT" or "NEAR-USDT-SWAP"`);
  }
  const parts = s.split("-").filter(Boolean);
  if (parts.length === 1) throw new Error(`cannot parse symbol "${input}"`);
  const [base, quote] = parts;
  return `${base}-${quote}-SWAP`;
}

const BAR_MAP = {
  "1M": "1m", "3M": "3m", "5M": "5m", "15M": "15m", "30M": "30m",
  "1H": "1H", "2H": "2H", "4H": "4H", "6H": "6H", "12H": "12H",
  "1D": "1D", "2D": "2D", "3D": "3D", "1W": "1W",
};

export function normalizeBar(input) {
  if (!input) return "1H";
  const upper = input.trim().toUpperCase();
  if (BAR_MAP[upper]) return BAR_MAP[upper];
  throw new Error(`unsupported bar "${input}" — use one of ${Object.keys(BAR_MAP).join(", ")}`);
}
