import { Router } from "express";

export function ordersRouter(okx) {
  const router = Router();

  // Currently open (pending) orders
  router.get("/pending", async (req, res, next) => {
    try {
      const instType = req.query.instType || "SWAP";
      const data = await okx.get("/api/v5/trade/orders-pending", { instType });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // Order history for the last 7 days
  router.get("/history", async (req, res, next) => {
    try {
      const instType = req.query.instType || "SWAP";
      const data = await okx.get("/api/v5/trade/orders-history", { instType });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
