// Fundamental/news guard called right before execution. This standalone
// script has no news API wired in by default (OKX's own news endpoints are
// only reachable through the Claude session's MCP connection, not from an
// unattended cron process) — so out of the box this is a documented no-op.
//
// To enforce the spec's "avoid trading during extremely unpredictable news
// events" rule for real, plug a provider here (e.g. CryptoPanic, NewsAPI,
// an economic-calendar API) and set NEWS_FILTER_ENABLED=1. Until then,
// every signal proceeds with a note flagging that news was not checked —
// review headlines yourself for a symbol before trusting an autonomous fill.
export async function checkNews({ instId }) {
  if (process.env.NEWS_FILTER_ENABLED !== "1") {
    return {
      blocked: false,
      note: "news filter not configured — no live news/events source is wired in; verify manually",
    };
  }
  // Placeholder for a real integration once NEWS_FILTER_ENABLED=1 is set.
  return { blocked: false, note: "news filter enabled but no provider implemented yet" };
}
