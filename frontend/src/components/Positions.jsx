import { api } from "../api.js";
import { useAutoRefresh } from "../useAutoRefresh.js";

export default function Positions() {
  const { data, error, loading } = useAutoRefresh(() => api.positions("SWAP"), 10000);

  if (loading) return <section className="card"><h2>Open Positions (Swap)</h2><p>Loading…</p></section>;
  if (error) return <section className="card"><h2>Open Positions (Swap)</h2><p className="error">{error}</p></section>;

  const positions = (data ?? []).filter((p) => Number(p.pos) !== 0);

  return (
    <section className="card">
      <h2>Open Positions (Swap)</h2>
      <table>
        <thead>
          <tr>
            <th>Instrument</th>
            <th>Side</th>
            <th>Size</th>
            <th>Entry</th>
            <th>Mark</th>
            <th>uPnL</th>
            <th>Leverage</th>
            <th>Liq. Price</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const pnl = Number(p.upl);
            return (
              <tr key={p.posId}>
                <td>{p.instId}</td>
                <td className={Number(p.pos) > 0 ? "long" : "short"}>
                  {p.posSide !== "net" ? p.posSide : Number(p.pos) > 0 ? "long" : "short"}
                </td>
                <td>{p.pos}</td>
                <td>{Number(p.avgPx).toFixed(4)}</td>
                <td>{Number(p.markPx).toFixed(4)}</td>
                <td className={pnl >= 0 ? "positive" : "negative"}>{pnl.toFixed(4)}</td>
                <td>{p.lever}x</td>
                <td>{p.liqPx ? Number(p.liqPx).toFixed(4) : "—"}</td>
              </tr>
            );
          })}
          {positions.length === 0 && (
            <tr>
              <td colSpan={8}>No open positions</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
