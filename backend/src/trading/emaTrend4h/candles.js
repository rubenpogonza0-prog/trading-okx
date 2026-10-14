// Fetches up to `count` closed candles (oldest-first) for one instrument,
// paging back through /market/history-candles once /market/candles (which
// only covers the most recent ~1440 bars and caps each call at 300) runs out.
const PAGE_RECENT = 300;
const PAGE_HISTORY = 100;

function parse(rows) {
  return rows.map(([ts, o, h, l, c, , , , confirm]) => ({
    ts: Number(ts),
    open: Number(o),
    high: Number(h),
    low: Number(l),
    close: Number(c),
    confirm,
  }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `okx` only needs a `get(path, query)` method, so the public client works.
export async function fetchClosedCandles(okx, instId, bar, count, { untilTs } = {}) {
  const byTs = new Map();
  let after = untilTs ? String(untilTs + 1) : undefined;
  let useHistory = Boolean(untilTs);

  while (byTs.size < count) {
    const path = useHistory ? "/api/v5/market/history-candles" : "/api/v5/market/candles";
    const limit = useHistory ? PAGE_HISTORY : PAGE_RECENT;
    const rows = parse(await okx.get(path, { instId, bar, limit, after }));
    if (!rows.length) break;
    for (const c of rows) if (c.confirm === "1") byTs.set(c.ts, c);
    after = String(Math.min(...rows.map((c) => c.ts)));
    if (useHistory) await sleep(120); // history-candles rate limit: 20 req / 2 s
    useHistory = true;
  }

  return [...byTs.values()].sort((a, b) => a.ts - b.ts).slice(-count);
}
