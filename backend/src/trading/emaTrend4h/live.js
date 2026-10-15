// Live cycle for the "ema_trend_4h" strategy (STRATEGY=ema_trend_4h).
// Designed to run every hour: signals only change when a 4H candle closes,
// so each instrument's newest closed candle is processed exactly once
// (state.emaTrend4h.lastBarTs); the other hourly runs just verify that every
// open position still has its stop order on the exchange.
import { okxClientFromEnv } from "../../okxClient.js";
import { getAccountConfig, getOpenPositions } from "../marketData.js";
import { selectUniverse } from "../universe.js";
import { loadState, saveState, appendCycleLog } from "../state.js";
import { fetchClosedCandles } from "./candles.js";
import { SIGNAL_PARAMS, loadRuntimeConfig } from "./config.js";
import {
  computeIndicators,
  evaluateBar,
  initialStop,
  trailStop,
  stopHit,
  crossExit,
  riskNotional,
} from "./signals.js";

const MGN_MODE = "isolated";
const MIN_CANDLES = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decimalsOf(step) {
  const s = String(step);
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

function fmtPrice(px, tickSz) {
  const tick = Number(tickSz);
  return (Math.round(px / tick) * tick).toFixed(decimalsOf(tickSz));
}

export function contractsFor({ notional, price, instrument }) {
  const ctVal = Number(instrument.ctVal);
  const lotSz = Number(instrument.lotSz);
  const raw = notional / (ctVal * price);
  const lots = Math.floor(raw / lotSz + 1e-9);
  const size = Number((lots * lotSz).toFixed(decimalsOf(instrument.lotSz)));
  return { size, notional: size * ctVal * price, ok: size >= Number(instrument.minSz) && size > 0 };
}

async function getUsdtEquity(okx) {
  const [acct] = await okx.get("/api/v5/account/balance", { ccy: "USDT" });
  const usdt = acct?.details?.find((d) => d.ccy === "USDT");
  const equity = Number(usdt?.eq || 0);
  const available = Number(usdt?.availEq || usdt?.availBal || 0);
  return { equity, available };
}

async function getInstrument(okx, instId) {
  const [inst] = await okx.get("/api/v5/public/instruments", { instType: "SWAP", instId });
  if (!inst) throw new Error(`instrument ${instId} not found`);
  return inst;
}

async function pendingStopOrders(okx, instId) {
  const out = [];
  for (const ordType of ["conditional", "oco"]) {
    const rows = await okx.get("/api/v5/trade/orders-algo-pending", { instType: "SWAP", instId, ordType });
    out.push(...rows.filter((o) => o.slTriggerPx));
  }
  return out;
}

async function placeStopOrder(okx, { instId, side, stop, instrument, hedgeMode }) {
  const req = {
    instId,
    tdMode: MGN_MODE,
    side: side === "long" ? "sell" : "buy",
    ordType: "conditional",
    slTriggerPx: fmtPrice(stop, instrument.tickSz),
    slOrdPx: "-1",
    slTriggerPxType: "last",
    closeFraction: "1",
  };
  if (hedgeMode) req.posSide = side;
  else req.reduceOnly = true;
  const [res] = await okx.post("/api/v5/trade/order-algo", req);
  return res.algoId;
}

// Moves the exchange stop to `stop`. Amends in place when possible; if the
// amend is rejected, places the new stop BEFORE cancelling the old one so
// the position is never unprotected.
async function moveStop(okx, { instId, side, stop, instrument, hedgeMode }) {
  const existing = await pendingStopOrders(okx, instId);
  const newPx = fmtPrice(stop, instrument.tickSz);
  if (existing.length === 1) {
    try {
      await okx.post("/api/v5/trade/amend-algos", {
        instId,
        algoId: existing[0].algoId,
        newSlTriggerPx: newPx,
        newSlOrdPx: "-1",
      });
      return "amended";
    } catch {
      // fall through to replace
    }
  }
  await placeStopOrder(okx, { instId, side, stop, instrument, hedgeMode });
  if (existing.length) {
    await okx.post(
      "/api/v5/trade/cancel-algos",
      existing.map((o) => ({ instId, algoId: o.algoId }))
    );
  }
  return "replaced";
}

async function closePosition(okx, { instId, side, hedgeMode }) {
  const pending = await pendingStopOrders(okx, instId);
  if (pending.length) {
    await okx.post(
      "/api/v5/trade/cancel-algos",
      pending.map((o) => ({ instId, algoId: o.algoId }))
    );
  }
  const req = { instId, mgnMode: MGN_MODE };
  if (hedgeMode) req.posSide = side;
  await okx.post("/api/v5/trade/close-position", req);
}

async function openPosition(okx, { instId, side, size, stop, leverage, instrument, hedgeMode }) {
  const lev = { instId, lever: String(leverage), mgnMode: MGN_MODE };
  if (hedgeMode) lev.posSide = side;
  await okx.post("/api/v5/account/set-leverage", lev);

  const order = {
    instId,
    tdMode: MGN_MODE,
    side: side === "long" ? "buy" : "sell",
    ordType: "market",
    sz: String(size),
    attachAlgoOrds: [
      {
        attachAlgoClOrdId: `ema4h${Date.now()}`.slice(0, 32),
        slTriggerPx: fmtPrice(stop, instrument.tickSz),
        slOrdPx: "-1",
        slTriggerPxType: "last",
      },
    ],
  };
  if (hedgeMode) order.posSide = side;
  const [res] = await okx.post("/api/v5/trade/order", order);
  return res.ordId;
}

export async function runEmaTrend4hCycle({ dryRun = false, okx = okxClientFromEnv() } = {}) {
  const cfg = loadRuntimeConfig();
  const now = Date.now();
  const report = {
    strategy: "ema_trend_4h",
    startedAt: new Date(now).toISOString(),
    dryRun,
    trades: [], // actions taken (open / close / stop moved)
    skipped: [], // instruments evaluated without action, with the reason
    noTrade: true,
  };

  const state = await loadState();
  const st = (state.emaTrend4h ??= { lastBarTs: {}, positions: {} });

  const accountConfig = await getAccountConfig(okx);
  // acctLv "1" is OKX's Spot mode, where perpetual swaps can't be traded at all.
  if (accountConfig.acctLv === "1") {
    throw new Error(
      "OKX account is in Spot mode (acctLv 1): perpetual swaps can't be traded. " +
        "Switch the account mode to Futures (or a margin mode) in OKX settings" +
        (process.env.OKX_DEMO === "1" ? " — in Demo trading, the demo account has its own setting." : ".")
    );
  }
  const hedgeMode = accountConfig.posMode === "long_short_mode";
  const livePositions = (await getOpenPositions(okx)).filter((p) => Number(p.pos) !== 0);
  const liveById = new Map(livePositions.map((p) => [p.instId, p]));
  let { equity, available } = await getUsdtEquity(okx);
  report.equityUsdt = equity;

  // Positions the exchange closed since the last run (their stop fired).
  for (const [instId, tracked] of Object.entries(st.positions)) {
    if (liveById.has(instId)) continue;
    report.trades.push({ instId, action: "closed-by-exchange-stop", side: tracked.side, entry: tracked.entry, stop: tracked.stop });
    delete st.positions[instId];
  }

  let exposure = livePositions.reduce((a, p) => a + Math.abs(Number(p.notionalUsd || 0)), 0);
  const openCount = () => livePositions.length + report.trades.filter((t) => t.action === "open").length
    - report.trades.filter((t) => t.action === "close").length;

  // Universe: tracked positions first (they must always be managed), then candidates.
  const instruments = new Map();
  for (const instId of Object.keys(st.positions)) instruments.set(instId, null);
  if (cfg.instruments === "auto") {
    for (const c of await selectUniverse(okx, { topN: cfg.universeTopN })) {
      if (!instruments.get(c.instId)) instruments.set(c.instId, c.instrument);
    }
  } else {
    for (const instId of cfg.instruments) if (!instruments.has(instId)) instruments.set(instId, null);
  }

  for (let [instId, instrument] of instruments) {
    try {
      instrument ??= await getInstrument(okx, instId);
      const tracked = st.positions[instId];
      const live = liveById.get(instId);

      // Cheap check first: has a new 4H candle closed since the last run?
      const latest = await okx.get("/api/v5/market/candles", { instId, bar: SIGNAL_PARAMS.bar, limit: 3 });
      const latestClosedTs = Math.max(...latest.filter((r) => r[8] === "1").map((r) => Number(r[0])));

      if (st.lastBarTs[instId] === latestClosedTs) {
        // Candle already processed — just make sure the stop is still there.
        if (tracked && !dryRun && (await pendingStopOrders(okx, instId)).length === 0) {
          await placeStopOrder(okx, { instId, side: tracked.side, stop: tracked.stop, instrument, hedgeMode });
          report.trades.push({ instId, action: "stop-restored", side: tracked.side, stop: tracked.stop });
        } else {
          report.skipped.push({ instId, reason: "4H candle already processed" });
        }
        continue;
      }

      const candles = await fetchClosedCandles(okx, instId, SIGNAL_PARAMS.bar, cfg.candlesToLoad);
      if (candles.length < MIN_CANDLES) {
        report.skipped.push({ instId, reason: `only ${candles.length} closed 4H candles (need ${MIN_CANDLES})` });
        continue;
      }
      const lastTs = candles[candles.length - 1].ts;

      const ind = computeIndicators(candles.map((c) => c.close));
      const bar = evaluateBar(ind, candles.length - 1);
      const values = Object.fromEntries(Object.entries(bar.values).map(([k, v]) => [k, Number(v.toPrecision(6))]));
      const candleTime = new Date(lastTs).toISOString();

      if (tracked) {
        const newStop = trailStop(tracked.side, tracked.stop, bar.close, bar.vol);
        const exitReason = stopHit(tracked.side, newStop, bar.close)
          ? "close beyond stop"
          : crossExit(tracked.side, bar)
            ? `opposite EMA${SIGNAL_PARAMS.fast}/${SIGNAL_PARAMS.slow} cross`
            : null;
        if (exitReason) {
          if (!dryRun) await closePosition(okx, { instId, side: tracked.side, hedgeMode });
          report.trades.push({ instId, action: "close", side: tracked.side, reason: exitReason, close: bar.close, candleTime, values, dryRun });
          exposure -= Math.abs(Number(live?.notionalUsd || tracked.notional || 0));
          delete st.positions[instId];
        } else if (newStop !== tracked.stop) {
          if (!dryRun) await moveStop(okx, { instId, side: tracked.side, stop: newStop, instrument, hedgeMode });
          report.trades.push({ instId, action: "stop-moved", side: tracked.side, from: tracked.stop, to: newStop, candleTime, dryRun });
          tracked.stop = newStop;
        } else {
          report.skipped.push({ instId, reason: `holding ${tracked.side}, stop unchanged at ${tracked.stop}` });
        }
      }

      if (!st.positions[instId] && (bar.enterLong || bar.enterShort)) {
        const side = bar.enterLong ? "long" : "short";
        const skip = (reason) => report.skipped.push({ instId, reason: `${side} signal but ${reason}`, values });
        if (live && !tracked) skip("a position not opened by this bot is already open on it");
        else if (openCount() >= cfg.maxOpenPositions) skip(`max ${cfg.maxOpenPositions} open positions reached`);
        else {
          const stop = initialStop(side, bar.close, bar.vol);
          let notional = riskNotional({ equity, entry: bar.close, stop, riskPerTrade: cfg.riskPerTrade, maxLeverage: cfg.maxLeverage });
          notional = Math.min(notional, equity * cfg.maxTotalExposure - exposure, available * cfg.maxLeverage * 0.95);
          const sized = contractsFor({ notional, price: bar.close, instrument });
          if (!sized.ok) skip(`size ${notional.toFixed(2)} USDT is below the minimum contract (${instrument.minSz})`);
          else {
            const trade = {
              instId, action: "open", side, entry: bar.close, stop, size: sized.size,
              notionalUsdt: Number(sized.notional.toFixed(2)), leverage: cfg.maxLeverage,
              riskUsdt: Number(((sized.notional * Math.abs(bar.close - stop)) / bar.close).toFixed(2)),
              candleTime, values, dryRun,
            };
            if (!dryRun) {
              trade.orderId = await openPosition(okx, { instId, side, size: sized.size, stop, leverage: cfg.maxLeverage, instrument, hedgeMode });
              st.positions[instId] = { side, entry: bar.close, stop, size: sized.size, notional: sized.notional, openedAt: new Date().toISOString(), orderId: trade.orderId };
            }
            exposure += sized.notional;
            available -= sized.notional / cfg.maxLeverage;
            report.trades.push(trade);
          }
        }
      } else if (!tracked) {
        report.skipped.push({ instId, reason: "no signal", values });
      }

      st.lastBarTs[instId] = lastTs;
    } catch (err) {
      report.skipped.push({ instId, reason: `error: ${err.message}${err.okxCode ? ` (OKX ${err.okxCode})` : ""}` });
    }
    await sleep(150);
  }

  report.noTrade = !report.trades.some((t) => t.action === "open");
  if (!dryRun) {
    await saveState(state);
    await appendCycleLog(report);
  }
  return report;
}

export function printEmaTrend4hReport(report) {
  console.log(`ema_trend_4h cycle${report.dryRun ? " (dry-run, no orders sent)" : ""} — equity ${report.equityUsdt} USDT`);
  if (!report.trades.length) console.log("No action this cycle.");
  for (const t of report.trades) {
    const parts = Object.entries(t)
      .filter(([k]) => !["instId", "action", "values", "dryRun"].includes(k))
      .map(([k, v]) => `${k}=${v}`);
    console.log(`  ${t.instId} ${t.action.toUpperCase()} ${parts.join(" ")}`);
  }
  for (const s of report.skipped) console.log(`  ${s.instId}: ${s.reason}`);
}
