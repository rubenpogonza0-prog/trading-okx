import { api } from "../api.js";
import { useAutoRefresh } from "../useAutoRefresh.js";

export default function Balances() {
  const { data, error, loading } = useAutoRefresh(api.balance, 15000);

  if (loading) return <section className="card"><h2>Balance</h2><p>Loading…</p></section>;
  if (error) return <section className="card"><h2>Balance</h2><p className="error">{error}</p></section>;

  const account = data?.[0];
  const details = account?.details?.filter((d) => Number(d.eq) > 0) ?? [];

  return (
    <section className="card">
      <h2>Balance</h2>
      <p className="total-eq">Total equity: {account ? Number(account.totalEq).toFixed(2) : "—"} USD</p>
      <table>
        <thead>
          <tr>
            <th>Asset</th>
            <th>Equity</th>
            <th>Available</th>
            <th>Frozen</th>
          </tr>
        </thead>
        <tbody>
          {details.map((d) => (
            <tr key={d.ccy}>
              <td>{d.ccy}</td>
              <td>{Number(d.eq).toFixed(4)}</td>
              <td>{Number(d.availEq || d.availBal).toFixed(4)}</td>
              <td>{Number(d.frozenBal).toFixed(4)}</td>
            </tr>
          ))}
          {details.length === 0 && (
            <tr>
              <td colSpan={4}>No balances</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
