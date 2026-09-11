import { useState } from "react";
import { api } from "../api.js";
import { useAutoRefresh } from "../useAutoRefresh.js";

export default function TradingBot() {
  const { data: state, reload: reloadState } = useAutoRefresh(api.botState, 20000);
  const { data: log, reload: reloadLog } = useAutoRefresh(api.botLog, 20000);
  const [running, setRunning] = useState(false);
  const [lastDryRun, setLastDryRun] = useState(null);

  const botPositions = state ? Object.entries(state.positions) : [];

  async function handleDryRun() {
    setRunning(true);
    try {
      const report = await api.runCycleDryRun();
      setLastDryRun(report);
    } catch (err) {
      setLastDryRun({ error: err.message });
    } finally {
      setRunning(false);
      reloadState();
      reloadLog();
    }
  }

  return (
    <section className="card">
      <h2>Autonomous Strategy Engine</h2>
      <p className="hint">
        Live automated trading runs from <code>npm run trade:scheduler</code> on the backend
        (hourly, real orders). This panel only reads its state and can trigger a{" "}
        <strong>dry run</strong> — no order is ever placed from here.
      </p>

      <button onClick={handleDryRun} disabled={running}>
        {running ? "Running dry-run cycle…" : "Run dry-run cycle now"}
      </button>

      {lastDryRun && (
        <div className="dry-run-result">
          {lastDryRun.error && <p className="error">{lastDryRun.error}</p>}
          {lastDryRun.trades && lastDryRun.trades.length === 0 && (
            <p>NO TRADE — no setup currently meets the required criteria.</p>
          )}
          {lastDryRun.trades?.map((t) => (
            <div key={t.instId} className="trade-card">
              <strong>
                {t.instId} — {t.side}
              </strong>
              <div>Entry: {t.entry} · SL: {t.sl} · TP: {t.tp}</div>
              <div>Leverage: {t.leverage}x · Margin: {t.marginUsdt} USDT · R:R 1:{t.rr}</div>
              <div className="reasons">{t.reasons.join(" · ")}</div>
            </div>
          ))}
        </div>
      )}

      <h3>Bot-managed positions</h3>
      <table>
        <thead>
          <tr>
            <th>Instrument</th>
            <th>Side</th>
            <th>Entry</th>
            <th>SL</th>
            <th>TP</th>
            <th>Opened</th>
          </tr>
        </thead>
        <tbody>
          {botPositions.map(([instId, p]) => (
            <tr key={instId}>
              <td>{instId}</td>
              <td className={p.side}>{p.side}</td>
              <td>{p.entry}</td>
              <td>{p.sl}</td>
              <td>{p.tp}</td>
              <td>{new Date(p.openedAt).toLocaleString()}</td>
            </tr>
          ))}
          {botPositions.length === 0 && (
            <tr>
              <td colSpan={6}>No bot-managed positions open</td>
            </tr>
          )}
        </tbody>
      </table>

      <h3>Recent cycles</h3>
      <ul className="cycle-log">
        {(log ?? []).map((entry, i) => (
          <li key={i}>
            <span className="ts">{new Date(entry.startedAt).toLocaleString()}</span>{" "}
            {entry.noTrade
              ? "NO TRADE"
              : `${entry.trades.length} trade(s) opened`}{" "}
            ({entry.skipped.length} skipped)
          </li>
        ))}
        {(log ?? []).length === 0 && <li>No cycles logged yet</li>}
      </ul>
    </section>
  );
}
