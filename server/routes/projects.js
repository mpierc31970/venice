import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { listProjects, registerProject, forgetProject } from "../lib/registry.js";
import { openProject, readJson, writeJson, slugify, httpError, P, exists } from "../lib/store.js";

const r = Router();

export const DEFAULTS = {
  textModel: "claude-sonnet-5",
  imageModel: "nano-banana-pro",
  editModel: "flux-2-max-edit",
  videoModel: "seedance-2-5-reference-to-video-basic",
  ttsModel: "tts-elevenlabs-turbo-v2-5",
  aspect: "16:9",
  resolution: "1K",
  videoResolution: "720p",
  safeMode: false,
  hideWatermark: true,
};

r.get("/", async (_req, res, next) => {
  try { res.json(await listProjects()); } catch (e) { next(e); }
});

// POST /api/projects { title, dir, logline? }
r.post("/", async (req, res, next) => {
  try {
    const { title, dir, logline = "" } = req.body || {};
    if (!title || !dir) throw httpError(400, "title and dir are required");
    const abs = path.resolve(dir);
    await fs.mkdir(abs, { recursive: true });
    if (await exists(P.project(abs))) throw httpError(409, "A project.json already exists in that folder; use Open instead");
    const id = slugify(title) + "-" + Date.now().toString(36);
    const project = {
      id, title, logline, canonVersion: 1,
      createdAt: new Date().toISOString(),
      defaults: { ...DEFAULTS },
    };
    await writeJson(P.project(abs), project);
    for (const sub of ["elements", "assets", "script", "shots"]) await fs.mkdir(path.join(abs, sub), { recursive: true });
    await registerProject({ id, title, dir: abs });
    res.status(201).json({ id, title, dir: abs, project });
  } catch (e) { next(e); }
});

// POST /api/projects/open { dir }  — register an existing project folder
r.post("/open", async (req, res, next) => {
  try {
    const abs = path.resolve(req.body?.dir || "");
    const project = await readJson(P.project(abs));
    if (!project) throw httpError(404, "No project.json found in " + abs);
    await registerProject({ id: project.id, title: project.title, dir: abs });
    res.json({ id: project.id, title: project.title, dir: abs, project });
  } catch (e) { next(e); }
});

r.get("/:id", async (req, res, next) => {
  try {
    const { id, dir, project } = await openProject(req.params.id);
    res.json({ id, dir, project: { ...project, defaults: { ...DEFAULTS, ...(project.defaults || {}) } } });
  } catch (e) { next(e); }
});

r.patch("/:id", async (req, res, next) => {
  try {
    const { dir, project } = await openProject(req.params.id);
    const patch = req.body || {};
    const next_ = { ...project, ...patch, id: project.id, defaults: { ...project.defaults, ...(patch.defaults || {}) } };
    await writeJson(P.project(dir), next_);
    if (patch.title) await registerProject({ id: project.id, title: patch.title, dir });
    res.json(next_);
  } catch (e) { next(e); }
});

// Open the project folder in the OS file manager (local app convenience)
r.post("/:id/open-folder", async (req, res, next) => {
  try {
    const { dir } = await openProject(req.params.id);
    const sub = req.body?.sub ? path.join(dir, req.body.sub) : dir;
    const target = (await exists(sub)) ? sub : dir;
    const cmd = process.platform === "win32" ? ["explorer", [target]] : process.platform === "darwin" ? ["open", [target]] : ["xdg-open", [target]];
    spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref();
    res.json({ ok: true, dir: target });
  } catch (e) { next(e); }
});

// Remove from registry only (never deletes files)
r.delete("/:id", async (req, res, next) => {
  try { await forgetProject(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});

export default r;
