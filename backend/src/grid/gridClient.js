// Thin wrappers around OKX's Grid Trading REST endpoints
// (/api/v5/tradingBot/grid/*), signed with the env-var credentials via the
// shared okxClient. This is the unattended/CI execution path (GitHub
// Actions, a VPS scheduler) — the same account credentials used by the rest
// of backend/src/trading/.
//
// IMPORTANT: verify these paths against OKX's current V5 API docs
// (https://www.okx.com/docs-v5/) before running against a LIVE account —
// exchange APIs occasionally change field/endpoint names. Always run with
// OKX_DEMO=1 (simulated trading) first; see CLAUDE.md.

const BASE = "/api/v5/tradingBot/grid";

// direction/lever/sz only apply to algoOrdType "contract_grid". For a
// neutral grid, omit direction/lever/sz and slRatio/tpRatio are used
// instead of price-based triggers.
export async function createContractGrid(
  okx,
  {
    instId,
    lower,
    upper,
    gridNum,
    direction, // "long" | "short" | "neutral"
    leverage,
    marginUsdt,
    runType = "1", // arithmetic
    basePos, // open initial position immediately for long/short
    tpTriggerPx,
    slTriggerPx,
    slRatio,
    algoClOrdId,
  }
) {
  const body = {
    instId,
    algoOrdType: "contract_grid",
    maxPx: String(upper),
    minPx: String(lower),
    gridNum: String(gridNum),
    runType,
    direction,
    lever: String(leverage),
    sz: String(marginUsdt),
  };
  if (basePos !== undefined) body.basePos = basePos;
  if (tpTriggerPx !== undefined) body.tpTriggerPx = String(tpTriggerPx);
  if (slTriggerPx !== undefined) body.slTriggerPx = String(slTriggerPx);
  if (slRatio !== undefined) body.slRatio = String(slRatio);
  if (algoClOrdId) body.algoClOrdId = algoClOrdId;

  const [result] = await okx.post(`${BASE}/order-algo`, body);
  return result; // { algoId, algoClOrdId, sCode, sMsg }
}

// stopType "1" = market-close everything (default, safe exit);
// "2" = cancel grid orders but leave any open position (manual follow-up needed).
export async function stopGrid(okx, { algoId, instId, algoOrdType = "contract_grid", stopType = "1" }) {
  const [result] = await okx.post(`${BASE}/stop-order-algo`, [
    { algoId, instId, algoOrdType, stopType },
  ]);
  return result;
}

export async function amendGrid(okx, { algoId, instId, slTriggerPx, tpTriggerPx, algoOrdType = "contract_grid" }) {
  const body = { algoId, instId, algoOrdType };
  if (slTriggerPx !== undefined) body.slTriggerPx = String(slTriggerPx);
  if (tpTriggerPx !== undefined) body.tpTriggerPx = String(tpTriggerPx);
  const [result] = await okx.post(`${BASE}/amend-order-algo`, body);
  return result;
}

export async function closeGridPosition(okx, { algoId, mktClose = true, sz, px }) {
  const body = { algoId, mktClose: String(mktClose) };
  if (!mktClose) {
    body.sz = String(sz);
    body.px = String(px);
  }
  const [result] = await okx.post(`${BASE}/close-position`, body);
  return result;
}

export async function getPendingGridOrders(okx, { algoOrdType = "contract_grid", instId } = {}) {
  return okx.get(`${BASE}/orders-algo-pending`, { algoOrdType, instId });
}

export async function getGridOrderHistory(okx, { algoOrdType = "contract_grid", instId } = {}) {
  return okx.get(`${BASE}/orders-algo-history`, { algoOrdType, instId });
}

export async function getGridOrderDetails(okx, { algoId, algoOrdType = "contract_grid" }) {
  const [result] = await okx.get(`${BASE}/orders-algo-details`, { algoId, algoOrdType });
  return result;
}

export async function getGridPositions(okx, { algoId, algoOrdType = "contract_grid" }) {
  return okx.get(`${BASE}/positions`, { algoId, algoOrdType });
}
