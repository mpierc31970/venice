// Talking-head batch renderer — state, prompt building, and the section-ordered run loop.
//
// Money safety is the whole design of this file:
//
//  * Nothing here starts on import or on server boot. `start()` is the only door in,
//    and `start(dir, { dryRun: true })` walks the entire run — quotes, budget checks,
//    composed prompts — without enqueuing a single job. That is the $0 gate.
//  * Rows are walked section at a time. A section is not begun unless the *whole*
//    section fits inside the balance, so a stop leaves finished sections behind rather
//    than an undeliverable fragment. `stopBetweenSections` turns that off deliberately.
//  * Three consecutive failures halt the run. One content-moderation rejection should
//    not kill it; a systematic payload bug would otherwise burn the whole lesson.
//  * A clip that already exists on disk is never silently overwritten — it cost real
//    money, so a re-render moves the old file aside first.
//
// The sheet's Complete column outranks our own state everywhere: a row marked complete
// never enters production, however it got that way.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readJson, writeJson, P } from "./store.js";
import { enqueue, onJobDone } from "./jobs.js";
import { toDataUrl, stamp } from "./media.js";
import { model as getModel } from "./modelcache.js";
import { videoQuote, getBalance } from "../venice.js";
import { fetchSheet, parseCsv, rowsFromSheet, groupSections, parseLadder, sectionSeconds } from "./sheet.js";
import { setCells, colLetter, quoteTab } from "./gsheets.js";

/* ------------------------------------------------------------ settings ---- */

// The tail instruction is the one that matters. Duration snaps up to the model's
// ladder, so most clips carry 1–4s of padding after the last word, and a model given
// dead air invents a new sentence to fill it. What she does *instead* is left unsaid
// on purpose: the tail is trimmed at assembly, so an idle-performance description
// buys nothing and gives the model more to misread.
export const PROMPT_TEMPLATE = `Talking-head video. Medium close-up of the woman from avatar @image1 — head and
shoulders only, centered in frame, facing the camera. Background is @image2.
Good lighting, fixed camera, no camera movement.

She speaks this line, and only this line: "{script}"

After the last word she simply stops speaking. No new sentence, no repetition,
no further dialogue for the rest of the clip.`;

// The grid terms are not boilerplate: avatar.png *is* a four-panel contact sheet, and
// this is cheap insurance against the model echoing that layout into the video.
export const NEGATIVE_PROMPT =
  "full body, wide shot, walking, standing, multiple people, split screen, grid, " +
  "contact sheet, side-by-side panels, camera movement, zoom, pan, text overlay";

export const DEFAULTS = {
  sheetUrl: process.env.SHEET_URL || "",
  model: "wan-3-0-reference-to-video",
  aspect: "16:9",
  resolution: "480p",
  audio: true,
  avatar: "avatar.png",
  background: "background.png",
  promptTemplate: PROMPT_TEMPLATE,
  negativePrompt: NEGATIVE_PROMPT,
  creditFloor: 10,          // stop while this much balance is still left
  stopBetweenSections: true, // never begin a section the balance cannot finish
  maxConsecutiveFailures: 3,
  markCompleteInSheet: true,
  wasabi: { bucket: "", prefix: "", region: "" },
};

export async function readSettings(dir) {
  const saved = (await readJson(P.batch(dir), {})) || {};
  return { ...DEFAULTS, ...saved, wasabi: { ...DEFAULTS.wasabi, ...(saved.wasabi || {}) } };
}

export async function writeSettings(dir, patch) {
  const next = { ...(await readSettings(dir)), ...patch };
  if (patch?.wasabi) next.wasabi = { ...(await readSettings(dir)).wasabi, ...patch.wasabi };
  await writeJson(P.batch(dir), next);
  return next;
}

/* ----------------------------------------------------------- rows lock ---- */

/**
 * Serialize every read-modify-write of rows.json, exactly as jobs.js does for
 * jobs.json (jobs.js:21-40). Same file, same hazard: it is rewritten whole, so an
 * unguarded caller saves the array it read before awaiting a render and erases every
 * status written meanwhile. Keep the critical section short — never await network
 * work inside `fn`.
 */
const chains = new Map(); // dir -> Promise

async function loadState(dir) {
  return (await readJson(P.rows(dir), null)) || { rows: [], sheetUrl: "", tab: "", columns: null, warnings: [], importedAt: null };
}

export function withRows(dir, fn) {
  const run = (chains.get(dir) || Promise.resolve()).then(async () => {
    const state = await loadState(dir);
    const out = await fn(state);
    await writeJson(P.rows(dir), state);
    return out;
  });
  chains.set(dir, run.catch(() => {}));
  return run;
}

/** Apply `mutate` to one row under the lock, on a freshly loaded state. */
export function patchRow(dir, id, mutate) {
  return withRows(dir, (state) => {
    const row = state.rows.find((r) => r.id === id);
    if (row) mutate(row);
    return row;
  });
}

export async function listRows(dir) { return (await loadState(dir)).rows; }
export async function readState(dir) { return loadState(dir); }

/* -------------------------------------------------------------- import ---- */

export const scriptHash = (text) => crypto.createHash("sha1").update(String(text)).digest("hex").slice(0, 12);

/** The model's allowed durations, e.g. [2,5,10,15,20,25,30]. Falls back to Wan's ladder. */
export async function ladderFor(modelId) {
  try {
    const m = await getModel(modelId);
    const ladder = parseLadder(m?.model_spec?.constraints?.durations || []);
    if (ladder.length) return ladder;
  } catch { /* offline or unknown model — fall through */ }
  return [2, 5, 10, 15, 20, 25, 30];
}

/**
 * Merge freshly parsed sheet rows onto what we already have, keyed on segment id.
 * Pure, so the import preview and the commit run the identical logic — the preview is
 * this function's diff, thrown away.
 *
 *   unchanged script -> keeps its status, clip, jobId and Wasabi key untouched
 *   changed script   -> resets to pending (it has to be re-rendered, and that costs)
 *   gone from sheet  -> "skipped", never deleted; a $1.36 clip is not thrown away
 *                       because someone reordered the spreadsheet
 */
export function mergeRows(existing = [], incoming = []) {
  const before = new Map(existing.map((r) => [r.id, r]));
  const rows = [];
  const diff = { added: [], changed: [], unchanged: [], removed: [] };

  for (const fresh of incoming) {
    const hash = scriptHash(fresh.script);
    const prev = before.get(fresh.id);
    const row = {
      id: fresh.id,
      section: fresh.section,
      sectionLabel: fresh.sectionLabel,
      n: fresh.n,
      sheetRow: fresh.sheetRow,
      scriptText: fresh.script,
      scriptHash: hash,
      visual: fresh.visual,
      wantSeconds: fresh.wantSeconds,
      duration: fresh.duration,
      sheetComplete: fresh.sheetComplete,
      status: "pending",
      jobId: null, clip: null, quote: null, error: null, wasabiKey: null, at: null,
    };

    if (!prev) {
      diff.added.push(fresh.id);
    } else if (prev.scriptHash === hash && prev.duration === fresh.duration) {
      Object.assign(row, {
        status: prev.status, jobId: prev.jobId, clip: prev.clip, quote: prev.quote,
        error: prev.error, wasabiKey: prev.wasabiKey, at: prev.at,
      });
      diff.unchanged.push(fresh.id);
    } else {
      diff.changed.push(fresh.id); // stays pending — a changed script means a re-render
    }

    // The sheet's Complete column wins over everything above.
    if (row.sheetComplete && row.status !== "uploaded") row.status = "complete";
    rows.push(row);
  }

  for (const old of existing) {
    if (rows.some((r) => r.id === old.id)) continue;
    diff.removed.push(old.id);
    rows.push({ ...old, status: "skipped" });
  }

  return { rows, diff };
}

/**
 * Fetch and parse the sheet, and merge it onto the stored manifest.
 * `commit: false` (the default) writes nothing — that is the import preview, and it is
 * what shows "5 new, 3 changed (≈$4.08 to re-render)" before anyone spends anything.
 */
export async function importSheet(dir, { sheetUrl, commit = false } = {}) {
  const settings = await readSettings(dir);
  const url = sheetUrl || settings.sheetUrl;
  if (!url) throw new Error("No sheet URL — set sheetUrl in batch.json or SHEET_URL in .env");

  const ladder = await ladderFor(settings.model);
  const parsed = parseCsv(await fetchSheet(url));
  const { rows: incoming, warnings, columns } = rowsFromSheet(parsed, ladder);
  const sections = groupSections(incoming); // throws if sections are not contiguous

  const state = await loadState(dir);
  const { rows, diff } = mergeRows(state.rows, incoming);

  if (commit) {
    await withRows(dir, (s) => {
      s.rows = rows;
      s.sheetUrl = url;
      s.columns = columns;
      s.warnings = warnings;
      s.importedAt = new Date().toISOString();
    });
    if (url !== settings.sheetUrl) await writeSettings(dir, { sheetUrl: url });
  }

  return {
    committed: commit,
    counts: {
      rows: rows.length,
      added: diff.added.length,
      changed: diff.changed.length,
      unchanged: diff.unchanged.length,
      removed: diff.removed.length,
      sections: sections.length,
    },
    diff, warnings, columns,
    sections: sections.map((s) => ({ id: s.id, label: s.label, rows: s.rows.length, seconds: sectionSeconds(s) })),
    rows,
  };
}

/* ------------------------------------------------------------ sections ---- */

const RENDERED = new Set(["rendered", "uploaded"]);
const DONE = new Set(["rendered", "uploaded", "complete", "skipped"]);
export const isPending = (row) => row.status === "pending" && !row.sheetComplete;

/**
 * Sections are derived, never stored — a re-import cannot leave section state stale.
 * Sheet order is edit order, so grouping walks the rows and cuts where column A changes.
 */
export async function sections(dir) {
  const rows = await listRows(dir);
  return groupSections(rows.filter((r) => r.status !== "skipped")).map((s) => ({
    id: s.id,
    label: s.label,
    seconds: sectionSeconds(s),
    rows: s.rows,
    pending: s.rows.filter(isPending).length,
    failed: s.rows.filter((r) => r.status === "failed").length,
    complete: s.rows.every((r) => DONE.has(r.status)),
  }));
}

/* -------------------------------------------------------------- prompt ---- */

/**
 * Compose one row's prompt. Placeholders: {script} {duration} {section} — and {visual},
 * which the default template deliberately does not use. A Visual note describes a graphic
 * for Remotion to lay over the clip in stage 2, not something for her to say or the room
 * to contain; it reaches stage 2 through buildTimeline. The substitution stays wired in
 * case a template ever wants it.
 * Wan takes its speech from the prompt — there is no separate script field — which is
 * why the spoken line is quoted and explicitly labelled in the template.
 */
export function buildPrompt(settings, row) {
  const values = {
    script: row.scriptText || "",
    visual: row.visual || "",
    duration: row.duration || "",
    section: row.section || "",
  };
  return String(settings.promptTemplate || PROMPT_TEMPLATE)
    .replace(/\{(script|visual|duration|section)\}/g, (_, key) => values[key])
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Both images go in whole and unmodified, flat and in order, so they are literally
 * @image1 and @image2 — matching the prompt as written. Cached per directory: this is
 * ~3.8 MB of base64 and it must not be rebuilt 109 times.
 */
const imageCache = new Map(); // dir -> { key, urls }
export async function buildImageRefs(dir, settings) {
  const avatar = path.join(dir, settings.avatar);
  const background = path.join(dir, settings.background);
  const key = avatar + "|" + background;
  const hit = imageCache.get(dir);
  if (hit && hit.key === key) return hit.urls;
  const urls = [await toDataUrl(avatar), await toDataUrl(background)];
  imageCache.set(dir, { key, urls });
  return urls;
}
export const forgetImages = (dir) => imageCache.delete(dir);

/** The exact /video/queue payload for one row. */
export async function buildRequest(dir, settings, row) {
  return {
    model: settings.model,
    prompt: buildPrompt(settings, row),
    negative_prompt: settings.negativePrompt,
    duration: row.duration,
    resolution: settings.resolution,
    aspect_ratio: settings.aspect,
    audio: settings.audio,
    reference_image_urls: await buildImageRefs(dir, settings),
  };
}

/* --------------------------------------------------------------- quote ---- */

// /video/quote takes only {model, duration, resolution, aspect_ratio, audio} — no
// prompt, no images — so the price depends on duration alone and caches per duration.
const priceCache = new Map(); // "model|duration|resolution|aspect|audio" -> number

/**
 * Pull the price out of a /video/quote answer.
 * Wan replies `{ quote: 1.36 }` — the number is nested — and other models have been seen
 * to use price/usd/cost, so the wrapper is unwrapped first and then every known field
 * name tried. It returns null rather than guessing, and a null halts the row: an
 * unpriced render is an unbudgeted one.
 */
export function priceOf(q) {
  if (q == null) return null;
  if (typeof q === "number") return q;
  if (q.quote !== undefined) return priceOf(q.quote);
  return q.price ?? q.usd ?? q.cost ?? null;
}

export async function quoteRow(settings, row) {
  const body = {
    model: settings.model, duration: row.duration, resolution: settings.resolution,
    aspect_ratio: settings.aspect, audio: settings.audio,
  };
  const key = Object.values(body).join("|");
  if (priceCache.has(key)) return priceCache.get(key);
  const price = priceOf(await videoQuote(body));
  if (price == null) throw new Error(`Venice quoted ${row.duration} with no price field`);
  priceCache.set(key, price);
  return price;
}

/** What a set of rows will cost. Quotes are free, so this is safe to call on a page load. */
export async function rowsCost(settings, rows) {
  let total = 0;
  for (const row of rows) total += await quoteRow(settings, row);
  return total;
}

/** What the remaining pending rows of a section will cost. */
export const sectionCost = (settings, section) => rowsCost(settings, section.rows.filter(isPending));

/* ------------------------------------------------------- job completion ---- */

// jobs.js fires this hook for every job in every project, so it early-returns unless
// the job is ours — mirroring shots.js:250. Registered once, at import.
const waiters = new Map(); // jobId -> resolve
onJobDone((dir, job) => {
  if (!job.meta?.batchId) return;
  const resolve = waiters.get(job.id);
  if (resolve) { waiters.delete(job.id); resolve(job); }
});

const JOB_TIMEOUT_MS = 30 * 60 * 1000;

/** Resolve when the job reaches a terminal state, or reject if it never does. */
function awaitJob(jobId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(jobId);
      reject(new Error(`Job ${jobId} did not finish within ${JOB_TIMEOUT_MS / 60000} minutes`));
    }, JOB_TIMEOUT_MS);
    waiters.set(jobId, (job) => { clearTimeout(timer); resolve(job); });
  });
}

/* ------------------------------------------------------------ run loop ---- */

const runners = new Map(); // dir -> run state

export function runState(dir) {
  const r = runners.get(dir);
  if (!r) return { running: false };
  const { abort, ...rest } = r;
  return rest;
}

/**
 * What the run still has to spend.
 *
 * A real run reads this straight from Venice, whose balance falls as clips are charged.
 * A dry run charges nothing, so every section would look individually affordable and the
 * walk would sail past the point where the real thing stops — the free rehearsal would
 * then be lying about the paid performance, which is the one thing it must not do. So a
 * dry run draws its own balance down by what it says it would spend.
 */
async function spendable(run) {
  const balance = await balanceUsd();
  if (balance == null) return null;
  return run.dryRun ? balance - run.spent : balance;
}

/** Ask a run to stop. It finishes the row in flight — a clip already paid for is not abandoned. */
export function stop(dir, reason = "stopped by hand") {
  const r = runners.get(dir);
  if (!r || !r.running) return { running: false };
  r.stopping = true;
  r.reason = reason;
  return runState(dir);
}

const log = (r, message, extra = {}) => {
  r.log.push({ at: new Date().toISOString(), message, ...extra });
  if (r.log.length > 400) r.log.splice(0, r.log.length - 400);
  console.log("[batch]", message);
};

/**
 * Start the run. This is the only thing in this module that spends money, and only
 * when `dryRun` is false — a dry run performs every quote, budget check and prompt
 * composition and stops short of `enqueue`, for $0.
 *
 * Returns immediately; the loop runs in the background so it survives the browser
 * closing. Poll `runState(dir)`.
 */
export async function start(dir, { dryRun = false, sections: only = null, rows: onlyRows = null } = {}) {
  if (runners.get(dir)?.running) throw new Error("A run is already in progress for this folder");

  const runId = "run_" + stamp();
  const state = {
    running: true, stopping: false, dryRun, runId, reason: null,
    startedAt: new Date().toISOString(), finishedAt: null,
    current: null, spent: 0, rendered: 0, failed: 0, log: [],
  };
  runners.set(dir, state);

  loop(dir, state, only, onlyRows).catch((e) => {
    state.reason = e.message;
    log(state, "run aborted: " + e.message);
  }).finally(() => {
    state.running = false;
    state.current = null;
    state.finishedAt = new Date().toISOString();
  });

  return runState(dir);
}

async function loop(dir, run, only, onlyRows) {
  const settings = await readSettings(dir);
  const all = await sections(dir);
  // `onlyRows` is the single-row test: it renders exactly what was named, nothing else.
  const pick = (s) => s.rows.filter((r) => isPending(r) && (!onlyRows || onlyRows.includes(r.id)));
  const todo = all.filter((s) => (!only || only.includes(s.id)) && pick(s).length);

  log(run, `${run.dryRun ? "dry run" : "run"} ${run.runId}: ${todo.length} section(s), ${todo.reduce((n, s) => n + pick(s).length, 0)} pending row(s)`);
  if (!todo.length) { run.reason = "nothing pending"; return; }

  // Fail before spending anything if the references are missing.
  if (!run.dryRun) await buildImageRefs(dir, settings);

  let consecutiveFailures = 0;

  for (const section of todo) {
    if (run.stopping) return;

    // The whole-section budget check is the point of the section ordering: starting a
    // section the balance cannot finish spends money on an undeliverable fragment.
    // A named-row run is exempt — it is an explicit, single, cheap test.
    const rows = pick(section);
    const cost = await rowsCost(settings, rows);
    const balance = await spendable(run);
    if (balance == null) {
      // Unknown balance is not permission to spend.
      run.reason = "cannot read the Venice balance — halting rather than rendering blind";
      log(run, run.reason);
      return;
    }
    if (!onlyRows && settings.stopBetweenSections && balance < cost + settings.creditFloor) {
      run.reason = `not enough credit for section ${section.id} ($${cost.toFixed(2)} + $${settings.creditFloor} floor, balance $${balance.toFixed(2)})`;
      log(run, run.reason);
      return;
    }
    log(run, `section ${section.id}: ${rows.length} row(s), $${cost.toFixed(2)}`);

    for (const row of rows) {
      if (run.stopping) { log(run, "stopping: " + run.reason); return; }

      const quote = await quoteRow(settings, row);
      const bal = await spendable(run);
      if (bal == null) {
        run.reason = "cannot read the Venice balance — halting rather than rendering blind";
        log(run, run.reason);
        return;
      }
      if (bal < quote + settings.creditFloor) {
        run.reason = `low credits — $${bal.toFixed(2)} left, row ${row.id} needs $${quote.toFixed(2)} + $${settings.creditFloor} floor`;
        log(run, run.reason);
        return;
      }

      run.current = { section: section.id, row: row.id, quote };
      const request = await buildRequest(dir, settings, row);

      if (run.dryRun) {
        log(run, `would render ${row.id} (${row.duration}, $${quote.toFixed(2)})`, { rowId: row.id, prompt: request.prompt });
        run.spent += quote;
        continue;
      }

      try {
        await renderRow(dir, settings, run, row, request, quote);
        consecutiveFailures = 0;
      } catch (e) {
        // A 403 from Wasabi is a configuration answer, not a transient one. Halting on
        // the first one is the difference between one wasted clip and 109.
        if (e.fatal) {
          run.reason = `halted: ${e.message}`;
          log(run, run.reason);
          return;
        }
        consecutiveFailures += 1;
        run.failed += 1;
        await patchRow(dir, row.id, (r) => { r.status = "failed"; r.error = e.message; r.at = new Date().toISOString(); });
        log(run, `row ${row.id} failed: ${e.message}`, { rowId: row.id });
        // One moderation rejection should not kill the run; a systematic payload bug
        // would otherwise burn the whole lesson.
        if (consecutiveFailures >= settings.maxConsecutiveFailures) {
          run.reason = `${consecutiveFailures} failures in a row — halting`;
          log(run, run.reason);
          return;
        }
      }
    }

    // Stage 1 ends at the timeline file. Assembly is separate, free and repeatable —
    // it must never be coupled to anything that costs money.
    const after = (await sections(dir)).find((s) => s.id === section.id);
    if (after?.complete && !run.dryRun) await writeTimeline(dir, after);
  }

  run.reason = run.reason || "finished";
  log(run, "done — " + run.reason);
}

/** One paid row: enqueue a single job, wait for it, upload, tick the sheet. */
async function renderRow(dir, settings, run, row, request, quote) {
  const outFile = P.clip(dir, row.section, row.id);
  await preserveExisting(outFile);

  await patchRow(dir, row.id, (r) => { r.status = "rendering"; r.quote = quote; r.error = null; r.at = new Date().toISOString(); });

  const job = await enqueue(dir, { request, outFile, meta: { batchId: run.runId, rowId: row.id } });
  await patchRow(dir, row.id, (r) => { r.jobId = job.id; });
  // So the page can show progress for the row in flight.
  run.current = { ...run.current, jobId: job.id };
  log(run, `rendering ${row.id} (${row.duration}, $${quote.toFixed(2)}) as ${job.id}`, { rowId: row.id });

  const done = await awaitJob(job.id);
  if (done.status !== "COMPLETED") throw new Error(done.error || `job ${done.status}`);
  run.current = { ...run.current, stage: "uploading" };

  run.spent += quote;
  run.rendered += 1;
  await patchRow(dir, row.id, (r) => { r.status = "rendered"; r.clip = done.outFile; r.at = new Date().toISOString(); });

  const key = await uploadClip(dir, settings, row, path.join(dir, done.outFile));
  if (key) await patchRow(dir, row.id, (r) => { r.status = "uploaded"; r.wasabiKey = key; });

  if (settings.markCompleteInSheet) await markComplete(dir, row).catch((e) => log(run, `sheet write-back failed for ${row.id}: ${e.message}`));
}

/** A clip cost real money — never overwrite one silently. */
async function preserveExisting(absFile) {
  try {
    await fs.access(absFile);
    await fs.rename(absFile, absFile.replace(/\.mp4$/, `.${stamp()}.mp4`));
  } catch { /* nothing there, which is the normal case */ }
}

/**
 * Balance in USD, or null when Venice cannot be read.
 * The live shape is { balances: { usd, diem } } — the older flat forms are kept as
 * fallbacks. Getting this wrong reads as "no balance", and a null balance must never
 * be treated as "plenty": the run halts instead.
 */
export async function balanceUsd() {
  try {
    const b = await getBalance();
    return b?.balances?.usd ?? b?.balances?.USD ?? b?.usd ?? b?.USD ?? null;
  } catch { return null; }
}

/** Upload the clip. With no bucket configured a run still renders and keeps clips locally. */
async function uploadClip(dir, settings, row, absFile) {
  if (!settings.wasabi?.bucket && !process.env.WASABI_BUCKET) return null;
  const wasabi = await import("./wasabi.js");
  return wasabi.putClip(settings.wasabi, { section: row.section, id: row.id, file: absFile });
}

/** Tick the sheet's Complete column, so the sheet stays the source of truth. */
async function markComplete(dir, row) {
  const state = await loadState(dir);
  const col = state.columns?.complete;
  if (!state.sheetUrl || col == null || !row.sheetRow) return null;
  const tab = state.tab ? quoteTab(state.tab) + "!" : "";
  return setCells(state.sheetUrl, [{ range: `${tab}${colLetter(col)}${row.sheetRow}`, value: "x" }]);
}

/**
 * The seam between the two stages: the renderer writes timeline/<section>.json,
 * Remotion reads it. `trimAfter` carries the scripted length plus a little safety, so
 * the snap-up padding is cut at assembly rather than reaching the viewer.
 */
export const TRIM_SAFETY_S = 0.4;
export const FPS = 30;

export function buildTimeline(section, { fps = FPS, width = 1920, height = 1080 } = {}) {
  return {
    section: section.id,
    label: section.label,
    fps, width, height,
    segments: section.rows.filter((r) => RENDERED.has(r.status)).map((r) => ({
      id: r.id,
      clip: r.clip,
      clipFrames: Math.round(parseInt(r.duration, 10) * fps),
      trimAfter: Math.min(
        Math.round(parseInt(r.duration, 10) * fps),
        Math.round((r.wantSeconds + TRIM_SAFETY_S) * fps)
      ),
      layout: "full",
      visual: r.visual || null,
    })),
  };
}

export async function writeTimeline(dir, section) {
  const timeline = buildTimeline(section);
  await writeJson(P.timeline(dir, section.id), timeline);
  return timeline;
}
