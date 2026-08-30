import { Router } from "express";
import { readText, writeText, writeJson, readJson, P, slugify, exists } from "../lib/store.js";
import { streamToSse, completeJson } from "../lib/llm.js";
import { BIBLE_SYSTEM, bibleUser, EXTRACT_SYSTEM, IMPROVE_SYSTEM } from "../lib/prompts.js";
import { loadCanon } from "../lib/canon.js";

const r = Router();

r.get("/", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    res.json({ bible: await readText(P.bible(dir)), worldSeed: await readText(P.worldSeed(dir)), extracted: await readJson(`${dir}/bible-extract.json`, null) });
  } catch (e) { next(e); }
});

r.put("/", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    if (typeof req.body.bible === "string") await writeText(P.bible(dir), req.body.bible);
    if (typeof req.body.worldSeed === "string") await writeText(P.worldSeed(dir), req.body.worldSeed);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /generate { logline?, notes?, model? } -> SSE stream; saves bible.md when done
r.post("/generate", async (req, res, next) => {
  try {
    const { dir, project } = req.proj;
    const model = req.body.model || project.defaults.textModel;
    const dry = req.body?.dry, result = req.body?.result;
    const logline = req.body.logline || project.logline || "";
    const text = await streamToSse(res, {
      model, dry, result, system: BIBLE_SYSTEM,
      user: bibleUser({ title: project.title, logline, notes: req.body.notes || "" }),
      temperature: 0.8, maxTokens: 16000,
    });
    if (text) await writeText(P.bible(dir), text);
    if (logline !== project.logline) await writeJson(P.project(dir), { ...project, logline });
  } catch (e) { next(e); }
});

// POST /section { heading, instructions, model? } -> SSE stream of a rewritten section (client splices it in)
r.post("/section", async (req, res, next) => {
  try {
    const { dir, project } = req.proj;
    const bible = await readText(P.bible(dir));
    const { heading, instructions = "", model = project.defaults.textModel } = req.body;
    await streamToSse(res, {
      model, dry: req.body?.dry, result: req.body?.result, system: BIBLE_SYSTEM + "\n\nYou are now REWRITING ONE SECTION ONLY. Output only that section, starting with its '## ' heading, consistent with the rest of the bible.",
      user: `Full bible:\n\n${bible}\n\n---\nRewrite the section "## ${heading}". ${instructions}`,
      temperature: 0.8,
    });
  } catch (e) { next(e); }
});

// POST /extract -> parses bible into world-seed.md + cast + hard negatives (JSON via Claude)
r.post("/extract", async (req, res, next) => {
  try {
    const { dir, project } = req.proj;
    const bible = await readText(P.bible(dir));
    if (!bible.trim()) return res.status(400).json({ error: "Bible is empty" });
    const model = req.body?.model || project.defaults.textModel;
    const data = await completeJson({ model, dry: req.body?.dry, result: req.body?.result, system: EXTRACT_SYSTEM, user: bible, maxTokens: 8000 });
    await writeText(P.worldSeed(dir), data.worldSeed || "");
    await writeJson(`${dir}/bible-extract.json`, data);
    await writeJson(P.project(dir), { ...project, hardNegatives: data.hardNegatives || "", palette: data.palette || null, prohibitions: data.prohibitions || [] });
    res.json(data);
  } catch (e) { next(e); }
});

// POST /create-elements { which: ["cast","locations"] } -> element folders from the extract (skips existing)
r.post("/create-elements", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    const ex = await readJson(`${dir}/bible-extract.json`, null);
    if (!ex) return res.status(400).json({ error: "Run extract first" });
    const which = req.body?.which || ["cast", "locations"];
    const created = [];
    const mk = async (type, x) => {
      const slug = slugify(x.name);
      if (await exists(P.element(dir, slug))) return;
      const el = {
        name: x.name, type, role: x.role || "", bio: x.bio || x.description || "", fingerprint: x.fingerprint || [],
        description: x.description || "", negatives: "", voiceHint: x.voiceHint || "", wardrobe: x.wardrobe || [],
        voice: { model: null, voice: null, vvId: null, sampleFile: null }, imageModel: null, seed: Math.floor(Math.random() * 1e9),
        board: [], angles: {}, qa: {}, locked: false, createdAt: new Date().toISOString(),
      };
      await writeJson(P.element(dir, slug), el);
      created.push(slug);
    };
    if (which.includes("cast")) for (const c of ex.cast || []) await mk("character", c);
    if (which.includes("locations")) for (const l of ex.locations || []) await mk("location", l);
    res.json({ created });
  } catch (e) { next(e); }
});

// POST /improve { kind, text, context?, model? } -> { text }   (generic "Improve with Claude")
r.post("/improve", async (req, res, next) => {
  try {
    const { dir, project } = req.proj;
    const { kind = "generic", text = "", context = "", model = project.defaults.textModel } = req.body;
    if (!text.trim()) return res.status(400).json({ error: "Nothing to improve" });
    const canon = await loadCanon(dir, { bibleChars: 4000 });
    const { complete } = await import("../lib/llm.js");
    const out = await complete({
      model, dry: req.body?.dry, result: req.body?.result, system: `${IMPROVE_SYSTEM(kind)}\n\n${canon.block}`,
      user: `${context ? `Context: ${context}\n\n` : ""}TEXT TO IMPROVE:\n${text}`, temperature: 0.6,
    });
    res.json({ text: out.trim() });
  } catch (e) { next(e); }
});

export default r;
