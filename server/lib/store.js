import fs from "node:fs/promises";
import path from "node:path";
import { findProject } from "./registry.js";

export const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48) || "item";

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}
export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}
export async function readText(file, fallback = "") {
  try { return await fs.readFile(file, "utf8"); } catch { return fallback; }
}
export async function writeText(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}
export async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}
export async function listDirs(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
}

/** Resolve a project by id -> { id, dir, project } or throw 404. */
export async function openProject(id) {
  const entry = await findProject(id);
  if (!entry) throw httpError(404, "Project not found");
  const project = await readJson(path.join(entry.dir, "project.json"));
  if (!project) throw httpError(404, "project.json missing at " + entry.dir);
  return { id, dir: entry.dir, project };
}

/** Guard: resolve a relative path inside the project dir, refusing traversal. */
export function inside(dir, rel) {
  const abs = path.resolve(dir, rel);
  if (!abs.startsWith(path.resolve(dir))) throw httpError(400, "Path escapes project");
  return abs;
}

export const P = {
  project: (d) => path.join(d, "project.json"),
  bible: (d) => path.join(d, "bible.md"),
  worldSeed: (d) => path.join(d, "world-seed.md"),
  elements: (d) => path.join(d, "elements"),
  elementDir: (d, slug) => path.join(d, "elements", slug),
  element: (d, slug) => path.join(d, "elements", slug, "element.json"),
  assets: (d) => path.join(d, "assets"),
  assetsIndex: (d) => path.join(d, "assets", "assets.json"),
  screenplay: (d) => path.join(d, "script", "screenplay.md"),
  scenes: (d) => path.join(d, "script", "scenes.json"),
  shots: (d) => path.join(d, "shots"),
  shotDir: (d, id) => path.join(d, "shots", id),
  shot: (d, id) => path.join(d, "shots", id, "shot.json"),
  jobs: (d) => path.join(d, "jobs.json"),
};
