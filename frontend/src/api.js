async function get(path, params) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(`/api${path}${qs}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request to ${path} failed (${res.status})`);
  }
  return res.json();
}

export const api = {
  balance: () => get("/balance"),
  positions: (instType = "SWAP") => get("/positions", { instType }),
  pendingOrders: (instType = "SWAP") => get("/orders/pending", { instType }),
  orderHistory: (instType = "SWAP") => get("/orders/history", { instType }),
};
