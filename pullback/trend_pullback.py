#!/usr/bin/env python3
"""
Multi-timeframe trend-pullback strategy for OKX USDT-margined perpetual swaps.

SIGNALS + BACKTEST ONLY. This module never places, amends or cancels orders
and never uses API keys: it only calls OKX public market-data endpoints.

    python trend_pullback.py scan                       # live scanner -> table + CSV
    python trend_pullback.py backtest                   # top instruments by volume
    python trend_pullback.py backtest --inst BTC-USDT-SWAP,ETH-USDT-SWAP
    python trend_pullback.py backtest --synthetic       # offline smoke test, fake data

The strategy logic lives in exactly one place, `compute_signals()`, which both
the scanner (reads the last closed bar) and the backtest (walks every bar) use.
"""
from __future__ import annotations

import argparse
import random
import sys
import time
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np
import pandas as pd
import requests


# =============================================================================
# CONFIG — every tunable parameter lives in this block.
# =============================================================================
@dataclass(frozen=True)
class Config:
    # --- Universe / scanner -------------------------------------------------
    min_vol_usdt_24h: float = 20_000_000   # 24h quote volume filter
    settle_ccy: str = "USDT"
    funding_warn_threshold: float = 0.0005  # |rate| per funding interval (0.05%)
    scan_days_1h: int = 45                  # 1H history the scanner loads (EMA200 warm-up)
    scan_days_15m: int = 5                  # 15m history the scanner loads

    # --- Timeframes ---------------------------------------------------------
    trend_bar: str = "1H"
    entry_bar: str = "15m"

    # --- Trend filter (1H, closed candles) ----------------------------------
    ema_fast_1h: int = 50
    ema_slow_1h: int = 200
    adx_len: int = 14
    adx_min: float = 20.0
    swing_pivot_len: int = 2        # 1H fractal pivot: N lower/higher bars each side
    warmup_bars_1h: int = 400       # no trend signal until this many 1H bars exist

    # --- Entry (15m, closed candles) ----------------------------------------
    ema_entry: int = 21
    rsi_len: int = 14
    rsi_long_max: float = 45.0      # long: RSI must dip below this during pullback
    rsi_short_min: float = 55.0     # short: RSI must rise above this during pullback
    max_pullback_bars: int = 16     # abandon a pullback that drags on longer than this

    # --- Risk / exits -------------------------------------------------------
    atr_len: int = 14
    stop_buffer_atr: float = 0.0    # extra distance beyond the pullback extreme
    stop_min_atr: float = 1.0       # skip if structural stop is closer than this
    stop_max_atr: float = 2.5       # skip if structural stop is further than this
    tp1_r: float = 1.5
    tp1_fraction: float = 0.5       # fraction closed at TP1; rest trails EMA21
    time_stop_bars: int = 24        # close if neither SL nor TP1 within N candles
    risk_pct: float = 0.01          # fraction of equity risked per trade
    max_leverage: float = 10.0      # notional cap (qty is reduced if exceeded)
    initial_equity: float = 10_000.0

    # --- Costs --------------------------------------------------------------
    taker_fee: float = 0.0005
    maker_fee: float = 0.0002
    slippage: float = 0.0002        # adverse fraction of price on every taker fill
    tp1_fee_maker: bool = False     # TP1 is a resting limit; True = charge maker fee

    # --- Backtest -----------------------------------------------------------
    history_days: int = 400         # fetched history (>= min_history_days + warm-up)
    min_history_days: int = 365     # skip instruments with less 15m history
    is_fraction: float = 0.70       # first 70% in-sample, last 30% out-of-sample
    min_trades_reliable: int = 30
    backtest_max_instruments: int = 15  # top-N by 24h volume when --inst not given
    baseline_fast: int = 9
    baseline_slow: int = 21
    baseline_r_atr: float = 1.5     # baseline has no stop: 1R := this many ATRs (sizing + R stats)

    # --- Data / HTTP --------------------------------------------------------
    base_url: str = "https://www.okx.com"
    min_request_interval: float = 0.12  # s between calls (history-candles: 20 req / 2 s)
    max_retries: int = 6
    http_timeout: float = 15.0
    cache_dir: str = "data/cache"
    output_dir: str = "output"


CONFIG = Config()

BAR_MS = {"1m": 60_000, "5m": 300_000, "15m": 900_000, "1H": 3_600_000, "4H": 14_400_000}


# =============================================================================
# OKX public REST client (rate-limited, retrying)
# =============================================================================
class OKXError(RuntimeError):
    pass


# Codes OKX uses for "too many requests" / "system busy" — worth retrying.
_RETRYABLE_CODES = {"50011", "50013", "50026", "50061"}


class OKXPublic:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "trend-pullback-research/1.0"
        self._last_call = 0.0

    def _throttle(self) -> None:
        wait = self.cfg.min_request_interval - (time.monotonic() - self._last_call)
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.monotonic()

    def get(self, path: str, params: dict | None = None) -> list:
        url = self.cfg.base_url + path
        last_err = "unknown"
        for attempt in range(self.cfg.max_retries):
            self._throttle()
            backoff = min(2 ** attempt, 30) + random.random()
            try:
                r = self.session.get(url, params=params, timeout=self.cfg.http_timeout)
            except requests.RequestException as e:
                last_err = f"network: {e}"
                time.sleep(backoff)
                continue
            if r.status_code == 429 or r.status_code >= 500:
                last_err = f"HTTP {r.status_code}"
                retry_after = r.headers.get("Retry-After")
                time.sleep(float(retry_after) if retry_after and retry_after.isdigit() else backoff)
                continue
            if r.status_code != 200:
                raise OKXError(f"{path} HTTP {r.status_code}: {r.text[:200]}")
            try:
                body = r.json()
            except ValueError:
                last_err = "invalid JSON"
                time.sleep(backoff)
                continue
            code = str(body.get("code"))
            if code == "0":
                return body.get("data", [])
            if code in _RETRYABLE_CODES:
                last_err = f"OKX {code} {body.get('msg')}"
                time.sleep(backoff)
                continue
            raise OKXError(f"{path} {params}: OKX code {code}: {body.get('msg')}")
        raise OKXError(f"{path} {params}: gave up after {self.cfg.max_retries} tries ({last_err})")

    # --- endpoints ----------------------------------------------------------
    def swap_instruments(self) -> pd.DataFrame:
        df = pd.DataFrame(self.get("/api/v5/public/instruments", {"instType": "SWAP"}))
        df = df[(df["settleCcy"] == self.cfg.settle_ccy) & (df["state"] == "live")
                & (df["ctType"] == "linear")]
        df = df.assign(listTime=pd.to_numeric(df["listTime"], errors="coerce"))
        return df[["instId", "listTime"]]

    def swap_tickers(self) -> pd.DataFrame:
        df = pd.DataFrame(self.get("/api/v5/market/tickers", {"instType": "SWAP"}))
        last = pd.to_numeric(df["last"], errors="coerce")
        # For SWAP tickers volCcy24h is in base currency; x last = quote (USDT) volume.
        vol_base = pd.to_numeric(df["volCcy24h"], errors="coerce")
        return pd.DataFrame({"instId": df["instId"], "last": last, "vol_usdt_24h": vol_base * last})

    def funding_rate(self, inst_id: str) -> float:
        data = self.get("/api/v5/public/funding-rate", {"instId": inst_id})
        return float(data[0]["fundingRate"]) if data and data[0].get("fundingRate") not in (None, "") else float("nan")

    def candles_page(self, inst_id: str, bar: str, after: int | None) -> list:
        """One page, newest first. No cursor -> latest candles endpoint."""
        if after is None:
            return self.get("/api/v5/market/candles", {"instId": inst_id, "bar": bar, "limit": "300"})
        return self.get("/api/v5/market/history-candles",
                        {"instId": inst_id, "bar": bar, "after": str(after), "limit": "100"})


def liquid_universe(client: OKXPublic, cfg: Config) -> pd.DataFrame:
    inst = client.swap_instruments()
    tick = client.swap_tickers()
    df = inst.merge(tick, on="instId", how="inner")
    df = df[df["vol_usdt_24h"] > cfg.min_vol_usdt_24h]
    return df.sort_values("vol_usdt_24h", ascending=False).reset_index(drop=True)


# =============================================================================
# Candle download + on-disk cache (only fully closed candles are kept)
# =============================================================================
_CANDLE_COLS = ["ts", "open", "high", "low", "close", "vol", "volCcy", "vol_quote", "confirm"]


def _rows_to_df(rows: list) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame(columns=["ts", "open", "high", "low", "close", "vol_quote"])
    df = pd.DataFrame(rows, columns=_CANDLE_COLS[: len(rows[0])])
    df = df[df["confirm"].astype(str) == "1"]  # drop the still-forming candle
    out = df[["ts", "open", "high", "low", "close", "vol_quote"]].apply(pd.to_numeric, errors="coerce")
    out["ts"] = out["ts"].astype("int64")
    return out


def _fetch_back(client: OKXPublic, inst_id: str, bar: str, stop_at_ms: int, before_ms: int | None) -> pd.DataFrame:
    """Page backwards from `before_ms` (or now) until reaching `stop_at_ms`."""
    rows, cursor = [], before_ms
    while True:
        page = client.candles_page(inst_id, bar, cursor)
        if not page:
            break
        rows.extend(page)
        oldest = int(page[-1][0])
        if oldest <= stop_at_ms or (cursor is not None and oldest >= cursor):
            break
        cursor = oldest
    return _rows_to_df(rows)


def load_candles(client: OKXPublic, inst_id: str, bar: str, start_ms: int, cfg: Config) -> pd.DataFrame:
    cache = Path(cfg.cache_dir) / f"{inst_id}_{bar}.csv.gz"
    cache.parent.mkdir(parents=True, exist_ok=True)
    cached = pd.read_csv(cache) if cache.exists() else pd.DataFrame()
    frames = [cached] if not cached.empty else []
    if cached.empty:
        frames.append(_fetch_back(client, inst_id, bar, start_ms, None))
    else:
        cmin, cmax = int(cached["ts"].min()), int(cached["ts"].max())
        frames.append(_fetch_back(client, inst_id, bar, cmax, None))        # newer candles
        if start_ms < cmin:
            frames.append(_fetch_back(client, inst_id, bar, start_ms, cmin))  # older candles
    df = pd.concat([f for f in frames if not f.empty], ignore_index=True) if frames else pd.DataFrame()
    if df.empty:
        return df
    df = df.drop_duplicates("ts", keep="last").sort_values("ts").reset_index(drop=True)
    df["ts"] = df["ts"].astype("int64")
    df.to_csv(cache, index=False, compression="gzip")
    return df[df["ts"] >= start_ms].reset_index(drop=True)


# =============================================================================
# Indicators (Wilder smoothing where the classic definition uses it)
# =============================================================================
def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def rma(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()


def rsi(close: pd.Series, n: int) -> pd.Series:
    d = close.diff()
    up, dn = rma(d.clip(lower=0), n), rma(-d.clip(upper=0), n)
    out = 100 - 100 / (1 + up / dn)
    return out.where(dn != 0, 100.0).where(up.notna())


def true_range(h: pd.Series, l: pd.Series, c: pd.Series) -> pd.Series:
    pc = c.shift(1)
    return pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)


def atr(h: pd.Series, l: pd.Series, c: pd.Series, n: int) -> pd.Series:
    return rma(true_range(h, l, c), n)


def adx(h: pd.Series, l: pd.Series, c: pd.Series, n: int) -> pd.Series:
    up, dn = h.diff(), -l.diff()
    plus_dm = up.where((up > dn) & (up > 0), 0.0)
    minus_dm = dn.where((dn > up) & (dn > 0), 0.0)
    tr = rma(true_range(h, l, c), n)
    plus_di = 100 * rma(plus_dm, n) / tr
    minus_di = 100 * rma(minus_dm, n) / tr
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di)
    return rma(dx.fillna(0), n)


def confirmed_swings(h: pd.Series, l: pd.Series, n: int) -> tuple[pd.Series, pd.Series]:
    """Last fractal swing high/low, known only once N bars to its right have closed.

    A pivot at bar i needs bars i+1..i+N, so its value is shifted to bar i+N:
    at any bar j the series holds only pivots fully confirmed by bar j.
    """
    w = 2 * n + 1
    is_lo = l == l.rolling(w, center=True).min()
    is_hi = h == h.rolling(w, center=True).max()
    swing_lo = l.where(is_lo).shift(n).ffill()
    swing_hi = h.where(is_hi).shift(n).ffill()
    return swing_hi, swing_lo


# =============================================================================
# SIGNAL LOGIC — the single shared function used by scanner AND backtest
# =============================================================================
STATE_NONE, STATE_FORMING, STATE_TRIGGERED, STATE_SKIPPED = "none", "forming", "triggered", "skipped"


def trend_frame(df1h: pd.DataFrame, cfg: Config) -> pd.DataFrame:
    h = df1h[["ts", "open", "high", "low", "close"]].copy().reset_index(drop=True)
    h["ema_fast_1h"] = ema(h["close"], cfg.ema_fast_1h)
    h["ema_slow_1h"] = ema(h["close"], cfg.ema_slow_1h)
    h["adx_1h"] = adx(h["high"], h["low"], h["close"], cfg.adx_len)
    bull = (h["close"] > h["ema_slow_1h"]) & (h["ema_fast_1h"] > h["ema_slow_1h"]) & (h["adx_1h"] > cfg.adx_min)
    bear = (h["close"] < h["ema_slow_1h"]) & (h["ema_fast_1h"] < h["ema_slow_1h"]) & (h["adx_1h"] > cfg.adx_min)
    trend = np.where(bull, 1, np.where(bear, -1, 0))
    trend[: cfg.warmup_bars_1h] = 0
    h["trend_1h"] = trend
    h["ready_1h"] = np.arange(len(h)) >= cfg.warmup_bars_1h
    h["swing_high_1h"], h["swing_low_1h"] = confirmed_swings(h["high"], h["low"], cfg.swing_pivot_len)
    # A 1H candle opened at ts is fully closed at ts + 1h: that is when it becomes usable.
    h["avail_ts"] = h["ts"] + BAR_MS[cfg.trend_bar]
    return h


def compute_signals(df15: pd.DataFrame, df1h: pd.DataFrame, cfg: Config = CONFIG) -> pd.DataFrame:
    """Evaluate the strategy on every closed 15m candle.

    Inputs: closed candles only, columns ts(ms, candle open), open, high, low, close.
    Output: df15 plus indicator columns and, per bar:
        state  - none | forming | triggered | skipped
        side   - +1 long / -1 short / 0
        entry, stop, tp1, r_pct   (triggered: actual; forming: indicative, entry = close)
        reason - why a setup was skipped
    No lookahead: a 15m candle opening at t only sees 1H candles with close time <= t,
    and 1H swing points only once confirmed by then.
    """
    m = df15[["ts", "open", "high", "low", "close"]].copy().sort_values("ts").reset_index(drop=True)
    m["ema21"] = ema(m["close"], cfg.ema_entry)
    m["rsi"] = rsi(m["close"], cfg.rsi_len)
    m["atr"] = atr(m["high"], m["low"], m["close"], cfg.atr_len)

    h = trend_frame(df1h, cfg)
    cols = ["avail_ts", "trend_1h", "ready_1h", "adx_1h", "ema_fast_1h", "ema_slow_1h",
            "swing_high_1h", "swing_low_1h"]
    m = pd.merge_asof(m, h[cols], left_on="ts", right_on="avail_ts", direction="backward",
                      tolerance=BAR_MS[cfg.trend_bar])  # never use a stale 1H bar across a data gap
    m["trend_1h"] = m["trend_1h"].fillna(0).astype(int)
    m["ready_1h"] = m["ready_1h"].astype("boolean").fillna(False).astype(bool)

    n = len(m)
    lo, hi, cl = m["low"].to_numpy(), m["high"].to_numpy(), m["close"].to_numpy()
    e21, r, a = m["ema21"].to_numpy(), m["rsi"].to_numpy(), m["atr"].to_numpy()
    trend = m["trend_1h"].to_numpy()
    sw_lo, sw_hi = m["swing_low_1h"].to_numpy(), m["swing_high_1h"].to_numpy()

    state = np.full(n, STATE_NONE, dtype=object)
    reason = np.full(n, "", dtype=object)
    side_out = np.zeros(n, dtype=int)
    entry = np.full(n, np.nan)
    stop = np.full(n, np.nan)
    tp1 = np.full(n, np.nan)

    active, pb_side, pb_start, extreme, rsi_ext, broken = False, 0, 0, np.nan, np.nan, False

    def levels(s: int, i: int, ext: float) -> tuple[float, float, float]:
        stp = ext - s * cfg.stop_buffer_atr * a[i]
        dist = s * (cl[i] - stp)
        return cl[i], stp, cl[i] + s * cfg.tp1_r * dist

    for i in range(1, n):
        t = trend[i]
        if t == 0 or np.isnan(e21[i]) or np.isnan(r[i]) or np.isnan(r[i - 1]) or np.isnan(a[i]):
            active = False
            continue
        if active and pb_side != t:
            active = False
        s = t
        # "into" the EMA: long = low touches/dips below; short = high touches/pokes above.
        touch = lo[i] <= e21[i] if s == 1 else hi[i] >= e21[i]
        bar_ext = lo[i] if s == 1 else hi[i]
        swing = sw_lo[i] if s == 1 else sw_hi[i]
        breaks_swing = (not np.isnan(swing)) and (bar_ext < swing if s == 1 else bar_ext > swing)

        if not active:
            if touch:
                active, pb_side, pb_start = True, s, i
                extreme, rsi_ext, broken = bar_ext, r[i], breaks_swing
                state[i], side_out[i] = STATE_FORMING, s
                entry[i], stop[i], tp1[i] = levels(s, i, extreme)
            continue

        # pullback in progress: update its extreme, RSI extreme and swing-break flag
        extreme = min(extreme, bar_ext) if s == 1 else max(extreme, bar_ext)
        rsi_ext = min(rsi_ext, r[i]) if s == 1 else max(rsi_ext, r[i])
        broken = broken or breaks_swing

        rsi_ok = rsi_ext < cfg.rsi_long_max if s == 1 else rsi_ext > cfg.rsi_short_min
        closes_back = cl[i] > e21[i] if s == 1 else cl[i] < e21[i]
        rsi_turn = r[i] > r[i - 1] if s == 1 else r[i] < r[i - 1]

        if closes_back and rsi_turn and rsi_ok:
            active = False
            side_out[i] = s
            if broken:
                state[i], reason[i] = STATE_SKIPPED, "pullback broke 1H swing"
                continue
            en, stp, tp = levels(s, i, extreme)
            dist = s * (en - stp)
            entry[i], stop[i], tp1[i] = en, stp, tp
            if dist < cfg.stop_min_atr * a[i]:
                state[i], reason[i] = STATE_SKIPPED, f"stop {dist / a[i]:.2f} ATR < {cfg.stop_min_atr}"
            elif dist > cfg.stop_max_atr * a[i]:
                state[i], reason[i] = STATE_SKIPPED, f"stop {dist / a[i]:.2f} ATR > {cfg.stop_max_atr}"
            else:
                state[i] = STATE_TRIGGERED
            continue

        still_pulling = touch or (cl[i] <= e21[i] if s == 1 else cl[i] >= e21[i])
        if not still_pulling or i - pb_start >= cfg.max_pullback_bars:
            active = False  # bounced away without a valid trigger, or went stale
            continue
        state[i], side_out[i] = STATE_FORMING, s
        entry[i], stop[i], tp1[i] = levels(s, i, extreme)
        if broken:
            reason[i] = "pullback broke 1H swing"

    m["state"], m["side"], m["reason"] = state, side_out, reason
    m["entry"], m["stop"], m["tp1"] = entry, stop, tp1
    m["r_pct"] = (m["entry"] - m["stop"]).abs() / m["entry"] * 100
    return m


def baseline_signals(sig: pd.DataFrame, cfg: Config) -> pd.DataFrame:
    """Plain EMA 9/21 cross on 15m (no trend filter, no stop)."""
    f, s = ema(sig["close"], cfg.baseline_fast), ema(sig["close"], cfg.baseline_slow)
    above = f > s
    valid = f.notna() & s.notna() & f.shift(1).notna() & s.shift(1).notna()
    out = sig[["ts", "open", "high", "low", "close", "atr", "ready_1h"]].copy()
    out["cross_up"] = (above & ~above.shift(1, fill_value=False) & valid).to_numpy()
    out["cross_dn"] = (~above & above.shift(1, fill_value=True) & valid).to_numpy()
    return out


# =============================================================================
# Backtest engine
# =============================================================================
@dataclass(frozen=True)
class Scenario:
    name: str
    entry_fee: float
    entry_slippage: bool


def scenarios(cfg: Config) -> list[Scenario]:
    return [
        Scenario("taker", cfg.taker_fee, True),
        Scenario("maker_entry", cfg.maker_fee, False),  # assumes the limit at the close fills
    ]


def _size(equity: float, entry_px: float, risk_unit: float, cfg: Config) -> float:
    qty = equity * cfg.risk_pct / risk_unit
    return min(qty, equity * cfg.max_leverage / entry_px)


def simulate_strategy(sig: pd.DataFrame, start: int, end: int, cfg: Config, sc: Scenario,
                      inst: str = "", segment: str = "") -> list[dict]:
    """Walk bars [start, end). Entries at the close of 'triggered' bars; exits managed
    from the next bar. Intrabar ambiguity is resolved pessimistically: stop before TP1,
    and a TP1 bar that also reaches breakeven is assumed to stop out the remainder."""
    o, h, l, c = (sig[k].to_numpy() for k in ("open", "high", "low", "close"))
    e21, st = sig["ema21"].to_numpy(), sig["state"].to_numpy()
    sides, stops, tps = sig["side"].to_numpy(), sig["stop"].to_numpy(), sig["tp1"].to_numpy()
    ts = sig["ts"].to_numpy()
    fee_x = cfg.taker_fee
    fee_tp = cfg.maker_fee if cfg.tp1_fee_maker else cfg.taker_fee
    slip = cfg.slippage
    equity = cfg.initial_equity
    trades: list[dict] = []
    pos = None

    def exit_part(px: float, frac_qty: float, fee: float, slipped: bool, reason: str, i: int) -> None:
        s = pos["side"]
        fill = px * (1 - s * slip) if slipped else px
        pos["pnl"] += s * (fill - pos["entry"]) * frac_qty - fee * fill * frac_qty
        pos["fees"] += fee * fill * frac_qty
        pos["exit_notional"] += fill * frac_qty
        pos["qty_open"] -= frac_qty
        pos["reason"] = reason
        pos["exit_i"] = i

    def close_trade() -> None:
        nonlocal equity, pos
        p = pos
        risk_cash = p["qty"] * p["risk_unit"]
        trades.append({
            "inst": inst, "segment": segment, "scenario": sc.name, "strategy": "pullback",
            "side": "long" if p["side"] == 1 else "short",
            "entry_time": pd.to_datetime(ts[p["entry_i"]] + BAR_MS[cfg.entry_bar], unit="ms", utc=True),
            "exit_time": pd.to_datetime(ts[p["exit_i"]] + BAR_MS[cfg.entry_bar], unit="ms", utc=True),
            "entry": p["entry"], "stop": p["stop0"], "tp1": p["tp1"],
            "exit_avg": p["exit_notional"] / p["qty"], "bars": p["exit_i"] - p["entry_i"],
            "tp1_hit": p["tp1_done"], "exit_reason": p["reason"],
            "pnl": p["pnl"], "fees": p["fees"], "R": p["pnl"] / risk_cash,
            "ret": p["pnl"] / p["equity0"],
        })
        equity += p["pnl"]
        pos = None

    for i in range(start, end):
        if pos is not None:
            s = pos["side"]
            # 1) stop (original or breakeven), with gap-through fill at the open
            hit_stop = l[i] <= pos["stop"] if s == 1 else h[i] >= pos["stop"]
            if hit_stop:
                gapped = o[i] <= pos["stop"] if s == 1 else o[i] >= pos["stop"]
                exit_part(o[i] if gapped else pos["stop"], pos["qty_open"], fee_x, True,
                          "breakeven" if pos["tp1_done"] else "stop", i)
                close_trade()
                continue
            # 2) TP1: take partial, move stop to breakeven
            if not pos["tp1_done"] and (h[i] >= pos["tp1"] if s == 1 else l[i] <= pos["tp1"]):
                exit_part(pos["tp1"], pos["qty"] * cfg.tp1_fraction, fee_tp, False, "tp1", i)
                pos["tp1_done"], pos["stop"] = True, pos["entry"]
                if l[i] <= pos["stop"] if s == 1 else h[i] >= pos["stop"]:
                    exit_part(pos["stop"], pos["qty_open"], fee_x, True, "tp1+breakeven", i)
                    close_trade()
                    continue
            # 3) trail remainder on a close beyond EMA21
            if pos["tp1_done"] and (c[i] < e21[i] if s == 1 else c[i] > e21[i]):
                exit_part(c[i], pos["qty_open"], fee_x, True, "tp1+ema_trail", i)
                close_trade()
                continue
            # 4) time stop
            if not pos["tp1_done"] and i - pos["entry_i"] >= cfg.time_stop_bars:
                exit_part(c[i], pos["qty_open"], fee_x, True, "time", i)
                close_trade()
                continue
            if i == end - 1:  # segment boundary: flatten so segments never share a trade
                exit_part(c[i], pos["qty_open"], fee_x, True, "end_of_segment", i)
                close_trade()
            continue

        if st[i] == STATE_TRIGGERED and i < end - 1:
            s = int(sides[i])
            fill = c[i] * (1 + s * slip) if sc.entry_slippage else c[i]
            risk_unit = s * (fill - stops[i])
            if risk_unit <= 0:
                continue
            qty = _size(equity, fill, risk_unit, cfg)
            fee = sc.entry_fee * fill * qty
            pos = {"side": s, "entry": fill, "entry_i": i, "stop": stops[i], "stop0": stops[i],
                   "tp1": tps[i], "qty": qty, "qty_open": qty, "risk_unit": risk_unit,
                   "tp1_done": False, "pnl": -fee, "fees": fee, "exit_notional": 0.0,
                   "equity0": equity, "reason": "", "exit_i": i}
    return trades


def simulate_baseline(base: pd.DataFrame, start: int, end: int, cfg: Config, sc: Scenario,
                      inst: str = "", segment: str = "") -> list[dict]:
    """Always-in-the-market EMA 9/21 cross: enter on cross, exit + reverse on opposite cross."""
    c, a, ts = base["close"].to_numpy(), base["atr"].to_numpy(), base["ts"].to_numpy()
    up, dn = base["cross_up"].to_numpy(), base["cross_dn"].to_numpy()
    slip, equity = cfg.slippage, cfg.initial_equity
    trades, pos = [], None

    def close(i: int, reason: str) -> None:
        nonlocal equity, pos
        s = pos["side"]
        fill = c[i] * (1 - s * slip)
        fee = cfg.taker_fee * fill * pos["qty"]
        pnl = pos["pnl"] + s * (fill - pos["entry"]) * pos["qty"] - fee
        trades.append({
            "inst": inst, "segment": segment, "scenario": sc.name, "strategy": "baseline_ema9_21",
            "side": "long" if s == 1 else "short",
            "entry_time": pd.to_datetime(ts[pos["entry_i"]] + BAR_MS[cfg.entry_bar], unit="ms", utc=True),
            "exit_time": pd.to_datetime(ts[i] + BAR_MS[cfg.entry_bar], unit="ms", utc=True),
            "entry": pos["entry"], "stop": np.nan, "tp1": np.nan, "exit_avg": fill,
            "bars": i - pos["entry_i"], "tp1_hit": False, "exit_reason": reason,
            "pnl": pnl, "fees": pos["fees"] + fee, "R": pnl / (pos["qty"] * pos["risk_unit"]),
            "ret": pnl / pos["equity0"],
        })
        equity += pnl
        pos = None

    for i in range(start, end):
        if pos is not None and ((pos["side"] == 1 and dn[i]) or (pos["side"] == -1 and up[i])):
            close(i, "opposite_cross")
        if pos is None and (up[i] or dn[i]) and i < end - 1 and not np.isnan(a[i]) and a[i] > 0:
            s = 1 if up[i] else -1
            fill = c[i] * (1 + s * slip) if sc.entry_slippage else c[i]
            risk_unit = cfg.baseline_r_atr * a[i]
            qty = _size(equity, fill, risk_unit, cfg)
            fee = sc.entry_fee * fill * qty
            pos = {"side": s, "entry": fill, "entry_i": i, "qty": qty, "risk_unit": risk_unit,
                   "pnl": -fee, "fees": fee, "equity0": equity}
    if pos is not None:
        close(end - 1, "end_of_segment")
    return trades


# =============================================================================
# Metrics
# =============================================================================
def metrics(trades: pd.DataFrame, cfg: Config) -> dict:
    n = len(trades)
    out = {"trades": n, "reliable": n >= cfg.min_trades_reliable}
    if n == 0:
        return out | {"win_rate": np.nan, "avg_R": np.nan, "profit_factor": np.nan,
                      "expectancy_R": np.nan, "expectancy_pct": np.nan, "max_dd_pct": np.nan,
                      "longest_losing_streak": 0, "sum_R": 0.0, "total_return_pct": np.nan}
    t = trades.sort_values("exit_time")
    R, ret = t["R"].to_numpy(), t["ret"].to_numpy()
    wins, losses = R[R > 0], R[R <= 0]
    win_rate = len(wins) / n
    gross_loss = -losses.sum()
    pf = wins.sum() / gross_loss if gross_loss > 0 else np.inf
    expectancy = win_rate * (wins.mean() if len(wins) else 0) + (1 - win_rate) * (losses.mean() if len(losses) else 0)
    # Equity: compound each trade's return-on-equity in exit order. Pooled across
    # instruments this ignores overlap between concurrent positions (approximation).
    eq = np.cumprod(np.concatenate([[1.0], 1 + ret]))
    dd = 1 - eq / np.maximum.accumulate(eq)
    streak = best = 0
    for x in R:
        streak = streak + 1 if x <= 0 else 0
        best = max(best, streak)
    return out | {
        "win_rate": win_rate, "avg_R": R.mean(), "profit_factor": pf, "expectancy_R": expectancy,
        "expectancy_pct": ret.mean() * 100, "max_dd_pct": dd.max() * 100,
        "longest_losing_streak": best, "sum_R": R.sum(), "total_return_pct": (eq[-1] - 1) * 100,
    }


# =============================================================================
# Backtest driver
# =============================================================================
def split_bounds(sig: pd.DataFrame, cfg: Config) -> dict[str, tuple[int, int]]:
    n = len(sig)
    cut = int(n * cfg.is_fraction)
    ready = np.flatnonzero(sig["ready_1h"].to_numpy())
    first = int(ready[0]) if len(ready) else n
    return {"IS": (max(first, 1), cut), "OOS": (max(cut, first), n)}


def backtest_instrument(inst: str, df15: pd.DataFrame, df1h: pd.DataFrame, cfg: Config) -> list[dict]:
    sig = compute_signals(df15, df1h, cfg)
    base = baseline_signals(sig, cfg)
    trades = []
    for seg, (a, b) in split_bounds(sig, cfg).items():
        if b - a < 2:
            continue
        for sc in scenarios(cfg):
            trades += simulate_strategy(sig, a, b, cfg, sc, inst, seg)
            trades += simulate_baseline(base, a, b, cfg, sc, inst, seg)
    return trades


def summarize(trades: pd.DataFrame, cfg: Config, by: list[str]) -> pd.DataFrame:
    rows = []
    for key, g in trades.groupby(by, sort=True):
        key = key if isinstance(key, tuple) else (key,)
        rows.append(dict(zip(by, key)) | metrics(g, cfg))
    return pd.DataFrame(rows)


def _fmt_table(df: pd.DataFrame) -> str:
    d = df.copy()
    for col in ("win_rate",):
        if col in d:
            d[col] = (d[col] * 100).map(lambda x: f"{x:.1f}%" if pd.notna(x) else "-")
    for col in ("avg_R", "profit_factor", "expectancy_R", "sum_R"):
        if col in d:
            d[col] = d[col].map(lambda x: f"{x:.2f}" if pd.notna(x) else "-")
    for col in ("expectancy_pct", "max_dd_pct", "total_return_pct"):
        if col in d:
            d[col] = d[col].map(lambda x: f"{x:.2f}" if pd.notna(x) else "-")
    if "reliable" in d:
        d["reliable"] = d["reliable"].map(lambda x: "" if x else "UNRELIABLE (<%d)" % CONFIG.min_trades_reliable)
    return d.to_string(index=False)


def run_backtest(cfg: Config, insts: list[str] | None, synthetic: bool) -> None:
    out_dir = Path(cfg.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    all_trades: list[dict] = []
    data: dict[str, tuple[pd.DataFrame, pd.DataFrame]] = {}

    if synthetic:
        print("*** SYNTHETIC DATA — pipeline smoke test only, results mean nothing ***")
        for k, name in enumerate(insts or ["SYNTH-A-USDT-SWAP", "SYNTH-B-USDT-SWAP", "SYNTH-C-USDT-SWAP"]):
            data[name] = synthetic_market(cfg.history_days, seed=k)
    else:
        client = OKXPublic(cfg)
        if not insts:
            uni = liquid_universe(client, cfg)
            cutoff = int(time.time() * 1000) - cfg.min_history_days * 86_400_000
            uni = uni[uni["listTime"] < cutoff]
            insts = uni["instId"].head(cfg.backtest_max_instruments).tolist()
            print(f"Universe: {len(insts)} instruments (24h vol > {cfg.min_vol_usdt_24h:,.0f} USDT, "
                  f">= {cfg.min_history_days}d listed). Note: today's liquid list = survivorship bias.")
        start_ms = int(time.time() * 1000) - cfg.history_days * 86_400_000
        for inst in insts:
            try:
                t0 = time.time()
                df1h = load_candles(client, inst, cfg.trend_bar, start_ms, cfg)
                df15 = load_candles(client, inst, cfg.entry_bar, start_ms, cfg)
                print(f"  {inst}: {len(df15)} x 15m, {len(df1h)} x 1H ({time.time() - t0:.0f}s)")
                data[inst] = (df15, df1h)
            except (OKXError, requests.RequestException, ValueError, KeyError) as e:
                print(f"  {inst}: download failed, skipped ({e})")

    for inst, (df15, df1h) in data.items():
        if df15.empty or df1h.empty:
            print(f"  {inst}: no data, skipped")
            continue
        span_days = (df15["ts"].iloc[-1] - df15["ts"].iloc[0]) / 86_400_000
        if span_days < cfg.min_history_days:
            print(f"  {inst}: only {span_days:.0f} days of 15m history (< {cfg.min_history_days}), skipped")
            continue
        all_trades += backtest_instrument(inst, df15, df1h, cfg)
        cut_ts = df15["ts"].iloc[int(len(df15) * cfg.is_fraction)]
        print(f"  {inst}: {span_days:.0f} days; OOS starts {pd.to_datetime(cut_ts, unit='ms', utc=True):%Y-%m-%d %H:%M}")

    if not all_trades:
        print("No trades produced.")
        return
    trades = pd.DataFrame(all_trades)
    agg = summarize(trades, cfg, ["scenario", "segment", "strategy"])
    per_inst = summarize(trades, cfg, ["scenario", "segment", "strategy", "inst"])
    trades.to_csv(out_dir / "backtest_trades.csv", index=False)
    agg.to_csv(out_dir / "backtest_summary.csv", index=False)
    per_inst.to_csv(out_dir / "backtest_by_instrument.csv", index=False)

    print("\n=== Pooled results (all instruments) ===")
    print(f"Costs: taker {cfg.taker_fee:.3%}/side, maker {cfg.maker_fee:.3%}, slippage "
          f"{cfg.slippage:.3%}/taker fill. Risk {cfg.risk_pct:.1%}/trade. Nothing tuned on OOS.")
    for sc in agg["scenario"].unique():
        print(f"\n-- scenario: {sc} --")
        sub = agg[agg["scenario"] == sc].drop(columns="scenario")
        sub = sub.assign(segment=pd.Categorical(sub["segment"], ["IS", "OOS"])).sort_values(["segment", "strategy"])
        # Pooled compounded return ignores position overlap, so only sum_R is shown here (CSV has both).
        print(_fmt_table(sub.drop(columns="total_return_pct")))
    print("\n=== Per instrument, pullback strategy, taker scenario ===")
    pi = per_inst[(per_inst["scenario"] == "taker") & (per_inst["strategy"] == "pullback")]
    print(_fmt_table(pi.drop(columns=["scenario", "strategy"])[
        ["inst", "segment", "trades", "win_rate", "avg_R", "profit_factor", "max_dd_pct",
         "longest_losing_streak", "reliable"]]))
    print(f"\nSaved: {out_dir / 'backtest_summary.csv'}, {out_dir / 'backtest_by_instrument.csv'}, "
          f"{out_dir / 'backtest_trades.csv'}")
    print("Not modelled: funding payments, partial fills, liquidation, concurrent-position margin limits.")


# =============================================================================
# Scanner
# =============================================================================
def scan_instrument(client: OKXPublic, inst: str, cfg: Config) -> dict:
    now = int(time.time() * 1000)
    df1h = load_candles(client, inst, cfg.trend_bar, now - cfg.scan_days_1h * 86_400_000, cfg)
    df15 = load_candles(client, inst, cfg.entry_bar, now - cfg.scan_days_15m * 86_400_000, cfg)
    if len(df1h) < cfg.warmup_bars_1h:
        raise ValueError(f"only {len(df1h)} 1H candles (< warm-up {cfg.warmup_bars_1h})")
    last = compute_signals(df15, df1h, cfg).iloc[-1]
    return {
        "inst": inst,
        "bar_close_utc": pd.to_datetime(last["ts"] + BAR_MS[cfg.entry_bar], unit="ms", utc=True),
        "trend_1h": {1: "BULL", -1: "BEAR"}.get(int(last["trend_1h"]), "none"),
        "adx_1h": last["adx_1h"],
        "state": last["state"],
        "side": {1: "long", -1: "short"}.get(int(last["side"]), ""),
        "entry": last["entry"], "stop": last["stop"], "tp1": last["tp1"], "r_pct": last["r_pct"],
        "rsi_15m": last["rsi"], "note": last["reason"],
    }


def run_scan(cfg: Config) -> None:
    client = OKXPublic(cfg)
    uni = liquid_universe(client, cfg)
    print(f"Scanning {len(uni)} USDT-SWAPs with 24h volume > {cfg.min_vol_usdt_24h:,.0f} USDT ...")
    rows = []
    for _, u in uni.iterrows():
        inst = u["instId"]
        try:
            row = scan_instrument(client, inst, cfg)
            row["funding"] = client.funding_rate(inst)
        except (OKXError, requests.RequestException, ValueError, KeyError) as e:
            print(f"  {inst}: skipped ({e})")
            continue
        direction = {"BULL": 1, "BEAR": -1}.get(row["trend_1h"], 0)
        f = row["funding"]
        # Positive funding: longs pay shorts. "Against" = you would be the one paying a lot.
        row["funding_warn"] = ("FUNDING AGAINST" if not np.isnan(f) and direction * f > cfg.funding_warn_threshold
                               else "")
        row["vol_usdt_24h"] = u["vol_usdt_24h"]
        rows.append(row)
    if not rows:
        print("Nothing to report.")
        return
    df = pd.DataFrame(rows)
    rank = {STATE_TRIGGERED: 0, STATE_FORMING: 1, STATE_SKIPPED: 2, STATE_NONE: 3}
    df["_r"] = df["state"].map(rank)
    df = df.sort_values(["_r", "adx_1h"], ascending=[True, False]).drop(columns="_r")
    out = Path(cfg.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"scan_{time.strftime('%Y%m%d_%H%M', time.gmtime())}.csv"
    df.to_csv(path, index=False)

    show = df.copy()
    show["adx_1h"] = show["adx_1h"].map(lambda x: f"{x:.1f}" if pd.notna(x) else "-")
    show["funding"] = show["funding"].map(lambda x: f"{x * 100:+.4f}%" if pd.notna(x) else "-")
    show["r_pct"] = show["r_pct"].map(lambda x: f"{x:.2f}%" if pd.notna(x) else "")
    for col in ("entry", "stop", "tp1"):
        show[col] = show[col].map(lambda x: f"{x:.6g}" if pd.notna(x) else "")
    show["vol_usdt_24h"] = (show["vol_usdt_24h"] / 1e6).map(lambda x: f"{x:,.0f}M")
    cols = ["inst", "trend_1h", "adx_1h", "state", "side", "entry", "stop", "tp1", "r_pct",
            "funding", "funding_warn", "note", "vol_usdt_24h"]
    print(show[cols].to_string(index=False))
    print("\n'forming' rows: entry = last close, stop = current pullback extreme (indicative only).")
    print(f"Saved {path}")


# =============================================================================
# Synthetic data (offline smoke tests only)
# =============================================================================
def synthetic_market(days: int, seed: int = 0, start_px: float = 100.0) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Regime-switching random walk on 15m bars; 1H bars aggregated from them."""
    rng = np.random.default_rng(seed)
    n = days * 96
    drift = np.zeros(n)
    i = 0
    while i < n:
        length = int(rng.integers(200, 1500))
        drift[i:i + length] = rng.choice([-1, 0, 1]) * rng.uniform(0.0002, 0.0008)
        i += length
    rets = drift + rng.normal(0, 0.004, n)
    close = start_px * np.exp(np.cumsum(rets))
    open_ = np.concatenate([[start_px], close[:-1]])
    wick = np.abs(rng.normal(0, 0.002, (2, n)))
    high = np.maximum(open_, close) * (1 + wick[0])
    low = np.minimum(open_, close) * (1 - wick[1])
    t0 = (int(time.time() * 1000) // BAR_MS["1H"] - days * 24) * BAR_MS["1H"]
    ts = t0 + np.arange(n, dtype=np.int64) * BAR_MS["15m"]
    df15 = pd.DataFrame({"ts": ts, "open": open_, "high": high, "low": low, "close": close})
    g = df15.groupby(df15["ts"] // BAR_MS["1H"])
    df1h = pd.DataFrame({"ts": g["ts"].first(), "open": g["open"].first(), "high": g["high"].max(),
                         "low": g["low"].min(), "close": g["close"].last()}).reset_index(drop=True)
    return df15, df1h


# =============================================================================
# CLI
# =============================================================================
def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description="OKX trend-pullback scanner/backtester (no order placement)")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan", help="live scanner")
    s.add_argument("--min-vol", type=float, help="24h USDT volume filter")
    b = sub.add_parser("backtest", help="historical backtest")
    b.add_argument("--inst", help="comma-separated instIds (default: top liquid by volume)")
    b.add_argument("--days", type=int, help="days of history to fetch")
    b.add_argument("--max-inst", type=int, help="max instruments when --inst is not given")
    b.add_argument("--min-vol", type=float, help="24h USDT volume filter")
    b.add_argument("--risk", type=float, help="risk fraction per trade, e.g. 0.01")
    b.add_argument("--slippage", type=float, help="slippage fraction per taker fill")
    b.add_argument("--synthetic", action="store_true", help="use generated data (offline smoke test)")
    args = p.parse_args(argv)

    overrides = {k: v for k, v in {
        "min_vol_usdt_24h": getattr(args, "min_vol", None),
        "history_days": getattr(args, "days", None),
        "backtest_max_instruments": getattr(args, "max_inst", None),
        "risk_pct": getattr(args, "risk", None),
        "slippage": getattr(args, "slippage", None),
    }.items() if v is not None}
    cfg = replace(CONFIG, **overrides)

    if args.cmd == "scan":
        run_scan(cfg)
    else:
        insts = [x.strip() for x in args.inst.split(",")] if args.inst else None
        run_backtest(cfg, insts, args.synthetic)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
