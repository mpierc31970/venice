import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DIR = path.join(os.homedir(), ".venice-studio");
const FILE = path.join(DIR, "registry.json");
const DEFAULT_SETTINGS = { lowBalanceUsd: 5, criticalBalanceUsd: 1 };

async function load() {
  try {
    const data = JSON.parse(await fs.readFile(FILE, "utf8"));
    return { projects: data.projects || [], settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) } };
  } catch {
    return { projects: [], settings: { ...DEFAULT_SETTINGS } };
  }
}
async function save(data) {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(data, null, 2));
}

export async function listProjects() {
  const reg = await load();
  const out = [];
  for (const p of reg.projects) {
    let exists = true;
    try { await fs.access(path.join(p.dir, "project.json")); } catch { exists = false; }
    out.push({ ...p, exists });
  }
  return out;
}
export async function registerProject(entry) {
  const reg = await load();
  reg.projects = reg.projects.filter((p) => p.id !== entry.id && p.dir !== entry.dir);
  reg.projects.unshift(entry);
  await save(reg);
}
export async function forgetProject(id) {
  const reg = await load();
  reg.projects = reg.projects.filter((p) => p.id !== id);
  await save(reg);
}
export async function findProject(id) {
  const reg = await load();
  return reg.projects.find((p) => p.id === id) || null;
}
export async function getSettings() { return (await load()).settings; }
export async function updateSettings(patch) {
  const reg = await load();
  reg.settings = { ...reg.settings, ...patch };
  await save(reg);
  return reg.settings;
}
