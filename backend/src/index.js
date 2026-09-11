import "dotenv/config";
import express from "express";
import cors from "cors";
import { okxClientFromEnv } from "./okxClient.js";
import { balanceRouter } from "./routes/balance.js";
import { positionsRouter } from "./routes/positions.js";
import { ordersRouter } from "./routes/orders.js";
import { tradingRouter } from "./routes/trading.js";

const app = express();
// This backend can place real orders (via /api/trading/run-cycle), so CORS is
// restricted to local dev origins by default. Never widen this to `cors()`
// (all origins) if you deploy the backend anywhere reachable from the internet.
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:5173").split(",");
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

const okx = okxClientFromEnv();

app.use("/api/balance", balanceRouter(okx));
app.use("/api/positions", positionsRouter(okx));
app.use("/api/orders", ordersRouter(okx));
app.use("/api/trading", tradingRouter());

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(502).json({ error: err.message, code: err.okxCode });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`OKX dashboard backend listening on http://localhost:${port}`);
});
