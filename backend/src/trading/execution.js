import { setLeverage, getAccountConfig } from "./marketData.js";

function roundToTick(price, tickSz) {
  const tick = Number(tickSz);
  return Math.round(price / tick) * tick;
}

function decimalsOf(tickSz) {
  const s = String(tickSz);
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

// Places the entry order with TP and SL attached in the same call
// (OKX `attachAlgoOrds`) so a position is never live without protection.
// `plan` comes from strategy.evaluateSymbol, `sizing` from riskManager.sizePosition.
export async function executeTrade(okx, { instId, plan, sizing, instrument, mgnMode = "cross" }) {
  await setLeverage(okx, { instId, lever: sizing.leverage, mgnMode });

  const cfg = await getAccountConfig(okx);
  const hedgeMode = cfg.posMode === "long_short_mode";

  const decimals = decimalsOf(instrument.tickSz);
  const tp = roundToTick(plan.tp, instrument.tickSz).toFixed(decimals);
  const sl = roundToTick(plan.sl, instrument.tickSz).toFixed(decimals);
  const clOrdIdBase = `bot${Date.now()}`.slice(0, 32);

  const order = {
    instId,
    tdMode: mgnMode,
    side: plan.signal === "long" ? "buy" : "sell",
    ordType: "market",
    sz: String(sizing.size),
    attachAlgoOrds: [
      {
        attachAlgoClOrdId: clOrdIdBase,
        tpTriggerPx: tp,
        tpOrdPx: "-1",
        tpTriggerPxType: "last",
        slTriggerPx: sl,
        slOrdPx: "-1",
        slTriggerPxType: "last",
      },
    ],
  };
  if (hedgeMode) {
    order.posSide = plan.signal === "long" ? "long" : "short";
  }

  const [result] = await okx.post("/api/v5/trade/order", order);
  return { orderId: result.ordId, clOrdId: result.clOrdId, request: order };
}

// Flattens a stale scalp: cancels its pending SL/TP algo orders first (so
// they don't dangle against a position that's about to be closed), then
// closes the remaining position at market. Used when shouldCloseStale()
// says momentum is gone and the setup no longer justifies staying in.
export async function closeStalePosition(okx, { instId, posSide, mgnMode = "cross" }) {
  const pending = await okx.get("/api/v5/trade/orders-algo-pending", {
    instType: "SWAP",
    instId,
  });
  if (pending.length) {
    await okx.post(
      "/api/v5/trade/cancel-algos",
      pending.map((o) => ({ instId, algoId: o.algoId }))
    );
  }

  const cfg = await getAccountConfig(okx);
  const hedgeMode = cfg.posMode === "long_short_mode";
  const closeReq = { instId, mgnMode };
  if (hedgeMode) closeReq.posSide = posSide;

  return okx.post("/api/v5/trade/close-position", closeReq);
}
