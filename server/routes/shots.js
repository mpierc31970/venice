import { Router } from "express";
import path from "node:path";
import { readJson, writeJson, P, httpError, listDirs, inside } from "../lib/store.js";
import { imageGenerate, videoQuote } from "../venice.js";
import { complete } from "../lib/llm.js";
import { KEYFRAME_SYSTEM, VIDEO_PROMPT_SYSTEM } from "../lib/prompts.js";
import { loadCanon, findElement, elementBlock } from "../lib/canon.js";
import { saveBase64, toDataUrl, stamp } from "../lib/media.js";
import { model as getModel } from "../lib/modelcache.js";
import { enqueue, onJobDone, retryJob } from "../lib/jobs.js";

const r = Router();
const rel = (dir, abs) => path.relative(dir, abs).split(path.sep).join("/");

async function getShot(dir, id) {
  const s = await readJson(P.shot(dir, id));
  if (!s) throw httpError(404, "Shot not found");
  return s;
}
const saveShot = (dir, s) => writeJson(P.shot(dir, s.id), s);

async function sceneOf(dir, shot) {
  const { scenes } = await readJson(P.scenes(dir), { scenes: [] });
  return scenes.find((s) => s.id === shot.sceneId) || null;
}

r.get("/", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    const ids = (await listDirs(P.shots(dir))).sort();
    const shots = [];
    for (const id of ids) { const s = await readJson(P.shot(dir, id)); if (s) shots.push(s); }
    res.json(shots);
  } catch (e) { next(e); }
});

r.get("/:id", async (req, res, next) => { try { res.json(await getShot(req.proj.dir, req.params.id)); } catch (e) { next(e); } });

r.patch("/:id", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    const s = await getShot(dir, req.params.id);
    const next_ = { ...s, ...req.body, id: s.id, models: { ...s.models, ...(req.body.models || {}) } };
    await saveShot(dir, next_);
    res.json(next_);
  } catch (e) { next(e); }
});

async function contextFor(dir, shot) {
  const canon = await loadCanon(dir, { bibleChars: 2500 });
  const scene = await sceneOf(dir, shot);
  const chars = (shot.characters || []).map((n) => findElement(canon.elements, n)).filter(Boolean);
  const loc = shot.location ? findElement(canon.elements, shot.location) : null;
  const dialogue = (shot.dialogueLines || []).map((i) => scene?.dialogue?.[i]).filter(Boolean);
  return { canon, scene, chars, loc, dialogue };
}

// POST /:id/keyframe-prompt { model? } -> Claude composes the still prompt
r.post("/:id/keyframe-prompt", async (req, res, next) => {
  try {
    const { dir, project } = req.proj;
    const shot = await getShot(dir, req.params.id);
    const { canon, scene, chars, loc, dialogue } = await contextFor(dir, shot);
    const text = await complete({
      model: req.body?.model || project.defaults.textModel, dry: req.body?.dry, result: req.body?.result,
      system: `${KEYFRAME_SYSTEM}\n\n${canon.block}`,
      user: `Scene: ${scene?.title} — mood: ${scene?.mood}\nLocation: ${shot.location}${loc ? `\nLocation description: ${loc.description}` : ""}\nShot type: ${shot.type}; camera framing: ${shot.camera}\nAction: ${shot.action}\n${dialogue.length ? `Dialogue in shot: ${dialogue.map((d) => `${d.character}: "${d.line}"`).join(" / ")}\n` : ""}\nCHARACTERS (use verbatim descriptions unchanged):\n${chars.map(elementBlock).join("\n\n") || "(none)"}`,
      temperature: 0.6,
    });
    shot.keyframePrompt = text.trim();
    await saveShot(dir, shot);
    res.json(shot);
  } catch (e) { next(e); }
});

// POST /:id/keyframe { model?, variants?, seed? } -> generates keyframe candidates with style refs from plates
r.post("/:id/keyframe", async (req, res, next) => {
  try {
    const { dir, project } = req.proj;
    const shot = await getShot(dir, req.params.id);
    if (!shot.keyframePrompt) throw httpError(400, "Compose the keyframe prompt first");
    const modelId = req.body?.model || shot.models?.image || project.defaults.imageModel;
    const m = await getModel(modelId);
    if (!m) throw httpError(400, "Unknown image model " + modelId);
    const c = m.model_spec?.constraints || {};
    const { canon } = await contextFor(dir, shot);
    const variants = Math.min(4, Math.max(1, Number(req.body?.variants || 1)));
    const body = { model: modelId, prompt: shot.keyframePrompt.slice(0, c.promptCharacterLimit || 1500), format: "png", safe_mode: !!project.defaults.safeMode, hide_watermark: !!project.defaults.hideWatermark, variants };
    if (canon.hardNegatives) body.negative_prompt = canon.hardNegatives;
    if (req.body?.seed !== undefined) body.seed = Number(req.body.seed);
    if (c.aspectRatios?.length) body.aspect_ratio = c.aspectRatios.includes(project.defaults.aspect) ? project.defaults.aspect : c.defaultAspectRatio;
    if (c.resolutions?.length) body.resolution = c.resolutions.includes(project.defaults.resolution) ? project.defaults.resolution : c.defaultResolution;
    const refs = [];
    for (const p of shot.plates || []) { try { refs.push({ image: await toDataUrl(inside(dir, p)), strength: 0.6 }); } catch {} }
    if (refs.length && m.model_spec?.capabilities?.supportsStyleReferences !== false) body.style_references = refs.slice(0, m.model_spec?.capabilities?.maxStyleReferences || 3);
    const out = await imageGenerate(body);
    const files = [];
    for (const [i, b64] of (out.images || []).entries()) {
      const abs = path.join(P.shotDir(dir, shot.id), `keyframe-${stamp()}-${i}.png`);
      await saveBase64(abs, b64);
      files.push(rel(dir, abs));
    }
    shot.keyframes = [...(shot.keyframes || []), ...files.map((f) => ({ file: f, model: modelId, prompt: shot.keyframePrompt, seed: body.seed ?? null }))];
    shot.models.image = modelId;
    if (!shot.keyframe && files[0]) shot.keyframe = files[0];
    await saveShot(dir, shot);
    res.json(shot);
  } catch (e) { next(e); }
});

// POST /:id/video-prompt { model? } -> Claude composes the video prompt using @Element tags when the model supports elements
r.post("/:id/video-prompt", async (req, res, next) => {
  try {
    const { dir, project } = req.proj;
    const shot = await getShot(dir, req.params.id);
    const { canon, scene, chars, loc, dialogue } = await contextFor(dir, shot);
    const vm = await getModel(shot.models?.video || project.defaults.videoModel);
    const hasElements = /reference-to-video/.test(vm?.id || "") && chars.some((c) => c.angles?.frontal);
    const text = await complete({
      model: req.body?.model || project.defaults.textModel, dry: req.body?.dry, result: req.body?.result,
      system: `${VIDEO_PROMPT_SYSTEM({ hasElements })}\n\n${canon.block}`,
      user: `Scene: ${scene?.title} — mood: ${scene?.mood}\nLocation: ${shot.location}${loc ? ` — ${loc.description}` : ""}\nShot type: ${shot.type}; camera: ${shot.camera}; duration: ${shot.durationS}\nAction: ${shot.action}\n${dialogue.length ? `Dialogue (characters speak these lines; if the model generates audio, include them as spoken dialogue): ${dialogue.map((d) => `${d.character}: "${d.line}"`).join(" / ")}\n` : ""}\nCHARACTERS in order${hasElements ? " (Element1..N)" : ""}:\n${chars.map((c, i) => `${hasElements ? `@Element${i + 1} = ` : ""}${elementBlock(c)}`).join("\n\n") || "(none)"}${shot.plates?.length && hasElements ? "\n@Image1 = scene plate provided." : ""}`,
      temperature: 0.6,
    });
    shot.videoPrompt = text.trim();
    await saveShot(dir, shot);
    res.json(shot);
  } catch (e) { next(e); }
});

/** Build the exact /video/queue payload for a shot from what the chosen model supports. */
async function buildVideoRequest(dir, project, shot, overrides = {}) {
  const modelId = overrides.model || shot.models?.video || project.defaults.videoModel;
  const vm = await getModel(modelId);
  if (!vm) throw httpError(400, "Unknown video model " + modelId);
  const c = vm.model_spec?.constraints || {};
  const durations = c.durations || [];
  let duration = overrides.duration || shot.durationS || "5s";
  if (durations.length && !durations.includes(duration)) {
    const want = parseInt(duration) || 5;
    duration = durations.filter((d) => /^\d+s$/.test(d)).sort((a, b) => Math.abs(parseInt(a) - want) - Math.abs(parseInt(b) - want))[0] || durations[0];
  }
  const body = { model: modelId, prompt: (overrides.prompt || shot.videoPrompt || shot.action).slice(0, c.prompt_character_limit || 2000), duration };
  if (c.aspect_ratios?.length) body.aspect_ratio = c.aspect_ratios.includes(project.defaults.aspect) ? project.defaults.aspect : c.aspect_ratios[0];
  if (c.resolutions?.length) {
    const want = overrides.resolution || project.defaults.videoResolution;
    const px = (r) => (/4k/i.test(r) ? 2160 : /2k/i.test(r) ? 1440 : parseInt(r) || 720);
    body.resolution = c.resolutions.includes(want) ? want : c.resolutions.slice().sort((a, b) => Math.abs(px(a) - px(want)) - Math.abs(px(b) - px(want)))[0];
  }
  if (c.audio_configurable) body.audio = overrides.audio ?? true;
  const { canon, chars } = await contextFor(dir, shot);
  if (canon.hardNegatives) body.negative_prompt = canon.hardNegatives;
  const refs = { elements: [], plates: [], keyframe: null };
  const isR2V = /reference-to-video/.test(modelId);
  const isI2V = c.model_type === "image-to-video" || /image-to-video|first-last-frame/.test(modelId);
  if (shot.keyframe && (isI2V || isR2V)) { body.image_url = await toDataUrl(inside(dir, shot.keyframe)); refs.keyframe = shot.keyframe; }
  const presences = chars.filter((c) => c.type === "presence");
  if (isR2V) {
    const elements = [];
    for (const ch of chars.filter((c) => c.type !== "presence").slice(0, 4)) {
      if (!ch.angles?.frontal) continue;
      const extra = ["q45", "profile", "rear"].map((a) => ch.angles?.[a]?.file).filter(Boolean).slice(0, 3);
      elements.push({ frontal_image_url: await toDataUrl(inside(dir, ch.angles.frontal.file)), reference_image_urls: await Promise.all(extra.map((f) => toDataUrl(inside(dir, f)))) });
      refs.elements.push({ slug: ch.slug, frontal: ch.angles.frontal.file, extra });
    }
    if (elements.length) body.elements = elements;
    // Presence state images act as scene references (their identity is environmental, not a body).
    const presencePlates = presences.flatMap((p) => Object.values(p.angles || {}).map((a) => a.file).filter(Boolean)).slice(0, 2);
    const plates = [...(shot.plates || []), ...presencePlates].slice(0, 4);
    if (plates.length) { body.scene_image_urls = await Promise.all(plates.map((p) => toDataUrl(inside(dir, p)))); refs.plates = plates; }
    // Fallback for R2V models that don't use elements: flat reference list
    if (!elements.length) {
      const flat = [];
      for (const ch of chars) for (const a of ["frontal", "q45", "profile", "rear"]) if (ch.angles?.[a]?.file) flat.push(ch.angles[a].file);
      if (flat.length) body.reference_image_urls = await Promise.all(flat.slice(0, 30).map((f) => toDataUrl(inside(dir, f))));
    }
  }
  return { body, refs, vm };
}

// POST /:id/quote { model?, duration?, resolution? } -> price + the payload summary
r.post("/:id/quote", async (req, res, next) => {
  try {
    const { dir, project } = req.proj;
    const shot = await getShot(dir, req.params.id);
    const { body, refs } = await buildVideoRequest(dir, project, shot, req.body || {});
    const q = { model: body.model, duration: body.duration };
    if (body.resolution) q.resolution = body.resolution;
    if (body.aspect_ratio) q.aspect_ratio = body.aspect_ratio;
    if (body.audio !== undefined) q.audio = body.audio;
    let quote = null, error = null;
    try { quote = await videoQuote(q); } catch (e) { error = e.message; }
    res.json({ quote, error, request: { ...body, image_url: body.image_url ? "<keyframe>" : undefined, elements: body.elements ? body.elements.length + " element(s)" : undefined, scene_image_urls: body.scene_image_urls ? body.scene_image_urls.length + " plate(s)" : undefined, reference_image_urls: body.reference_image_urls ? body.reference_image_urls.length + " ref(s)" : undefined }, refs });
  } catch (e) { next(e); }
});

// POST /:id/render { model?, duration?, resolution?, prompt? } -> enqueue video job
r.post("/:id/render", async (req, res, next) => {
  try {
    const { dir, project } = req.proj;
    const shot = await getShot(dir, req.params.id);
    if (!shot.videoPrompt && !req.body?.prompt) throw httpError(400, "Compose the video prompt first");
    const { body, refs } = await buildVideoRequest(dir, project, shot, req.body || {});
    const outFile = path.join(P.shotDir(dir, shot.id), `clip-${stamp()}.mp4`);
    const job = await enqueue(dir, { request: body, outFile, meta: { shotId: shot.id } });
    shot.jobId = job.id; shot.models.video = body.model;
    shot.provenance = [...(shot.provenance || []), { at: new Date().toISOString(), jobId: job.id, request: job.request, refs, outFile: rel(dir, outFile) }];
    await saveShot(dir, shot);
    res.status(202).json({ job, shot });
  } catch (e) { next(e); }
});

// POST /:id/reroll -> re-queue the exact last provenance payload
r.post("/:id/reroll", async (req, res, next) => {
  try {
    const { dir, project } = req.proj;
    const shot = await getShot(dir, req.params.id);
    const last = shot.provenance?.at(-1);
    if (!last) throw httpError(400, "Nothing to re-roll yet");
    // Rebuild the payload from recorded refs + prompt/model so data URLs are fresh.
    const { body, refs } = await buildVideoRequest(dir, project, { ...shot, videoPrompt: last.request.prompt, models: { ...shot.models, video: last.request.model }, durationS: last.request.duration, keyframe: last.refs?.keyframe ?? shot.keyframe }, { resolution: last.request.resolution });
    const outFile = path.join(P.shotDir(dir, shot.id), `clip-${stamp()}.mp4`);
    const job = await enqueue(dir, { request: body, outFile, meta: { shotId: shot.id, rerollOf: last.jobId } });
    shot.jobId = job.id;
    shot.provenance = [...shot.provenance, { at: new Date().toISOString(), jobId: job.id, request: job.request, refs, outFile: rel(dir, outFile), rerollOf: last.jobId }];
    await saveShot(dir, shot);
    res.status(202).json({ job, shot });
  } catch (e) { next(e); }
});

// POST /:id/import { kind: "clip"|"keyframe", name, data(base64) } -> use your own file (e.g. from Sora/Veo/Imagen) for this shot
r.post("/:id/import", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    const shot = await getShot(dir, req.params.id);
    const { kind, name = "", data } = req.body || {};
    if (!data || !["clip", "keyframe"].includes(kind)) throw httpError(400, "kind (clip|keyframe) and data required");
    const ext = (path.extname(name) || (kind === "clip" ? ".mp4" : ".png")).toLowerCase();
    const abs = path.join(P.shotDir(dir, shot.id), `${kind}-import-${stamp()}${ext}`);
    await saveBase64(abs, data);
    const file = rel(dir, abs);
    if (kind === "clip") { shot.clip = file; shot.clips = [...(shot.clips || []), { jobId: null, status: "IMPORTED", file, error: null, at: new Date().toISOString(), source: name }]; }
    else { shot.keyframe = file; shot.keyframes = [...(shot.keyframes || []), { file, model: "imported", prompt: shot.keyframePrompt || "", seed: null, source: name }]; }
    await saveShot(dir, shot);
    res.json(shot);
  } catch (e) { next(e); }
});

// When a job finishes, record the clip on the shot.
onJobDone(async (dir, job) => {
  const shotId = job.meta?.shotId;
  if (!shotId) return;
  try {
    const shot = await readJson(P.shot(dir, shotId));
    if (!shot) return;
    if (job.status === "COMPLETED") shot.clip = job.outFile;
    shot.clips = [...(shot.clips || []), { jobId: job.id, status: job.status, file: job.status === "COMPLETED" ? job.outFile : null, error: job.error, at: new Date().toISOString() }];
    await saveShot(dir, shot);
  } catch (e) { console.error("[shots] job hook", e.message); }
});

export default r;
