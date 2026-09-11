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
npm run trade:scheduler   # runs trade:once every hour, forever — this is the live bot
```

**`trade:scheduler` is meant to run on infrastructure you control (a VPS,
a systemd service, pm2, Docker), not inside a Claude Code chat session** —
this session's sandbox is ephemeral and gets reclaimed after inactivity,
which is not compatible with unattended real-money trading. Deploy it,
then walk away and check the dashboard / `backend/data/cycles.log`.

Start with `OKX_DEMO=1` in `.env` and a demo-trading API key, run the
scheduler for at least a few real hourly cycles, and read the logs before
pointing it at your live account.

## Strategy summary

Implements the spec you gave, as literally as OKX's actual market
structure allows:

- **Universe**: live `*-USDT-SWAP` instruments, stablecoin bases excluded,
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
- **News/fundamental filter is a documented no-op by default**
  (`backend/src/trading/newsFilter.js`). No news API key is configured, so
  the spec's "check for major news before entering" is *not* actually
  enforced unless you wire a provider in and set `NEWS_FILTER_ENABLED=1`.
  Until then, check headlines yourself for anything the bot opens.
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
