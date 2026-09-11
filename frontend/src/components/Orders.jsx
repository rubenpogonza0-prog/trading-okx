import { useState } from "react";
import { api } from "../api.js";
import { useAutoRefresh } from "../useAutoRefresh.js";

export default function Orders() {
  const [tab, setTab] = useState("pending");
  const fetcher = tab === "pending" ? () => api.pendingOrders("SWAP") : () => api.orderHistory("SWAP");
  const { data, error, loading } = useAutoRefresh(fetcher, 10000);

  return (
    <section className="card">
      <h2>Orders</h2>
      <div className="tabs">
        <button className={tab === "pending" ? "active" : ""} onClick={() => setTab("pending")}>
          Open
        </button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
          History (7d)
        </button>
      </div>
      {loading && <p>Loading…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !error && (
        <table>
          <thead>
            <tr>
              <th>Instrument</th>
              <th>Side</th>
              <th>Type</th>
              <th>Size</th>
              <th>Price</th>
              <th>State</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((o) => (
              <tr key={o.ordId}>
                <td>{o.instId}</td>
                <td className={o.side === "buy" ? "long" : "short"}>{o.side}</td>
                <td>{o.ordType}</td>
                <td>{o.sz}</td>
                <td>{o.px && Number(o.px) > 0 ? Number(o.px).toFixed(4) : "market"}</td>
                <td>{o.state}</td>
                <td>{new Date(Number(o.cTime)).toLocaleString()}</td>
              </tr>
            ))}
            {(data ?? []).length === 0 && (
              <tr>
                <td colSpan={7}>No orders</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}
