// Talking-head batch renderer routes, mounted at /api/projects/:id/batch/*.
//
// Only two of these spend money — POST /run (unless dryRun) and POST /row/:rowId/render.
// Everything else is free, which is what makes the verification gates cheap: import,
// prompts, budget maths and the Wasabi healthcheck all answer for $0.
import { Router } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { httpError, inside } from "../lib/store.js";
import { saveBase64 } from "../lib/media.js";
import {
  readSettings, writeSettings, readState, listRows, sections, importSheet,
  buildPrompt, forgetImages, quoteRow, sectionCost, isPending, balanceUsd,
  start, stop, runState, writeTimeline, patchRow,
} from "../lib/batch.js";

const r = Router();

const SLOTS = { avatar: "avatar", background: "background" };

/**
 * How far the current balance reaches, section by section — the number that makes the
 * decision legible before anyone presses Run. Quotes are free and cached per duration.
 */
async function budget(settings, list, balance) {
  const out = { balance, floor: settings.creditFloor, sections: [], reach: [], total: 0, affordable: 0, shortfall: 0 };
  let spent = 0;
  for (const s of list) {
    const cost = s.pending ? await sectionCost(settings, s) : 0;
    out.total += cost;
    const fits = balance != null && spent + cost + settings.creditFloor <= balance;
    if (fits) { spent += cost; out.affordable += cost; out.reach.push(s.id); }
    out.sections.push({ id: s.id, cost, fits, seconds: s.seconds, pending: s.pending });
  }
  out.shortfall = Math.max(0, out.total - out.affordable);
  return out;
}

// GET / -> settings + rows + sections + run status + budget
r.get("/", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    const settings = await readSettings(dir);
    const state = await readState(dir);
    const list = await sections(dir);
    const balance = await balanceUsd();
    let cost = null;
    try { cost = await budget(settings, list, balance); } catch (e) { cost = { error: e.message, balance }; }
    res.json({
      settings, run: runState(dir), balance, budget: cost,
      sheetUrl: state.sheetUrl, importedAt: state.importedAt, warnings: state.warnings || [],
      images: await imageStatus(dir, settings),
      sections: list.map((s) => ({
        ...s,
        rows: s.rows.map((row) => ({ ...row, prompt: buildPrompt(settings, row) })),
      })),
    });
  } catch (e) { next(e); }
});

async function imageStatus(dir, settings) {
  const out = {};
  for (const slot of Object.keys(SLOTS)) {
    const file = settings[slot];
    try {
      const st = await fs.stat(path.join(dir, file));
      out[slot] = { file, bytes: st.size, at: new Date(st.mtimeMs).toISOString() };
    } catch { out[slot] = null; }
  }
  return out;
}

// PATCH / { promptTemplate, negativePrompt, creditFloor, stopBetweenSections, wasabi:{…} }
r.patch("/", async (req, res, next) => {
  try { res.json(await writeSettings(req.proj.dir, req.body || {})); } catch (e) { next(e); }
});

// POST /import { sheetUrl? } -> parse and diff, commit nothing
r.post("/import", async (req, res, next) => {
  try { res.json(await importSheet(req.proj.dir, { sheetUrl: req.body?.sheetUrl, commit: false })); } catch (e) { next(e); }
});

// POST /import/commit { sheetUrl? } -> merge by segment id
r.post("/import/commit", async (req, res, next) => {
  try { res.json(await importSheet(req.proj.dir, { sheetUrl: req.body?.sheetUrl, commit: true })); } catch (e) { next(e); }
});

// POST /image { slot: "avatar"|"background", name, data(base64) } -> replaces the reference
r.post("/image", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    const { slot, name = "", data } = req.body || {};
    if (!SLOTS[slot]) throw httpError(400, 'slot must be "avatar" or "background"');
    if (!data) throw httpError(400, "data (base64) required");
    const settings = await readSettings(dir);
    const ext = (path.extname(name) || ".png").toLowerCase();
    const file = SLOTS[slot] + ext;
    await saveBase64(inside(dir, file), data);
    forgetImages(dir); // the data-URL cache is now stale
    await writeSettings(dir, { [slot]: file });
    res.status(201).json(await imageStatus(dir, { ...settings, [slot]: file }));
  } catch (e) { next(e); }
});

// POST /run { dryRun?, sections?: ["1.0"] } -> start the loop. dryRun costs nothing.
r.post("/run", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    const { dryRun = false, sections: only = null } = req.body || {};
    if (!dryRun) await assertReady(dir);
    res.json(await start(dir, { dryRun, sections: only }));
  } catch (e) { next(e); }
});

// POST /stop -> ask the run to stop; the row in flight is not abandoned
r.post("/stop", async (req, res, next) => {
  try { res.json(stop(req.proj.dir, req.body?.reason || "stopped by hand")); } catch (e) { next(e); }
});

/** Refuse to start a paid run with anything obviously missing. */
async function assertReady(dir) {
  const settings = await readSettings(dir);
  for (const slot of Object.keys(SLOTS)) {
    try { await fs.access(path.join(dir, settings[slot])); }
    catch { throw httpError(400, `No ${slot} image — upload it before running`); }
  }
  const rows = await listRows(dir);
  if (!rows.length) throw httpError(400, "No rows — import the sheet first");
  if (!rows.some(isPending)) throw httpError(400, "Nothing pending");
}

// POST /row/:rowId/render -> one row, the cheap test. Costs one clip.
r.post("/row/:rowId/render", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    const row = (await listRows(dir)).find((x) => x.id === req.params.rowId);
    if (!row) throw httpError(404, "No such segment " + req.params.rowId);
    if (row.sheetComplete) throw httpError(400, `Segment ${row.id} is marked Complete in the sheet`);
    await assertReadyImages(dir);
    if (row.status !== "pending") await patchRow(dir, row.id, (x) => { x.status = "pending"; x.error = null; });
    res.json(await start(dir, { sections: [row.section], rows: [row.id] }));
  } catch (e) { next(e); }
});

async function assertReadyImages(dir) {
  const settings = await readSettings(dir);
  for (const slot of Object.keys(SLOTS)) {
    try { await fs.access(path.join(dir, settings[slot])); }
    catch { throw httpError(400, `No ${slot} image — upload it before rendering`); }
  }
}

// GET /row/:rowId/quote -> price for one row, free
r.get("/row/:rowId/quote", async (req, res, next) => {
  try {
    const { dir } = req.proj;
    const settings = await readSettings(dir);
    const row = (await listRows(dir)).find((x) => x.id === req.params.rowId);
    if (!row) throw httpError(404, "No such segment " + req.params.rowId);
    res.json({ id: row.id, duration: row.duration, price: await quoteRow(settings, row), prompt: buildPrompt(settings, row) });
  } catch (e) { next(e); }
});

// POST /section/:sectionId/timeline -> rewrite timeline/<id>.json. Free and repeatable.
r.post("/section/:sectionId/timeline", async (req, res, next) => {
  try {
    const section = (await sections(req.proj.dir)).find((s) => s.id === req.params.sectionId);
    if (!section) throw httpError(404, "No such section " + req.params.sectionId);
    res.json(await writeTimeline(req.proj.dir, section));
  } catch (e) { next(e); }
});

// GET /wasabi-check -> credentials, bucket and the us-east-1 endpoint quirk, before any video exists
r.get("/wasabi-check", async (req, res, next) => {
  try {
    const settings = await readSettings(req.proj.dir);
    let wasabi;
    try { wasabi = await import("../lib/wasabi.js"); }
    catch { return res.json({ configured: false, error: "server/lib/wasabi.js not built yet" }); }
    res.json(await wasabi.check(settings.wasabi));
  } catch (e) { next(e); }
});

export default r;
