import { Router } from "express";
import path from "node:path";
import { readJson, writeJson, P, httpError } from "../lib/store.js";
import { tts, cloneVoice } from "../venice.js";
import { saveBuffer, saveBase64, stamp } from "../lib/media.js";
import { model as getModel } from "../lib/modelcache.js";
import { findElement, loadElements } from "../lib/canon.js";

const r = Router();
const rel = (dir, abs) => path.relative(dir, abs).split(path.sep).join("/");

async function speak({ model, voice, text, speed = 1, prompt }) {
  const m = await getModel(model);
  const fmt = m?.model_spec?.supported_formats?.includes("mp3") ? "mp3" : m?.model_spec?.default_format || "mp3";
  const body = { model, voice, input: text.slice(0, 4096), response_format: fmt, speed };
  if (prompt) body.prompt = prompt;
  const out = await tts(body);
  if (!out.buffer) throw httpError(502, "TTS returned no audio");
  return { buffer: out.buffer, ext: fmt };
}

// POST /preview { model, voice, text, speed? } -> audio (streamed back directly, not saved)
r.post("/preview", async (req, res, next) => {
  try {
    const { model, voice, text = "Hello. This is a voice preview for the film.", speed } = req.body;
    if (!model || !voice) throw httpError(400, "model and voice required");
    const { buffer, ext } = await speak({ model, voice, text, speed });
    res.setHeader("Content-Type", ext === "wav" ? "audio/wav" : "audio/mpeg");
    res.send(buffer);
  } catch (e) { next(e); }
});

// POST /clone { slug, name, data (base64 audio), model } -> vv_ id stored on the element
r.post("/clone", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    const { slug, name, data, model, filename = "sample.mp3" } = req.body;
    if (!slug || !data) throw httpError(400, "slug and data required");
    const el = await readJson(P.element(dir, slug));
    if (!el) throw httpError(404, "Element not found");
    const abs = path.join(P.elementDir(dir, slug), "voice-sample" + path.extname(filename || ".mp3"));
    await saveBase64(abs, data);
    const clean = data.replace(/^data:[^;]+;base64,/, "");
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(clean, "base64")]), filename);
    form.append("name", name || el.name);
    if (model) form.append("model", model);
    const out = await cloneVoice(form);
    const vvId = out.voice_id || out.id || out.voice || null;
    el.voice = { ...el.voice, vvId, sampleFile: rel(dir, abs), clonedAt: new Date().toISOString(), cloneModel: model || null, voice: vvId || el.voice?.voice };
    await writeJson(P.element(dir, slug), el);
    res.json({ element: el, raw: out });
  } catch (e) { next(e); }
});

// POST /line { shotId, lineIndex, character, text, speed? } -> saves shots/<id>/lines/<n>.mp3 using the character's voice
r.post("/line", async (req, res, next) => {
  try {
    const { dir, project } = req.proj;
    const { shotId, lineIndex, character, text, speed } = req.body;
    if (!shotId || !text) throw httpError(400, "shotId and text required");
    const elements = await loadElements(dir);
    const el = findElement(elements, character);
    const model = el?.voice?.model || project.defaults.ttsModel;
    const voice = el?.voice?.vvId || el?.voice?.voice;
    if (!voice) throw httpError(400, `No voice assigned to ${character}. Pick one on the Elements page.`);
    const { buffer, ext } = await speak({ model, voice, text, speed });
    const abs = path.join(P.shotDir(dir, shotId), "lines", `${String(lineIndex ?? 0).padStart(2, "0")}-${stamp()}.${ext}`);
    await saveBuffer(abs, buffer);
    const shot = await readJson(P.shot(dir, shotId));
    if (shot) {
      shot.lines = [...(shot.lines || []).filter((l) => l.lineIndex !== lineIndex), { lineIndex, character, text, file: rel(dir, abs), model, voice, at: new Date().toISOString() }].sort((a, b) => a.lineIndex - b.lineIndex);
      await writeJson(P.shot(dir, shotId), shot);
    }
    res.json({ file: rel(dir, abs), model, voice });
  } catch (e) { next(e); }
});

export default r;
