"""Offline tests: run with `pytest -q` from this directory. No network needed."""
import numpy as np
import pandas as pd
import pytest

import trend_pullback as tp
from trend_pullback import BAR_MS, CONFIG, Scenario

H = BAR_MS["1H"]


@pytest.fixture(scope="module")
def market():
    return tp.synthetic_market(90, seed=7)


def test_no_lookahead_truncation(market):
    """Signals up to time T must be identical whether or not later data exists."""
    df15, df1h = market
    full = tp.compute_signals(df15, df1h, CONFIG)
    for k in (len(df15) // 2, len(df15) - 777, len(df15) - 1):
        cut_ts = df15["ts"].iloc[k]
        part15 = df15[df15["ts"] < cut_ts]
        part1h = df1h[df1h["ts"] + H <= cut_ts]  # only 1H candles closed at T
        part = tp.compute_signals(part15, part1h, CONFIG)
        ref = full.iloc[: len(part)]
        for col in ("state", "side", "trend_1h", "reason"):
            assert (part[col].to_numpy() == ref[col].to_numpy()).all(), col
        for col in ("entry", "stop", "tp1", "swing_low_1h", "swing_high_1h", "adx_1h"):
            np.testing.assert_allclose(part[col].to_numpy(), ref[col].to_numpy(), equal_nan=True, err_msg=col)
    assert (full["state"] == tp.STATE_TRIGGERED).sum() > 0


def test_trend_uses_only_closed_1h_candles(market):
    df15, df1h = market
    sig = tp.compute_signals(df15, df1h, CONFIG)
    ok = sig["avail_ts"].notna()
    # the 1H candle used must have closed at or before the 15m candle opened
    assert (sig.loc[ok, "avail_ts"] <= sig.loc[ok, "ts"]).all()
    # ...and be the latest such candle (15m candle at 10:45 uses the 09:00-10:00 1H bar)
    assert (sig.loc[ok, "ts"] - sig.loc[ok, "avail_ts"] < H).all()


def test_triggered_rows_respect_rules(market):
    df15, df1h = market
    sig = tp.compute_signals(df15, df1h, CONFIG)
    t = sig[sig["state"] == tp.STATE_TRIGGERED]
    assert len(t) > 0
    assert (t["side"] == t["trend_1h"]).all()
    dist = (t["entry"] - t["stop"]).abs()
    assert (dist >= CONFIG.stop_min_atr * t["atr"] - 1e-9).all()
    assert (dist <= CONFIG.stop_max_atr * t["atr"] + 1e-9).all()
    longs, shorts = t[t["side"] == 1], t[t["side"] == -1]
    assert (longs["close"] > longs["ema21"]).all() and (shorts["close"] < shorts["ema21"]).all()
    np.testing.assert_allclose((t["tp1"] - t["entry"]).abs(), CONFIG.tp1_r * dist)


def test_swings_are_confirmed_later():
    lows = pd.Series([5, 4, 3, 4, 5, 6, 7], dtype=float)
    hi, lo = tp.confirmed_swings(lows + 1, lows, 2)
    assert np.isnan(lo.iloc[3])      # pivot at bar 2 not known yet at bar 3
    assert lo.iloc[4] == 3           # confirmed once bars 3 and 4 closed


def test_rsi_bounds():
    s = pd.Series(np.linspace(1, 50, 60))
    assert tp.rsi(s, 14).dropna().eq(100).all()
    r = tp.rsi(pd.Series(np.random.default_rng(0).normal(0, 1, 500).cumsum() + 100), 14).dropna()
    assert r.between(0, 100).all()


def _hand_sig(bars, ema21, entry_bar_close=100.0, stop=98.0, side=1):
    """Frame shaped like compute_signals() output with one trigger at bar 0."""
    n = len(bars) + 1
    df = pd.DataFrame(
        [(entry_bar_close,) * 4] + bars, columns=["open", "high", "low", "close"])
    df["ts"] = np.arange(n) * BAR_MS["15m"]
    df["ema21"] = ema21
    df["state"] = [tp.STATE_TRIGGERED] + [tp.STATE_NONE] * (n - 1)
    df["side"] = [side] + [0] * (n - 1)
    df["stop"] = [stop] + [np.nan] * (n - 1)
    df["tp1"] = [entry_bar_close + side * CONFIG.tp1_r * abs(entry_bar_close - stop)] + [np.nan] * (n - 1)
    return df


NOCOST = Scenario("nocost", 0.0, False)
CFG0 = tp.replace(CONFIG, taker_fee=0.0, maker_fee=0.0, slippage=0.0)


def test_stop_loss_is_minus_one_r():
    df = _hand_sig([(99.5, 99.8, 97.0, 97.5)], ema21=95.0)
    (t,) = tp.simulate_strategy(df, 0, len(df), CFG0, NOCOST)
    assert t["exit_reason"] == "stop" and t["R"] == pytest.approx(-1.0)
    assert t["ret"] == pytest.approx(-CFG0.risk_pct)


def test_tp1_then_ema_trail():
    # TP1 = 103. Bar1 hits 103.5 (half off at +1.5R), bar2 closes 104 above ema, bar3 closes below ema at 101.
    bars = [(100.5, 103.5, 100.2, 103.0), (103.0, 104.5, 102.8, 104.0), (104.0, 104.1, 100.8, 101.0)]
    df = _hand_sig(bars, ema21=[99, 99, 102, 102])
    (t,) = tp.simulate_strategy(df, 0, len(df), CFG0, NOCOST)
    assert t["exit_reason"] == "tp1+ema_trail" and t["tp1_hit"]
    assert t["R"] == pytest.approx(0.5 * 1.5 + 0.5 * (101 - 100) / 2)


def test_same_bar_stop_and_tp_is_pessimistic():
    df = _hand_sig([(100.0, 104.0, 97.0, 100.0)], ema21=95.0)
    (t,) = tp.simulate_strategy(df, 0, len(df), CFG0, NOCOST)
    assert t["exit_reason"] == "stop" and t["R"] == pytest.approx(-1.0)


def test_breakeven_after_tp1_and_short_side():
    # short at 100, stop 102, tp1 97; bar1 hits 96.5, bar2 rallies to 100.5 -> breakeven
    bars = [(99.5, 99.8, 96.5, 97.2), (97.2, 100.5, 97.0, 100.2)]
    df = _hand_sig(bars, ema21=110.0, stop=102.0, side=-1)
    (t,) = tp.simulate_strategy(df, 0, len(df), CFG0, NOCOST)
    assert t["exit_reason"] == "breakeven"
    assert t["R"] == pytest.approx(0.5 * 1.5)


def test_time_stop():
    bars = [(100.0, 100.5, 99.5, 100.2)] * (CONFIG.time_stop_bars + 5)
    df = _hand_sig(bars, ema21=99.0)
    (t,) = tp.simulate_strategy(df, 0, len(df), CFG0, NOCOST)
    assert t["exit_reason"] == "time" and t["bars"] == CONFIG.time_stop_bars


def test_fees_reduce_r():
    df = _hand_sig([(99.5, 99.8, 97.0, 97.5)], ema21=95.0)
    (t,) = tp.simulate_strategy(df, 0, len(df), CONFIG, tp.scenarios(CONFIG)[0])
    assert t["R"] < -1.0 and t["fees"] > 0


def test_metrics():
    tr = pd.DataFrame({"R": [1.0, -1.0, -1.0, 2.0, -1.0], "ret": [0.01, -0.01, -0.01, 0.02, -0.01],
                       "exit_time": pd.date_range("2025-01-01", periods=5)})
    m = tp.metrics(tr, CONFIG)
    assert m["trades"] == 5 and not m["reliable"]
    assert m["win_rate"] == pytest.approx(0.4)
    assert m["profit_factor"] == pytest.approx(1.0)
    assert m["longest_losing_streak"] == 2
    assert m["avg_R"] == pytest.approx(0.0)


def test_backtest_segments_do_not_overlap(market):
    df15, df1h = market
    trades = pd.DataFrame(tp.backtest_instrument("X", df15, df1h, CONFIG))
    cut = pd.to_datetime(df15["ts"].iloc[int(len(df15) * CONFIG.is_fraction)] + BAR_MS["15m"], unit="ms", utc=True)
    is_ = trades[trades["segment"] == "IS"]
    oos = trades[trades["segment"] == "OOS"]
    assert len(is_) and len(oos)
    assert (is_["exit_time"] <= cut).all() and (oos["entry_time"] > cut).all()
    assert set(trades["strategy"]) == {"pullback", "baseline_ema9_21"}
    assert set(trades["scenario"]) == {"taker", "maker_entry"}


def test_rows_to_df_drops_unconfirmed():
    rows = [["2000", "1", "2", "0.5", "1.5", "10", "10", "15", "0"],
            ["1000", "1", "2", "0.5", "1.5", "10", "10", "15", "1"]]
    df = tp._rows_to_df(rows)
    assert df["ts"].tolist() == [1000]
