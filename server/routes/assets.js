import { Router } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { readJson, writeJson, P, httpError, inside } from "../lib/store.js";
import { walk, saveBase64 } from "../lib/media.js";

const r = Router();

// GET / -> files under assets/ merged with tags from assets.json
r.get("/", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    const files = await walk(P.assets(dir));
    const index = await readJson(P.assetsIndex(dir), {});
    res.json({ dir: P.assets(dir), files: files.map((f) => ({ ...f, path: "assets/" + f.path, ...(index["assets/" + f.path] || { kind: null, note: "" }) })) });
  } catch (e) { next(e); }
});

// PUT /tag { path, kind: plate|prop|style|wardrobe|other|null, note }
r.put("/tag", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    const { path: p, kind = null, note = "" } = req.body;
    if (!p) throw httpError(400, "path required");
    const index = await readJson(P.assetsIndex(dir), {});
    index[p] = { kind, note };
    await writeJson(P.assetsIndex(dir), index);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /upload { name, data (base64) } -> saves into assets/
r.post("/upload", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    const { name, data } = req.body;
    if (!name || !data) throw httpError(400, "name and data required");
    const abs = inside(dir, path.join("assets", path.basename(name)));
    await saveBase64(abs, data);
    res.status(201).json({ path: "assets/" + path.basename(name) });
  } catch (e) { next(e); }
});

r.delete("/", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    const abs = inside(dir, req.query.path || "");
    if (!String(req.query.path).startsWith("assets/")) throw httpError(400, "Only assets/ files can be deleted here");
    await fs.unlink(abs);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
