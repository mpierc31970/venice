import { Router } from "express";
import { readText, writeText, readJson, writeJson, P, httpError, exists } from "../lib/store.js";
import { streamToSse, completeJson } from "../lib/llm.js";
import { SCREENPLAY_SYSTEM, SCENES_SYSTEM, SHOTLIST_SYSTEM } from "../lib/prompts.js";
import { loadCanon, elementBlock } from "../lib/canon.js";
import { model as getModel, durationsFor } from "../lib/modelcache.js";

const r = Router();

r.get("/", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    res.json({ screenplay: await readText(P.screenplay(dir)), scenes: (await readJson(P.scenes(dir), { scenes: [] })).scenes });
  } catch (e) { next(e); }
});

r.put("/", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    if (typeof req.body.screenplay === "string") await writeText(P.screenplay(dir), req.body.screenplay);
    if (Array.isArray(req.body.scenes)) await writeJson(P.scenes(dir), { scenes: req.body.scenes });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /screenplay { notes?, model? } -> SSE
r.post("/screenplay", async (req, res, next) => {
  try {
    const { dir, project } = req.proj;
    const canon = await loadCanon(dir, { bibleChars: 14000 });
    const cast = canon.elements.filter((e) => e.type === "character").map(elementBlock).join("\n\n");
    const text = await streamToSse(res, {
      model: req.body?.model || project.defaults.textModel,
      system: `${SCREENPLAY_SYSTEM}\n\n${canon.block}\n\nCAST:\n${cast}`,
      user: `Title: ${project.title}\nLogline: ${project.logline}\n${req.body?.notes ? `Notes: ${req.body.notes}\n` : ""}Write the screenplay.`,
      temperature: 0.8, maxTokens: 16000,
    });
    if (text) await writeText(P.screenplay(dir), text);
  } catch (e) { next(e); }
});

// POST /scenes { model? } -> structured scenes.json from the screenplay
r.post("/scenes", async (req, res, next) => {
  try {
    const { dir, project } = req.proj;
    const screenplay = await readText(P.screenplay(dir));
    if (!screenplay.trim()) throw httpError(400, "Write or generate the screenplay first");
    const canon = await loadCanon(dir, { bibleChars: 3000 });
    const data = await completeJson({ model: req.body?.model || project.defaults.textModel, system: `${SCENES_SYSTEM}\n\nKnown cast names: ${canon.elements.filter((e) => e.type === "character").map((e) => e.name).join(", ")}\nKnown locations: ${canon.elements.filter((e) => e.type === "location").map((e) => e.name).join(", ")}`, user: screenplay, maxTokens: 12000 });
    const scenes = (data.scenes || []).map((s, i) => ({ ...s, id: s.id || `s${i + 1}`, shots: s.shots || [] }));
    await writeJson(P.scenes(dir), { scenes });
    res.json(scenes);
  } catch (e) { next(e); }
});

// POST /scenes/:sid/shotlist { model?, videoModel? } -> shots for one scene, creates shots/<sid>-<n>/shot.json
r.post("/scenes/:sid/shotlist", async (req, res, next) => {
  try {
    const { dir, project } = req.proj;
    const { scenes } = await readJson(P.scenes(dir), { scenes: [] });
    const scene = scenes.find((s) => s.id === req.params.sid);
    if (!scene) throw httpError(404, "Scene not found");
    const videoModel = req.body?.videoModel || scene.videoModel || project.defaults.videoModel;
    const vm = await getModel(videoModel);
    const durations = durationsFor(vm).filter((d) => d !== "auto" && d !== "-1");
    const canon = await loadCanon(dir, { bibleChars: 3000 });
    const data = await completeJson({
      model: req.body?.model || project.defaults.textModel,
      system: `${SHOTLIST_SYSTEM({ durations: durations.length ? durations : ["5s", "10s"], videoModel })}\n\n${canon.block}`,
      user: JSON.stringify({ scene: { title: scene.title, location: scene.location, mood: scene.mood, synopsis: scene.synopsis, characters: scene.characters, dialogue: scene.dialogue } }),
      maxTokens: 8000,
    });
    const shots = [];
    for (const [i, s] of (data.shots || []).entries()) {
      const n = s.n || i + 1;
      const id = `${scene.id}-${String(n).padStart(2, "0")}`;
      const existing = await readJson(P.shot(dir, id), null);
      const shot = {
        id, sceneId: scene.id, n, type: s.type, camera: s.camera, durationS: s.durationS, characters: s.characters || [], location: s.location || scene.location,
        action: s.action, dialogueLines: s.dialogueLines || [], notes: s.notes || "",
        plates: existing?.plates || [], keyframePrompt: existing?.keyframePrompt || "", keyframes: existing?.keyframes || [], keyframe: existing?.keyframe || null,
        videoPrompt: existing?.videoPrompt || "", models: { image: existing?.models?.image || null, video: existing?.models?.video || videoModel },
        jobId: existing?.jobId || null, clip: existing?.clip || null, provenance: existing?.provenance || [], lines: existing?.lines || [],
      };
      await writeJson(P.shot(dir, id), shot);
      shots.push(id);
    }
    scene.shots = shots; scene.videoModel = videoModel;
    await writeJson(P.scenes(dir), { scenes });
    res.json({ scene, shots });
  } catch (e) { next(e); }
});

export default r;
