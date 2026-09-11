import "dotenv/config";
import express from "express";
import cors from "cors";
import { okxClientFromEnv } from "./okxClient.js";
import { balanceRouter } from "./routes/balance.js";
import { positionsRouter } from "./routes/positions.js";
import { ordersRouter } from "./routes/orders.js";

const app = express();
app.use(cors());
app.use(express.json());

const okx = okxClientFromEnv();

app.use("/api/balance", balanceRouter(okx));
app.use("/api/positions", positionsRouter(okx));
app.use("/api/orders", ordersRouter(okx));

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(502).json({ error: err.message, code: err.okxCode });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`OKX dashboard backend listening on http://localhost:${port}`);
});
