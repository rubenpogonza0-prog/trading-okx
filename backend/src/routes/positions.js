import { Router } from "express";

export function positionsRouter(okx) {
  const router = Router();

  // Open positions. instType defaults to SWAP (perpetuals); pass ?instType=FUTURES for expiry futures.
  router.get("/", async (req, res, next) => {
    try {
      const instType = req.query.instType || "SWAP";
      const data = await okx.get("/api/v5/account/positions", { instType });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
