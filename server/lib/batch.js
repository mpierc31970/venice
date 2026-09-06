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
import { readJson, writeJson, exists, P } from "./store.js";
import { enqueue, onJobDone } from "./jobs.js";
import { toDataUrl, stamp } from "./media.js";
import { model as getModel } from "./modelcache.js";
import { videoQuote, getBalance } from "../venice.js";
import { fetchSheet, parseCsv, rowsFromSheet, groupSections, parseLadder, sectionSeconds } from "./sheet.js";
import { setCells, colLetter, quoteTab } from "./gsheets.js";
import { slidesForSection, captionsFor } from "./slides.js";
import { diagramFor } from "./diagrams.js";

/* ------------------------------------------------------------ settings ---- */

// Two jobs, and the second one is why this is as long as it is.
//
// The tail instruction is the one that matters for a single clip. Duration snaps up to
// the model's ladder, so most clips carry 1-4s of padding after the last word, and a
// model given dead air invents a new sentence to fill it. What she does *instead* is
// left unsaid on purpose: the tail is trimmed at assembly, so an idle-performance
// description buys nothing and gives the model more to misread.
//
// Everything above the spoken line exists for the *cut*. Wan has no memory between
// clips, so a section is 8-17 independent generations that have to look like one take,
// and the only thing carrying framing from one to the next is this text. "Medium
// close-up" was not enough — it is an interpretation, and Wan interpreted it differently
// each time, drifting the shot size, the background scale and her position in frame.
// Read at the join, that reads as a mistake. So the framing is stated geometrically
// instead: where the top of her head sits, where her chin sits, what fills the lower
// corners. Those are the same sentences every time and they describe one composition.
//
// The camera and background lines are absolute for the same reason. A clip that pushes
// in even slightly ends on a different shot size than it began, so its last frame no
// longer matches the next clip's first.
//
// The background is now a green screen, and that is a retreat from arguing with the model
// rather than a new argument. Three commits tried to hold the room still by description
// and it still drifted and zoomed; the room is now composited in afterwards, where it
// cannot move at all. What is left here is the half the prompt was always good at — her,
// and how she is framed — plus the two lines that make her keyable: a flat, even screen,
// and front lighting with no green spilling onto her.
//
// The framing paragraph is unchanged on purpose. It is the part that was working, and the
// aspect moving to 1:1 does not change where her chin or her shoulders should sit.
export const PROMPT_TEMPLATE = `Static talking-head shot, locked-off camera on a tripod at eye level. One
woman, alone in front of a green screen.

Framing, the same in every frame: the woman from @image1, facing the camera and
looking into the lens, centered left to right, framed from mid-chest up. A
small, even gap above the top of her head. Her chin sits near the middle of the
frame and her shoulders fill the lower corners. She stays this size and in this
place from the first frame to the last.

Background: the plain chroma-key green screen from @image2, filling the frame
edge to edge. One flat, even, uniform shade of green. No objects, no furniture,
no texture, no pattern, no seams, no shadows cast on it, no gradient, no
vignette, no change in brightness across the frame. Nothing in the background
moves and the green never changes shade.

She is lit from the front, soft and even, as if standing in a bright daylit
room. No green light falls on her skin, her hair or her clothing, and there is
no green rim or halo around her edges.

The camera never moves: no zoom in, no zoom out, no push in, no pull back, no
dolly, no track, no crane, no pan, no tilt, no roll, no handheld drift, no
re-framing, no cut to another angle. The last frame has the same composition as
the first.

She speaks this line, and only this line: "{script}"

Only her face moves as she speaks. She does not lean toward or away from the
camera, does not stand up, and does not drift left or right.

After the last word she simply stops speaking. No new sentence, no repetition,
no further dialogue for the rest of the clip.`;

// The grid terms are not boilerplate: avatar.png *is* a four-panel contact sheet, and
// this is cheap insurance against the model echoing that layout into the video. The
// camera terms are listed one by one rather than as "camera movement" because that is
// how a negative prompt is read — a push-in is not obviously an instance of a category
// it was never named as part of.
export const NEGATIVE_PROMPT =
  "full body, wide shot, walking, standing up, leaning toward the camera, leaning back, " +
  "multiple people, split screen, grid, contact sheet, side-by-side panels, " +
  "camera movement, camera shake, handheld, zoom in, zoom out, push in, pull back, " +
  "dolly, tracking shot, crane, pan, tilt, reframing, changing shot size, jump cut, " +
  "scene change, changing background, cropped background, letterbox, black bars, " +
  "text overlay, " +
  // The key is only as good as the screen behind her and the light on her. Everything
  // below is something that survives chromakey as a visible fault: a shade that shifts
  // across the frame leaves the corners keyed and her middle not, and green bounced onto
  // her hair leaves a halo that despill cannot fully take back.
  "green light on skin, green tint, green rim light, green spill, green halo, " +
  "shadow on the background, gradient background, textured background, " +
  "patterned background, objects in the background, uneven lighting on the background, " +
  "dark corners, vignette";

export const DEFAULTS = {
  sheetUrl: process.env.SHEET_URL || "",
  model: "wan-3-0-reference-to-video",
  // Square, because Venice bills total pixels and not shape: 1:1 at 480p comes back as
  // 624x624, which is within ten thousand pixels of 832x480 and costs the identical
  // $1.36. Widescreen spends nearly a third of that budget on room either side of her —
  // room that is now keyed out and thrown away. The square spends it on her instead, and
  // she arrives 624 lines tall rather than 480.
  aspect: "1:1",
  resolution: "480p",
  audio: true,
  avatar: "avatar.png",
  // Two images that used to be one. `screen` is what Wan is given as @image2 and is now a
  // flat green field; `background` is the room, which Wan never sees at all — Remotion
  // composites it behind the keyed plate, where it cannot drift, zoom or be reinvented.
  screen: "green-screen.png",
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
  // @image2 is the green screen, not the room. The room is composited afterwards and is
  // never shown to the model — which is the whole point of the change.
  const screen = path.join(dir, settings.screen);
  const key = avatar + "|" + screen;
  const hit = imageCache.get(dir);
  if (hit && hit.key === key) return hit.urls;
  const urls = [await toDataUrl(avatar), await toDataUrl(screen)];
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
onJobDone(async (dir, job) => {
  if (!job.meta?.batchId) return;
  const resolve = waiters.get(job.id);
  if (resolve) { waiters.delete(job.id); resolve(job); return; }

  // No waiter means the run that started this job is gone — the server restarted while
  // the clip was rendering, which `node --watch` does on any file edit. The clip was
  // paid for either way, so record it rather than leaving the row "rendering" for ever
  // with a finished mp4 sitting on disk beside it.
  const rowId = job.meta.rowId;
  if (!rowId) return;
  try {
    await patchRow(dir, rowId, (r) => {
      if (job.status === "COMPLETED") { r.status = "rendered"; r.clip = job.outFile; r.error = null; }
      else { r.status = "failed"; r.error = job.error || `job ${job.status}`; }
      r.at = new Date().toISOString();
    });
    console.log(`[batch] recovered orphaned job ${job.id} for row ${rowId} (${job.status})`);
    // Recording the render is only half of it. The clip still has to reach Wasabi and the
    // sheet still has to be ticked, and with the run gone this hook is the only thing left
    // that can do either.
    if (job.status === "COMPLETED") {
      await finishRow(dir, rowId, {
        onSheetError: (e) => console.error(`[batch] sheet write-back failed for ${rowId}: ${e.message}`),
      });
    }
  } catch (e) { console.error("[batch] orphan recovery", e.message); }
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

/**
 * Forget a finished run's log and totals, so a rehearsal's numbers cannot be mistaken
 * later for a record of what was actually rendered. Refuses while a run is live.
 */
export function clearRun(dir) {
  const r = runners.get(dir);
  if (r?.running) throw new Error("A run is in progress — stop it before clearing");
  runners.delete(dir);
  return { running: false };
}

/**
 * Put a section back to pending so it can be rendered again — after a prompt change,
 * which is the only reason worth paying twice for the same words.
 *
 * Deletes nothing. The clips stay where they are and `preserveExisting` moves each one
 * aside the moment its replacement lands, so the old take survives even after the new
 * one is paid for. `timeline/<id>.json` and `sections/<id>.mp4` also stay: they describe
 * the clips that are still on disk, and both are free to rebuild once the new ones land.
 *
 * The sheet's Complete column has to be cleared too, and it is the part that is easy to
 * forget: it outranks our own state everywhere, so a row left marked would sit at
 * "complete" for ever no matter what rows.json says. A run refuses to start while one is
 * in flight, so this does too.
 */
export async function resetSection(dir, sectionId) {
  if (runners.get(dir)?.running) throw new Error("A run is in progress — stop it before resetting a section");

  const all = await listRows(dir);
  const rows = all.filter((r) => r.section === sectionId);
  if (!rows.length) throw new Error(`No section ${sectionId}`);

  // Clear the sheet first. If this throws, nothing local has changed yet and the section
  // is still consistent — the other order leaves rows that look runnable but are not.
  const state = await readState(dir);
  const col = state.columns?.complete;
  const marked = rows.filter((r) => r.sheetRow);
  if (state.sheetUrl && col != null && marked.length) {
    const tab = state.tab ? quoteTab(state.tab) + "!" : "";
    await setCells(state.sheetUrl, marked.map((r) => ({ range: `${tab}${colLetter(col)}${r.sheetRow}`, value: "" })));
  }

  const ids = new Set(rows.map((r) => r.id));
  await withRows(dir, (s) => {
    for (const row of s.rows) {
      if (!ids.has(row.id)) continue;
      Object.assign(row, {
        status: "pending",
        sheetComplete: false,
        jobId: null,
        clip: null,
        wasabiKey: null,
        quote: null,
        error: null,
        at: null,
      });
    }
  });

  return { section: sectionId, rows: rows.length, unmarkedInSheet: state.sheetUrl && col != null ? marked.length : 0 };
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

  // Before anything new is paid for, finish what an earlier stop left half-done. This is
  // free — those clips are already bought and on disk — and it is deliberately not part
  // of a dry run, which must not touch the sheet.
  if (!run.dryRun) {
    const finished = await finishStranded(dir, { onSheetError: (e) => log(run, `sheet write-back failed: ${e.message}`) });
    if (finished.length) log(run, `finished ${finished.length} row(s) left over from an earlier stop: ${finished.map((r) => r.id).join(", ")}`);
  }

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

  await finishRow(dir, row.id, { onSheetError: (e) => log(run, `sheet write-back failed for ${row.id}: ${e.message}`) });
}

/**
 * The tail of a paid row: upload the clip, then tick the sheet.
 *
 * This used to live inline at the end of renderRow, which meant it existed only for as
 * long as the run did. A restart between the render and these two steps — `node --watch`
 * does that on any file edit — left the row at "rendered": paid for and on disk, never
 * uploaded, never marked. `isPending` excludes such a row from every future run, so
 * nothing ever came back for it and the only way forward was to pay for the same clip a
 * second time. Out here it can be called again later, by the orphan hook or by the head
 * of the next run.
 *
 * Safe to call twice: it re-reads the row, skips an upload that already has a key and a
 * sheet write that has already happened. An upload failure still throws — a Wasabi 403 is
 * a configuration answer and the caller is entitled to halt the run on it — while a sheet
 * failure is reported through `onSheetError` and never costs the clip.
 */
export async function finishRow(dir, rowId, { onSheetError = null } = {}) {
  const settings = await readSettings(dir);
  const row = (await listRows(dir)).find((r) => r.id === rowId);
  if (!row?.clip) return row || null;

  if (bucketConfigured(settings) && !row.wasabiKey) {
    // The clip can be gone — deleted by hand between the render and here. That is not a
    // reason to abort the run, and it is certainly not a reason to tick Complete for a
    // clip nobody has: say so on the row and leave the decision to re-render to a person.
    if (!(await exists(path.join(dir, row.clip)))) {
      await patchRow(dir, rowId, (r) => {
        r.status = "failed";
        // Drop the path too. The row claiming a clip it does not have is what made it
        // look finishable in the first place, and leaving it set would send every later
        // run back round this same dead end.
        r.clip = null;
        r.error = `clip missing from disk (${row.clip}) — never uploaded, so nothing to finish`;
      });
      return (await listRows(dir)).find((r) => r.id === rowId);
    }
    const key = await uploadClip(dir, settings, row, path.join(dir, row.clip));
    if (key) await patchRow(dir, rowId, (r) => { r.status = "uploaded"; r.wasabiKey = key; });
  }

  if (settings.markCompleteInSheet && !row.sheetComplete) {
    try {
      // A null return means write-back is not configured for this row — no sheet, no
      // Complete column, no line number — which is not the same as having marked it.
      if (await markComplete(dir, row)) await patchRow(dir, rowId, (r) => { r.sheetComplete = true; });
    } catch (e) {
      if (!onSheetError) throw e;
      onSheetError(e);
    }
  }

  return (await listRows(dir)).find((r) => r.id === rowId);
}

/**
 * Finish every row an earlier run left half-done. Costs nothing — the clips are already
 * paid for and on disk — so it runs at the head of each run, which is what makes a stop
 * mid-upload recoverable rather than permanent.
 */
export async function finishStranded(dir, { onSheetError = null } = {}) {
  const settings = await readSettings(dir);
  const bucket = bucketConfigured(settings);
  const stranded = (await listRows(dir)).filter((r) =>
    r.clip && ((bucket && !r.wasabiKey) || (settings.markCompleteInSheet && !r.sheetComplete)));

  const done = [];
  for (const row of stranded) done.push(await finishRow(dir, row.id, { onSheetError }));
  return done;
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

/** Is there anywhere to upload to at all? With no bucket a run keeps its clips locally. */
const bucketConfigured = (settings) => Boolean(settings.wasabi?.bucket || process.env.WASABI_BUCKET);

/** Upload the clip. With no bucket configured a run still renders and keeps clips locally. */
async function uploadClip(dir, settings, row, absFile) {
  if (!bucketConfigured(settings)) return null;
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

/**
 * Straight cut at every join (user, 2026-09-04). This replaced a 6-frame cross-dissolve
 * that had been argued for on the grounds it would soften the position jump between two
 * independent generations of the same person; the answer was no dissolve, so there is
 * none. `frames: 0` is not a disabled dissolve — it is the whole transition.
 *
 * Kept in the shape `{ kind, frames }` so the assembler has one thing to read and the
 * arithmetic below stays the same: zero frames of overlap means the section is exactly
 * the sum of its trimmed segments.
 */
export const TRANSITION = { kind: "cut", frames: 0 };

export function buildTimeline(section, { fps = FPS, width = 1920, height = 1080 } = {}) {
  // Emphasis slides are chosen across the whole section, so two never land back to back.
  const slides = slidesForSection(section.rows);
  const rendered = section.rows.filter((r) => RENDERED.has(r.status));
  const cut = (r) => Math.min(
    Math.round(parseInt(r.duration, 10) * fps),
    Math.round((r.wantSeconds + TRIM_SAFETY_S) * fps)
  );
  // A transition that overlaps two clips shortens the section by one of itself per join —
  // n-1, not n. Cuts overlap nothing, so this is zero and the section is the sum of its
  // segments; the term stays because the arithmetic has to be right either way.
  const overlap = TRANSITION.frames * Math.max(0, rendered.length - 1);
  const durationInFrames = Math.max(0, rendered.reduce((n, r) => n + cut(r), 0) - overlap);

  return {
    section: section.id,
    label: section.label,
    fps, width, height,
    durationInFrames,
    // Uniform across every join.
    transition: TRANSITION,
    // The avatar's treatment is fixed, not per-segment: a circle in the lower right when
    // a graphic has the frame, full screen otherwise. There is no third layout.
    //
    // `motion: "none"` and `transition: "cut"` are the whole specification, and they are
    // stated as data because the idiomatic Remotion component does the opposite: a spring
    // scale as the circle appears is what anyone would reach for, and it is wrong here.
    // The circle does not zoom in, scale up, fade, slide, drift or breathe. It is absent,
    // and then on the next frame it is present, at the same size and the same place every
    // time. A presenter who moves around the frame between cuts reads as an error —
    // especially across 8 to 17 independent generations of what should be one take.
    avatar: {
      pip: { shape: "circle", corner: "bottom-right", size: 0.25 },
      motion: "none",      // no zoom, no scale, no drift — ever
      transition: "cut",   // appears and disappears on a single frame boundary
    },
    segments: rendered.map((r) => ({
      id: r.id,
      clip: r.clip,
      clipFrames: Math.round(parseInt(r.duration, 10) * fps),
      trimAfter: Math.min(
        Math.round(parseInt(r.duration, 10) * fps),
        Math.round((r.wantSeconds + TRIM_SAFETY_S) * fps)
      ),
      // The sheet already chose: the 11 rows carrying a Visual note are the ones where a
      // graphic belongs, and they are spread one or two per section. "pip" means the
      // graphic takes the frame and the talking head shrinks into a corner — the notes
      // describe comparisons, workflows and decision guides, which are unreadable the
      // other way round at this resolution. Nothing is randomised: a head that shrinks
      // mid-sentence for no reason reads as a glitch rather than an edit. Override by
      // editing the value here — Remotion reloads instantly and it costs nothing.
      layout: r.visual ? "pip" : "full",
      visual: r.visual || null,
      slide: slides.get(r.id) || null,
      // The diagram's structure and every word in it come from the script; only the
      // title is human-written. Remotion renders it by `kind` — list, sequence,
      // comparison, or plain points when the script has no detectable structure.
      diagram: diagramFor(r),
      captions: captionsFor(r, fps),
    })),
  };
}

export async function writeTimeline(dir, section) {
  const timeline = buildTimeline(section);
  await writeJson(P.timeline(dir, section.id), timeline);
  return timeline;
}
