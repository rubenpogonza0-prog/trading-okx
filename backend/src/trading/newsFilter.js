// Fundamental/news guard called right before execution, per the spec's
// "avoid trading during extremely unpredictable news events" rule.
//
// Uses public RSS feeds from crypto news outlets — no API key or signup
// needed, which matters here since this runs unattended on GitHub Actions.
// It is deliberately simple (headline keyword/name matching over a short
// lookback window), not a sentiment model: it catches "there is a hack /
// lawsuit / delisting / major macro headline right now" style events, not
// subtle narrative shifts. Set NEWS_FILTER_ENABLED=0 to disable.

const FEEDS = [
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss",
  "https://decrypt.co/feed",
];

const LOOKBACK_HOURS = 6;
const FETCH_TIMEOUT_MS = 8000;

// High-impact keywords that warrant standing down on ALL symbols this
// cycle, not just one asset — matches the spec's macro/market-wide events.
const MARKET_WIDE_KEYWORDS = [
  "sec sues",
  "sec charges",
  "sec rejects",
  "lawsuit",
  "hack",
  "hacked",
  "exploit",
  "exploited",
  "drained",
  "rug pull",
  "delisting",
  "delisted",
  "fomc",
  "rate hike",
  "rate cut",
  "interest rate decision",
  "ban on crypto",
  "bans crypto",
  "regulatory crackdown",
  "market crash",
  "flash crash",
];

// Base currency -> names/aliases that actually show up in headlines
// (outlets write "Solana", not "SOL"). Covers the universe.js allowlist.
const ASSET_NAMES = {
  BTC: ["bitcoin", "btc"],
  ETH: ["ethereum", "eth", "ether"],
  XRP: ["xrp", "ripple"],
  BNB: ["bnb", "binance coin"],
  SOL: ["solana", "sol"],
  DOGE: ["dogecoin", "doge"],
  ADA: ["cardano", "ada"],
  TRX: ["tron", "trx"],
  LINK: ["chainlink", "link"],
  AVAX: ["avalanche", "avax"],
  XLM: ["stellar", "xlm"],
  TON: ["toncoin", "ton "],
  SHIB: ["shiba inu", "shib"],
  SUI: ["sui network", " sui "],
  DOT: ["polkadot", "dot"],
  LTC: ["litecoin", "ltc"],
  BCH: ["bitcoin cash", "bch"],
  HBAR: ["hedera", "hbar"],
  UNI: ["uniswap", "uni "],
  NEAR: ["near protocol", "near"],
  APT: ["aptos", "apt"],
  ICP: ["internet computer", "icp"],
  POL: ["polygon", "matic", "pol "],
  MATIC: ["polygon", "matic"],
  FIL: ["filecoin", "fil "],
  ETC: ["ethereum classic", "etc"],
  ATOM: ["cosmos", "atom"],
  RENDER: ["render network", "render"],
  ARB: ["arbitrum", "arb "],
  OP: ["optimism", " op "],
  INJ: ["injective", "inj"],
  TIA: ["celestia", "tia"],
  SEI: ["sei network", "sei "],
  IMX: ["immutable", "imx"],
  GRT: ["the graph", "grt"],
  AAVE: ["aave"],
  ALGO: ["algorand", "algo"],
  VET: ["vechain", "vet"],
  STX: ["stacks", "stx"],
  MKR: ["makerdao", "maker", "mkr"],
  RUNE: ["thorchain", "rune"],
  FTM: ["fantom", "ftm"],
  THETA: ["theta network", "theta"],
  EGLD: ["multiversx", "elrond", "egld"],
  SAND: ["the sandbox", "sand "],
  MANA: ["decentraland", "mana"],
  AXS: ["axie infinity", "axs"],
  XTZ: ["tezos", "xtz"],
  FLOW: ["flow blockchain", "flow "],
  KAVA: ["kava"],
  QNT: ["quant network", "qnt"],
  CRV: ["curve finance", "curve dao", "crv"],
  LDO: ["lido finance", "lido", "ldo"],
  GALA: ["gala games", "gala"],
  CHZ: ["chiliz", "chz"],
  EOS: ["eos network", "eos"],
  ZEC: ["zcash", "zec"],
  XMR: ["monero", "xmr"],
  DASH: ["dash "],
  NEO: ["neo "],
  KAS: ["kaspa", "kas "],
  WLD: ["worldcoin", "wld"],
  PEPE: ["pepe"],
  BONK: ["bonk"],
  WIF: ["dogwifhat", "wif"],
  JUP: ["jupiter exchange", "jupiter dex", "jup "],
  PYTH: ["pyth network", "pyth"],
  STRK: ["starknet", "strk"],
  ENA: ["ethena", "ena "],
  JTO: ["jito"],
  ONDO: ["ondo finance", "ondo"],
  TAO: ["bittensor", "tao "],
  FET: ["fetch.ai", "fetch ai", " fet "],
};

let cache = null; // { fetchedAt, headlines } — reused across symbols within one cycle

async function fetchFeed(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const xml = await res.text();
    return parseRssItems(xml);
  } finally {
    clearTimeout(timeout);
  }
}

function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item\b[\s\S]*?<\/item>/gi;
  const titleRe = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
  const dateRe = /<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i;
  for (const match of xml.matchAll(itemRe)) {
    const block = match[0];
    const title = titleRe.exec(block)?.[1];
    const pubDate = dateRe.exec(block)?.[1];
    if (!title) continue;
    items.push({
      title: decodeXmlEntities(title.replace(/^<!\[CDATA\[|\]\]>$/g, "")).trim(),
      publishedAt: pubDate ? new Date(pubDate) : null,
    });
  }
  return items;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function getRecentHeadlines() {
  if (cache && Date.now() - cache.fetchedAt < 5 * 60 * 1000) {
    return cache.headlines;
  }
  const cutoff = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const headlines = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const item of r.value) {
      if (item.publishedAt && item.publishedAt.getTime() < cutoff) continue;
      headlines.push(item);
    }
  }
  cache = { fetchedAt: Date.now(), headlines };
  return headlines;
}

export async function checkNews({ instId, baseCcy }) {
  if (process.env.NEWS_FILTER_ENABLED !== "1") {
    return { blocked: false, note: "news filter disabled (set NEWS_FILTER_ENABLED=1 to enable)" };
  }

  let headlines;
  try {
    headlines = await getRecentHeadlines();
  } catch (err) {
    // Fail open — a dead RSS feed shouldn't halt the whole bot — but say so.
    return { blocked: false, note: `news filter unavailable (${err.message}) — not checked this cycle` };
  }

  for (const h of headlines) {
    const lower = h.title.toLowerCase();
    for (const kw of MARKET_WIDE_KEYWORDS) {
      if (lower.includes(kw)) {
        return { blocked: true, note: `market-wide news: "${h.title}"` };
      }
    }
  }

  const aliases = ASSET_NAMES[baseCcy];
  if (aliases) {
    for (const h of headlines) {
      const lower = h.title.toLowerCase();
      if (aliases.some((a) => lower.includes(a))) {
        return { blocked: true, note: `recent headline on ${baseCcy}: "${h.title}"` };
      }
    }
  }

  return {
    blocked: false,
    note: `no major ${baseCcy}/market headlines in the last ${LOOKBACK_HOURS}h (${headlines.length} checked)`,
  };
}
