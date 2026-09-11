import { Router } from "express";

export function balanceRouter(okx) {
  const router = Router();

  // Trading account balance (funds available for spot/margin/swap/futures trading)
  router.get("/", async (req, res, next) => {
    try {
      const data = await okx.get("/api/v5/account/balance");
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
