// Mounts all per-project sub-routers under /api/projects/:id/<prefix>.
// Each sub-router receives req.proj = { id, dir, project } via middleware.
import { openProject } from "../lib/store.js";
import { DEFAULTS } from "./projects.js";
import bible from "./bible.js";
import elements from "./elements.js";
import assets from "./assets.js";
import script from "./script.js";
import shots from "./shots.js";
import tts from "./tts.js";
import jobs from "./jobs.js";

const ROUTERS = { bible, elements, assets, script, shots, tts, jobs };

async function loadProject(req, _res, next) {
  try {
    const p = await openProject(req.params.id);
    p.project.defaults = { ...DEFAULTS, ...(p.project.defaults || {}) };
    req.proj = p;
    next();
  } catch (e) { next(e); }
}

export function mountProjectRoutes(app) {
  for (const [prefix, router] of Object.entries(ROUTERS)) {
    app.use(`/api/projects/:id/${prefix}`, loadProject, router);
  }
}
