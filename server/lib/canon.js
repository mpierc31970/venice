// Loads the project's canon (world seed, negatives, bible, elements) for prompt building.
import path from "node:path";
import { readJson, readText, listDirs, P } from "./store.js";
import { canonBlock } from "./prompts.js";

export async function loadElements(dir) {
  const slugs = await listDirs(P.elements(dir));
  const out = [];
  for (const slug of slugs) {
    const e = await readJson(P.element(dir, slug));
    if (e) out.push({ ...e, slug });
  }
  return out;
}

export async function loadCanon(dir, { bibleChars = 6000 } = {}) {
  const [worldSeed, bible, project] = await Promise.all([
    readText(P.worldSeed(dir)), readText(P.bible(dir)), readJson(P.project(dir), {}),
  ]);
  const elements = await loadElements(dir);
  return {
    project,
    worldSeed: worldSeed.trim(),
    hardNegatives: project.hardNegatives || "",
    bible,
    elements,
    block: canonBlock({ worldSeed: worldSeed.trim(), hardNegatives: project.hardNegatives, bibleExcerpt: bible.slice(0, bibleChars) }),
  };
}

export const elementBlock = (e) =>
  `### ${e.name} (${e.type})\nFingerprint: ${(e.fingerprint || []).join("; ")}\nVerbatim description: ${e.description || "(none yet)"}`;

export const findElement = (elements, name) =>
  elements.find((e) => e.name.toLowerCase() === String(name).toLowerCase()) ||
  elements.find((e) => e.slug === name) ||
  elements.find((e) => String(name).toLowerCase().includes(e.name.toLowerCase()));

export const elementAbs = (dir, e, rel) => path.join(P.elementDir(dir, e.slug), rel);
