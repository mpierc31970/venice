import { Router } from "express";
import { models, summarize } from "../lib/modelcache.js";
import { listAllTextModels } from "../lib/providers.js";

const r = Router();

// GET /api/models?type=text|image|video|tts|upscale|all&force=1
r.get("/", async (req, res, next) => {
  try {
    const type = req.query.type || "all";
    if (type === "text") return res.json(await listAllTextModels());
    const list = await models(type, req.query.force === "1");
    res.json(list.map(summarize));
  } catch (e) { next(e); }
});

export default r;
