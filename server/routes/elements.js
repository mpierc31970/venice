import { Router } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { readJson, writeJson, P, slugify, httpError, exists } from "../lib/store.js";
import { imageGenerate, imageEdit } from "../venice.js";
import { completeJson } from "../lib/llm.js";
import { elementSystem, referencePrompt, editAnglePrompt, ANGLE_INSTRUCTIONS, presenceReferencePrompt, editStatePrompt, LOCATION_ANGLES } from "../lib/prompts.js";
import { loadCanon, loadElements } from "../lib/canon.js";
import { saveBase64, saveBuffer, toDataUrl, stamp } from "../lib/media.js";
import { model as getModel } from "../lib/modelcache.js";

const r = Router();
const rel = (dir, abs) => path.relative(dir, abs).split(path.sep).join("/");

async function getEl(dir, slug) {
  const el = await readJson(P.element(dir, slug));
  if (!el) throw httpError(404, "Element not found");
  return { ...el, slug };
}
const saveEl = (dir, slug, el) => { const { slug: _s, ...data } = el; return writeJson(P.element(dir, slug), data); };

r.get("/", async (req, res, next) => { try { res.json(await loadElements(req.proj.dir)); } catch (e) { next(e); } });

r.post("/", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    const { name, type = "character" } = req.body;
    if (!name) throw httpError(400, "name required");
    let slug = slugify(name); let n = 1;
    while (await exists(P.element(dir, slug))) slug = `${slugify(name)}-${++n}`;
    const el = {
      name, type, role: "", bio: "", fingerprint: [], description: "", negatives: "", voiceHint: "", wardrobe: [],
      voice: { model: null, voice: null, vvId: null, sampleFile: null }, imageModel: null, seed: Math.floor(Math.random() * 1e9),
      board: [], angles: {}, qa: {}, locked: false, createdAt: new Date().toISOString(),
    };
    await saveEl(dir, slug, el);
    res.status(201).json({ ...el, slug });
  } catch (e) { next(e); }
});

r.get("/:slug", async (req, res, next) => { try { res.json(await getEl(req.proj.dir, req.params.slug)); } catch (e) { next(e); } });

r.patch("/:slug", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    const el = await getEl(dir, req.params.slug);
    const next_ = { ...el, ...req.body, voice: { ...el.voice, ...(req.body.voice || {}) } };
    if (Array.isArray(req.body.states)) next_.states = req.body.states.map((s, i) => ({ key: slugify(s.key || s.name || `state-${i + 1}`), name: s.name || s.key, description: s.description || "" }));
    await saveEl(dir, req.params.slug, next_);
    res.json(next_);
  } catch (e) { next(e); }
});

r.delete("/:slug", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    await getEl(dir, req.params.slug);
    await fs.rm(P.elementDir(dir, req.params.slug), { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /:slug/draft { notes?, model? } -> Claude drafts bio/fingerprint/description/negatives/voiceHint
r.post("/:slug/draft", async (req, res, next) => {
  try {
    const { dir, project } = req.proj;
    const el = await getEl(dir, req.params.slug);
    const canon = await loadCanon(dir);
    const data = await completeJson({
      model: req.body?.model || project.defaults.textModel, dry: req.body?.dry, result: req.body?.result,
      system: `${elementSystem(el.type)}\n\n${canon.block}`,
      user: `Element name: ${el.name}\nType: ${el.type}\nRole: ${el.role || ""}\nExisting bio: ${el.bio || ""}\nExisting fingerprint: ${(el.fingerprint || []).join("; ")}\nExisting description: ${el.description || ""}\nCreator notes: ${req.body?.notes || ""}`,
    });
    const next_ = { ...el, bio: data.bio ?? el.bio, fingerprint: data.fingerprint ?? el.fingerprint, description: data.description ?? el.description, negatives: data.negatives ?? el.negatives, voiceHint: data.voiceHint ?? el.voiceHint };
    if (el.type === "presence" && Array.isArray(data.states) && data.states.length) next_.states = data.states.slice(0, 4).map((s, i) => ({ key: slugify(s.key || s.name || `state-${i + 1}`), name: s.name || s.key, description: s.description || "" }));
    await saveEl(dir, el.slug, next_);
    res.json(next_);
  } catch (e) { next(e); }
});

function imageBody(m, { prompt, negative, aspect, resolution, seed, variants = 1, safeMode, hideWatermark }) {
  const c = m?.model_spec?.constraints || {};
  const body = { model: m.id, prompt: prompt.slice(0, c.promptCharacterLimit || 1500), format: "png", safe_mode: !!safeMode, hide_watermark: !!hideWatermark, variants };
  if (negative) body.negative_prompt = negative;
  if (seed !== undefined && seed !== null) body.seed = Number(seed);
  if (c.aspectRatios?.length) body.aspect_ratio = c.aspectRatios.includes(aspect) ? aspect : c.defaultAspectRatio || c.aspectRatios[0];
  else if (aspect) { const [w, h] = aspect.split(":").map(Number); const base = 1024; const div = c.widthHeightDivisor || 16; const W = Math.min(1280, base), H = Math.round((base * h) / w / div) * div; body.width = W; body.height = Math.min(1280, H); }
  if (c.resolutions?.length) body.resolution = c.resolutions.includes(resolution) ? resolution : c.defaultResolution || c.resolutions[0];
  return body;
}

// POST /bakeoff { prompt, models: [ids], aspect? } -> [{model, file}]  (one prompt across models; user picks the aesthetic)
r.post("/bakeoff", async (req, res, next) => {
  try {
    const { dir, project } = req.proj;
    const { prompt, models = [], aspect = project.defaults.aspect } = req.body;
    if (!prompt || !models.length) throw httpError(400, "prompt and models required");
    const canon = await loadCanon(dir);
    const full = `${canon.worldSeed}\n\n${prompt}`.trim();
    const out = [];
    for (const id of models) {
      const m = await getModel(id);
      if (!m) { out.push({ model: id, error: "unknown model" }); continue; }
      try {
        const body = imageBody(m, { prompt: full, negative: canon.hardNegatives, aspect, resolution: project.defaults.resolution, seed: 12345, safeMode: project.defaults.safeMode, hideWatermark: project.defaults.hideWatermark });
        const r_ = await imageGenerate(body);
        const abs = path.join(dir, "bakeoff", `${stamp()}-${slugify(id)}.png`);
        await saveBase64(abs, r_.images[0]);
        out.push({ model: id, file: rel(dir, abs), request: body });
      } catch (e) { out.push({ model: id, error: e.message }); }
    }
    await writeJson(path.join(dir, "bakeoff", "last.json"), { prompt, results: out, at: new Date().toISOString() });
    res.json(out);
  } catch (e) { next(e); }
});
r.get("/bakeoff/last", async (req, res, next) => { try { res.json(await readJson(path.join(req.proj.dir, "bakeoff", "last.json"), null)); } catch (e) { next(e); } });

// POST /:slug/board { count?, model?, seedMode: "fixed"|"random", aspect? } -> identity-board candidates (frontal)
r.post("/:slug/board", async (req, res, next) => {
  try {
    const { dir, project } = req.proj;
    const el = await getEl(dir, req.params.slug);
    if (!el.description) throw httpError(400, "Write/lock the verbatim description first");
    const count = Math.min(12, Math.max(1, Number(req.body?.count || 4)));
    const modelId = req.body?.model || el.imageModel || project.defaults.imageModel;
    const m = await getModel(modelId);
    if (!m) throw httpError(400, "Unknown image model " + modelId);
    const canon = await loadCanon(dir);
    const isPresence = el.type === "presence";
    if (isPresence && !el.states?.length) throw httpError(400, "Draft the presence first so it has states");
    const prompt = isPresence ? presenceReferencePrompt({ worldSeed: canon.worldSeed, description: el.description, state: el.states[0] }) : referencePrompt({ worldSeed: canon.worldSeed, description: el.description, angle: "frontal", type: el.type });
    const negative = [canon.hardNegatives, el.negatives].filter(Boolean).join(", ");
    const aspect = req.body?.aspect || (el.type === "location" || isPresence ? project.defaults.aspect : "3:4");
    const results = [];
    for (let i = 0; i < count; i++) {
      const seed = req.body?.seedMode === "fixed" ? el.seed + i : Math.floor(Math.random() * 1e9);
      const body = imageBody(m, { prompt, negative, aspect, resolution: project.defaults.resolution, seed, safeMode: project.defaults.safeMode, hideWatermark: project.defaults.hideWatermark });
      const r_ = await imageGenerate(body);
      const abs = path.join(P.elementDir(dir, el.slug), "board", `${stamp()}-${i}.png`);
      await saveBase64(abs, r_.images[0]);
      results.push({ file: rel(dir, abs), seed, model: modelId, prompt });
    }
    el.board = [...(el.board || []), ...results]; el.imageModel = modelId;
    await saveEl(dir, el.slug, el);
    res.json(el);
  } catch (e) { next(e); }
});

// POST /:slug/import { name, data(base64), angle? } -> use your own image as a board candidate (or directly as an angle)
r.post("/:slug/import", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    const el = await getEl(dir, req.params.slug);
    const { name = "", data, angle } = req.body || {};
    if (!data) throw httpError(400, "data required");
    const ext = (path.extname(name) || ".png").toLowerCase();
    if (angle && (ANGLE_INSTRUCTIONS[angle] || (el.states || []).some((s) => s.key === angle))) {
      const abs = path.join(P.elementDir(dir, el.slug), "angles", `${angle}-import-${stamp()}${ext}`);
      await saveBase64(abs, data);
      el.angles[angle] = { file: rel(dir, abs), model: "imported", prompt: "", source: name }; el.qa[angle] = null;
    } else {
      const abs = path.join(P.elementDir(dir, el.slug), "board", `import-${stamp()}${ext}`);
      await saveBase64(abs, data);
      el.board = [...(el.board || []), { file: rel(dir, abs), seed: null, model: "imported", prompt: "", source: name }];
    }
    await saveEl(dir, el.slug, el);
    res.json(el);
  } catch (e) { next(e); }
});

// POST /:slug/pick { file } -> sets frontal angle from a board candidate
r.post("/:slug/pick", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    const el = await getEl(dir, req.params.slug);
    const cand = (el.board || []).find((b) => b.file === req.body.file);
    if (!cand) throw httpError(400, "Not a board candidate");
    el.angles = { ...el.angles, frontal: { file: cand.file, seed: cand.seed, model: cand.model, prompt: cand.prompt } };
    el.seed = cand.seed;
    await saveEl(dir, el.slug, el);
    res.json(el);
  } catch (e) { next(e); }
});

// POST /:slug/angles { angles?: ["q45","profile","rear"], editModel? } -> derive angles from the frontal via /image/edit
r.post("/:slug/angles", async (req, res, next) => {
  try {
    const { dir, project } = req.proj;
    const el = await getEl(dir, req.params.slug);
    if (!el.angles?.frontal) throw httpError(400, "Pick a frontal reference first");
    const isPresence = el.type === "presence";
    const stateKeys = isPresence ? (el.states || []).slice(1).map((s) => s.key) : null;
    const angles = req.body?.angles || (isPresence ? stateKeys : ["q45", "profile", "rear"]);
    const editModel = req.body?.editModel || project.defaults.editModel;
    const frontal = await toDataUrl(path.join(dir, el.angles.frontal.file));
    const errors = [];
    if (el.type === "location") {
      // A room can't be "rotated" by an image edit — re-shoot each camera position from the identical description.
      const canon = await loadCanon(dir);
      const modelId = req.body?.model || el.imageModel || el.angles.frontal.model || project.defaults.imageModel;
      const m = await getModel(modelId);
      if (!m) throw httpError(400, "Unknown image model " + modelId);
      const negative = ["people, person, figure, silhouette, face, hands, crowd, camera, tripod, photographer, film equipment", canon.hardNegatives, el.negatives].filter(Boolean).join(", ");
      for (const a of angles) {
        if (!LOCATION_ANGLES[a]) continue;
        try {
          const prompt = referencePrompt({ worldSeed: canon.worldSeed, description: el.description, angle: a, type: "location" });
          const body = imageBody(m, { prompt, negative, aspect: project.defaults.aspect, resolution: project.defaults.resolution, seed: el.angles.frontal.seed ?? el.seed, safeMode: project.defaults.safeMode, hideWatermark: project.defaults.hideWatermark });
          if (m.model_spec?.capabilities?.supportsStyleReferences === true) body.style_references = [{ image: frontal, strength: 0.7 }];
          const r_ = await imageGenerate(body);
          const abs = path.join(P.elementDir(dir, el.slug), "angles", `${a}-${stamp()}.png`);
          await saveBase64(abs, r_.images[0]);
          el.angles[a] = { file: rel(dir, abs), model: modelId, prompt, from: el.angles.frontal.file, seed: body.seed ?? null };
          el.qa[a] = null;
        } catch (e) { errors.push({ angle: a, error: e.message }); }
      }
      await saveEl(dir, el.slug, el);
      return res.json({ element: el, errors });
    }
    for (const a of angles) {
      const state = isPresence ? (el.states || []).find((s) => s.key === a) : null;
      if (!(isPresence ? state : ANGLE_INSTRUCTIONS[a])) continue;
      try {
        const prompt = isPresence ? editStatePrompt({ description: el.description, state }) : editAnglePrompt({ description: el.description, angle: a });
        const out = await imageEdit({ model: editModel, image: frontal, prompt, output_format: "png", safe_mode: !!project.defaults.safeMode });
        const abs = path.join(P.elementDir(dir, el.slug), "angles", `${a}-${stamp()}.png`);
        if (out.buffer) await saveBuffer(abs, out.buffer);
        else if (out.json?.images?.[0]) await saveBase64(abs, out.json.images[0]);
        else throw new Error("No image returned");
        el.angles[a] = { file: rel(dir, abs), model: editModel, prompt, from: el.angles.frontal.file };
        el.qa[a] = null;
      } catch (e) { errors.push({ angle: a, error: e.message }); }
    }
    await saveEl(dir, el.slug, el);
    res.json({ element: el, errors });
  } catch (e) { next(e); }
});

// PUT /:slug/qa { angle, checks: {silhouette,wardrobe,features,style,scale: bool} }
r.put("/:slug/qa", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    const el = await getEl(dir, req.params.slug);
    const { angle, checks } = req.body;
    const fails = Object.values(checks || {}).filter((v) => v === false).length;
    el.qa = { ...el.qa, [angle]: { checks, fails, verdict: fails >= 2 ? "regenerate" : "pass", at: new Date().toISOString() } };
    await saveEl(dir, el.slug, el);
    const failedAngles = Object.values(el.qa).filter((q) => q && q.verdict === "regenerate").length;
    res.json({ element: el, advice: failedAngles >= 3 ? "3+ angles failed: regenerate the whole set from a new frontal" : fails >= 2 ? `Regenerate the ${angle} angle` : "OK" });
  } catch (e) { next(e); }
});

// POST /:slug/lock { locked: bool }
r.post("/:slug/lock", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    const el = await getEl(dir, req.params.slug);
    el.locked = req.body?.locked !== false;
    await saveEl(dir, el.slug, el);
    res.json(el);
  } catch (e) { next(e); }
});

export default r;
