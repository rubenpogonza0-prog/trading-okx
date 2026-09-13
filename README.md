# OKX Futures Dashboard + Autonomous Trading Engine

Two things live in this repo:

1. **Dashboard** (`frontend/` + read endpoints in `backend/`) — view balance,
   open positions/PnL, and orders on your real OKX account.
2. **Autonomous trading engine** (`backend/src/trading/`) — a rule-based
   short-term futures strategy that scans OKX USDT-margined perpetual swaps,
   and **opens real leveraged positions with real money, unattended**,
   following the spec below. Read the whole "Risk and limitations" section
   before you turn this on.

## Setup

```bash
cd backend && npm install && cp .env.example .env   # fill in your OKX keys
cd ../frontend && npm install
```

Run the dashboard:

```bash
# terminal 1
cd backend && npm run dev
# terminal 2
cd frontend && npm run dev
```

Open http://localhost:5173.

## Running the trading engine

```bash
cd backend
npm run trade:dry-run     # one cycle, logs what it *would* do, places no orders
npm run trade:once        # one cycle, places real orders if a setup qualifies
npm run trade:scheduler   # repeats trade:once on CYCLE_CRON (default every 10 min), forever
```

**This needs to run on infrastructure you control (a VPS, a small always-on
host, Railway/Render), not inside a Claude Code chat session** — a chat
session's sandbox is ephemeral and gets reclaimed after inactivity, which
is not compatible with unattended real-money trading.

Start with `OKX_DEMO=1` in `.env` and a demo-trading API key, run it for a
while, and read the logs before pointing it at your live account.

### Deploying (GitHub Actions — no new account needed)

Since the code already lives in this GitHub repo, `.github/workflows/trade-cycle.yml`
runs a cycle on a schedule using GitHub's own infrastructure — nothing new
to sign up for.

1. Create an OKX API key at okx.com → API management: **Trade** permission
   only, **never Withdraw**.
2. In this repo: **Settings → Secrets and variables → Actions**.
3. Under **Secrets**, add: `OKX_API_KEY`, `OKX_API_SECRET`, `OKX_API_PASSPHRASE`.
4. Under **Variables** (same page, different tab), optionally add
   `OKX_DEMO` = `1` (default if you don't set it — demo mode) or `0` (live)
   once you're ready.
5. That's it. The workflow runs every 15 minutes (GitHub's scheduler won't
   reliably go faster than that), or trigger one immediately from the
   **Actions** tab → "OKX trading cycle" → **Run workflow**.
6. Bot state (`backend/data/state.json`, `backend/data/cycles.log`) is
   committed back to the repo by the workflow after each run — that's how
   it remembers open positions/cooldowns between runs despite each run
   starting on a fresh GitHub-hosted machine. You'll see small automated
   commits from `okx-trading-bot` — that's expected.
7. Watch it work: **Actions** tab → click a run → "Run one trading cycle"
   step shows the same output as running `trade:once` locally.

The dashboard (`frontend/`) isn't covered by this — it still needs
somewhere to run if you want the UI, e.g. Railway below, or just run it
locally pointed at your OKX account when you want to look.

### Deploying the dashboard/full engine as a service (Railway)

The dashboard API and the trading engine can run as a single process: set
`ENABLE_SCHEDULER=1` and the Express server (`npm start`) also runs the
cron cycle in-process, so one deployed service does both.

1. Create an OKX API key at okx.com → API management: **Trade** permission
   only, **never Withdraw**. IP-restrict it to Railway's egress if your
   plan gives you a static IP; otherwise leave unrestricted but keep the
   key scoped to Trade only.
2. On [railway.app](https://railway.app), **New Project → Deploy from
   GitHub repo** → pick `trading-okx`.
3. In the service settings: **Root Directory** = `backend`, **Start
   Command** = `npm start` (build/install is automatic from
   `package.json`).
4. Add environment variables (Railway → Variables):
   - `OKX_API_KEY`, `OKX_API_SECRET`, `OKX_API_PASSPHRASE`
   - `OKX_DEMO=1` to start in demo mode (switch to `0` once you trust it)
   - `ENABLE_SCHEDULER=1`
   - `CYCLE_CRON=*/10 * * * *` (or another standard cron expression)
   - `NEWS_FILTER_ENABLED=1` (recommended — see the news filter note below)
   - `PORT` — Railway injects this automatically, no need to set it
5. Deploy. Check the Railway logs for `"Startup cycle complete"` — that
   confirms it can reach OKX and ran a first scan.
6. `backend/data/` (state + logs) lives on Railway's container filesystem,
   which is **not persistent across redeploys** by default — attach a
   [Railway volume](https://docs.railway.app/reference/volumes) mounted at
   `backend/data` if you want position/cooldown state to survive a
   redeploy. Without a volume, a redeploy just forgets which positions it
   opened (OKX itself still has them — only the bot's own bookkeeping,
   used for the max-5/no-averaging-down/cooldown checks, resets).
7. Optionally deploy `frontend/` as a second Railway service (or anywhere
   static, e.g. Vercel/Netlify) pointing its API calls at the backend
   service's public URL instead of the Vite dev proxy.

A VPS (systemd/pm2 + `npm run trade:scheduler`) works the same way and
gives you a real persistent filesystem for `backend/data` with no extra
setup — trade the convenience of Railway against that.

## Strategy summary

Implements the spec you gave, as literally as OKX's actual market
structure allows:

- **Universe**: live `*-USDT-SWAP` instruments, restricted to an allowlist
  of actual cryptocurrencies (OKX also lists USDT-margined perpetuals on
  tokenized gold, oil, leveraged ETFs and individual stocks with identical
  instrument metadata — nothing structural distinguishes them from real
  crypto contracts, so they're excluded by name), stablecoins excluded,
  filtered by 24h quote volume (liquidity) and bid/ask spread, top 20 by
  24h volume. *OKX has no market-cap field* — 24h volume is used as the
  proxy the spec's "top 20 by market cap" maps to on this exchange.
- **Bias (1H)**: EMA20/50/200 stack + close position, RSI, MACD histogram,
  ADX(14) > 18, volume vs 20-period average, price still respecting the
  nearest 12-candle swing high/low (not the trend's starting point).
- **Entry (30M)**: breakout of the nearest swing level with volume
  confirmation, or a retest of EMA20 holding with momentum turning back in
  the bias direction.
- **Stop-loss**: `max(structure, 1.5×ATR(1H))` beyond entry (whichever is
  further away, i.e. more conservative), capped at 4×ATR(1H); trades whose
  stop can't be placed sanely are skipped.
- **Take-profit**: the better of 2×risk or the next 1H structural level,
  floored at the 1:1.8 minimum — trades below that R:R are skipped.
- **Position size**: fixed 2 USDT margin, lowest leverage in 1x–3x that
  reaches the instrument's minimum contract size. **Many top-20 contracts
  (BTC, ETH, …) require more than 2 USDT of margin even at 3x** — those
  are skipped with an explicit reason, not force-sized. This is a real
  OKX constraint, not a bug.
- **Risk limits**: max 5 bot-managed concurrent positions, no averaging
  down/pyramiding (one position per instrument), 2h cooldown after a
  stop-loss on a symbol before it's eligible again.
- **Execution**: entry + SL + TP are submitted together in a single order
  via OKX's `attachAlgoOrds`, so a position is never live unprotected.

Every cycle's decisions (trades and skip reasons) are appended to
`backend/data/state.json` (open bot positions) and `backend/data/cycles.log`
(full history, JSON lines), and surfaced in the dashboard's "Autonomous
Strategy Engine" panel.

## Risk and limitations — read before going live

- **This places real leveraged orders with no per-trade confirmation.**
  You asked for full autonomy; nothing here asks you before opening a
  position. Losses are real and can happen while you're not watching.
- **News/fundamental filter** (`backend/src/trading/newsFilter.js`) checks
  public RSS feeds (CoinDesk, CoinTelegraph, Decrypt) for market-wide
  keywords (hack, lawsuit, delisting, rate decisions, …) and asset-specific
  headlines in the last 6h before entering — no API key needed, on by
  default (`NEWS_FILTER_ENABLED=1`). It's headline keyword matching, not a
  sentiment model: it catches "there's breaking news right now", not subtle
  narrative shifts, and a dead feed fails open (logged, not blocking) rather
  than freezing the bot.
- **SL vs. TP inference on closed positions is best-effort.** OKX reports
  algo-order fills separately from the position record; the cooldown logic
  infers "was this a stop-loss?" by comparing the closing price to the
  recorded SL/TP levels, not a direct fill-type lookup. It can occasionally
  misclassify a close.
- **Position mode**: the bot reads your account's `posMode` (net vs.
  long/short hedge) and adapts, but it assumes you aren't manually trading
  the same instruments in a way that conflicts with its state tracking. If
  you place manual orders on a symbol the bot has open, its risk limits
  (max positions, no-averaging-down) can get out of sync with reality.
  Prefer keeping the account fully hand-off while the scheduler runs, or
  restrict manual trades to instruments outside the bot's top-20 universe.
- **API key scope**: create a key with **Trade** permission only, never
  **Withdraw**, and IP-restrict it to your server. `.env` is gitignored —
  never commit it.
