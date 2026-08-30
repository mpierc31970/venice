import { Router } from "express";
import { getBalance } from "../venice.js";
import { getSettings, updateSettings } from "../lib/registry.js";

const r = Router();

// GET /api/billing -> { usd, diem, canConsume, settings }
r.get("/", async (_req, res, next) => {
  try {
    const [b, settings] = await Promise.all([getBalance(), getSettings()]);
    res.json({
      usd: b.balances?.usd ?? null,
      diem: b.balances?.diem ?? null,
      canConsume: b.canConsume,
      currency: b.consumptionCurrency,
      settings,
    });
  } catch (e) { next(e); }
});

r.get("/settings", async (_req, res, next) => {
  try { res.json(await getSettings()); } catch (e) { next(e); }
});
r.put("/settings", async (req, res, next) => {
  try { res.json(await updateSettings(req.body || {})); } catch (e) { next(e); }
});

export default r;
