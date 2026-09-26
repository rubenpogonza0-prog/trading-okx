# Trend-pullback scanner + backtest (OKX USDT perpetuals)

Research tool: **signals and backtest only — it never places orders** and uses only
OKX public endpoints (no API keys). Independent from the Node.js bot in `backend/`.

```bash
cd pullback
pip install -r requirements.txt
python trend_pullback.py scan                                   # live table + output/scan_*.csv
python trend_pullback.py backtest                               # top 15 liquid USDT-SWAPs, 400 days
python trend_pullback.py backtest --inst BTC-USDT-SWAP,ETH-USDT-SWAP --days 450
python trend_pullback.py backtest --synthetic                   # offline smoke test (fake data)
pytest -q                                                       # offline tests
```

All parameters are in the `Config` block at the top of `trend_pullback.py`.
Candles are cached in `data/cache/` (first backtest download ≈ 1 min per instrument
at the public rate limit; later runs only fetch new candles).

## Strategy (as implemented)

| Part | Rule |
|---|---|
| 1H trend | Bull: close > EMA200, EMA50 > EMA200, ADX(14) > 20. Bear: mirror. Else no trades. |
| Pullback (long) | Starts on the first 15m candle whose low touches/dips below EMA21. Continues while candles touch EMA21 or close ≤ it; abandoned after `max_pullback_bars` (16) or if price leaves the EMA without a trigger. |
| Trigger (long) | A later candle closes > EMA21, RSI(14) > previous RSI, and RSI went < 45 at some point during the pullback. Entry at that close. |
| Swing filter | Skip if any pullback candle's low is below the last **confirmed** 1H fractal swing low (pivot with 2 higher lows each side). |
| Stop | Pullback low (incl. trigger candle). Distance must be 1–2.5 × ATR(14, 15m) or the setup is skipped. |
| Exits | 50% at 1.5R, stop → breakeven, remainder exits on a 15m close below EMA21. Time stop: 24 candles without SL or TP1. |
| Size | `risk_pct` (1%) of equity / stop distance, notional capped at `max_leverage` × equity. |

Shorts mirror everything (RSI > 55, swing high, etc.).

**No lookahead.** A 15m candle opening at `t` only sees 1H candles whose close
time is ≤ `t` (`merge_asof` on the 1H close time), and a 1H swing point only once
the bars that confirm it have closed. `test_no_lookahead_truncation` recomputes
signals on data truncated at several points and checks every earlier bar is identical.

`compute_signals()` is the one function holding the strategy logic; the scanner
reads its last row and the backtest walks all rows.

## Backtest details

- Split per instrument by 15m bar count: first 70% in-sample, last 30% out-of-sample.
  Nothing is optimized anywhere — the parameters are the spec's; OOS is just reported.
  Positions are force-closed at the segment boundary so no trade spans both.
- Indicators warm up on the first `warmup_bars_1h` (400) 1H bars inside IS; both
  the strategy and the baseline start trading only after that.
- Cost scenarios: `taker` (0.05% in and out + slippage per taker fill) and
  `maker_entry` (0.02% entry, no entry slippage — assumes the limit at the close fills,
  so it's optimistic; exits still taker).
- Intrabar ambiguity is resolved pessimistically: if a candle touches both stop and
  TP1, it's a stop; if the TP1 candle also reaches breakeven, the rest is stopped at BE.
  Gaps through a stop fill at the open.
- Baseline: EMA 9/21 cross on 15m, always in the market, exit + reverse on the opposite
  cross, same fees. It has no stop, so 1R := 1.5 × ATR at entry (used for sizing and R stats).
- Metrics per scenario × segment × strategy (pooled) and per instrument: trades, win rate,
  avg R, profit factor (on R), expectancy (R and % equity), max drawdown, longest losing
  streak, sum of R. Fewer than 30 trades is flagged `UNRELIABLE`.
- Outputs: `output/backtest_summary.csv`, `backtest_by_instrument.csv`, `backtest_trades.csv`.

## Known limitations

- Funding payments are not included in the backtest (the scanner does show current funding
  and warns when |rate| > 0.05% against the trend direction).
- The default universe is *today's* liquid list → survivorship bias. Pass `--inst` to
  fix a list.
- Pooled metrics chain trades in exit order and ignore that positions on different
  instruments overlap; per-instrument results don't have that issue.
- No partial fills, liquidation, or margin interaction between concurrent positions.
