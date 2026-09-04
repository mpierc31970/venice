// Batch renderer unit tests — pure logic plus the rows.json lock.
// Run: node server/test/batch.test.mjs
//
// Makes no network calls and spends no Venice credit: fetch is stubbed to throw, so
// anything that reaches the API fails the test rather than quietly costing money.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VENICE_API_KEY = "test-key-not-used";
globalThis.fetch = async (url) => { throw new Error("no network in this test: " + url); };

const {
  buildPrompt, mergeRows, buildTimeline, priceOf, isPending, scriptHash,
  withRows, patchRow, listRows, readSettings, DEFAULTS, PROMPT_TEMPLATE, TRIM_SAFETY_S, FPS,
} = await import(new URL("../lib/batch.js", import.meta.url).href);

let failures = 0;
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
};
const ok = (cond, label) => eq(!!cond, true, label);

const seg = (id, over = {}) => ({
  id, section: "1.0", sectionLabel: "Lesson 1 - Section 1.0", n: 1, sheetRow: 2,
  script: "Every session begins with the same question.", visual: "", wantSeconds: 27,
  duration: "30s", sheetComplete: false, status: "pending", ...over,
});

/* ------------------------------------------------------------- prompt ---- */
console.log("prompt");
{
  const row = { scriptText: 'She said "hello" — twice.', visual: "", duration: "30s", section: "1.0" };
  const p = buildPrompt(DEFAULTS, row);
  ok(p.includes('"She said "hello" — twice."'), "script substituted verbatim, inside the quotes");
  ok(/@image1/.test(p) && /@image2/.test(p), "both image refs survive substitution");
  ok(!/\{(script|visual|duration|section)\}/.test(p), "no placeholder left behind");
  ok(/stops speaking/.test(p), "the tail instruction is present — this is what stops the invented sentence");
  eq(buildPrompt({ promptTemplate: "{section}/{duration}" }, row), "1.0/30s", "section and duration substitute");
  eq(buildPrompt({ promptTemplate: "a\n\n{visual}\n\nb" }, row), "a\n\nb", "an empty Visual leaves no blank gap");
  eq(buildPrompt({ promptTemplate: "a\n\n{visual}\n\nb" }, { ...row, visual: "chart" }), "a\n\nchart\n\nb",
     "a populated Visual lands where the template puts it");
  eq(buildPrompt({}, row), buildPrompt({ promptTemplate: PROMPT_TEMPLATE }, row), "missing template falls back to the default");
}

/* -------------------------------------------------------------- merge ---- */
console.log("\nmerge");
{
  const rendered = {
    id: "1.1", section: "1.0", n: 1, sheetRow: 2,
    scriptText: "Every session begins with the same question.",
    scriptHash: scriptHash("Every session begins with the same question."),
    duration: "30s", wantSeconds: 27, visual: "", sheetComplete: false,
    status: "uploaded", clip: "clips/1.0/1.1.mp4", jobId: "job_x", quote: 1.36,
    wasabiKey: "lesson1/clips/1.0/1.1.mp4", error: null, at: "2026-09-01T00:00:00.000Z",
  };

  const same = mergeRows([rendered], [seg("1.1")]);
  eq(same.diff, { added: [], changed: [], unchanged: ["1.1"], removed: [] }, "identical script is unchanged");
  eq(same.rows[0].status, "uploaded", "an unchanged row keeps its status");
  eq(same.rows[0].clip, "clips/1.0/1.1.mp4", "an unchanged row keeps its clip");
  eq(same.rows[0].wasabiKey, "lesson1/clips/1.0/1.1.mp4", "an unchanged row keeps its Wasabi key");

  const edited = mergeRows([rendered], [seg("1.1", { script: "Every session begins differently." })]);
  eq(edited.diff.changed, ["1.1"], "an edited script is a change");
  eq(edited.rows[0].status, "pending", "an edited script resets the row to pending — it must be re-rendered");
  eq(edited.rows[0].clip, null, "an edited row drops the stale clip reference");

  const retimed = mergeRows([rendered], [seg("1.1", { duration: "25s", wantSeconds: 22 })]);
  eq(retimed.diff.changed, ["1.1"], "a changed duration is a change even when the script is identical");

  const added = mergeRows([rendered], [seg("1.1"), seg("1.2", { n: 2, sheetRow: 3 })]);
  eq(added.diff.added, ["1.2"], "a new segment id is an add");

  const gone = mergeRows([rendered], [seg("1.2", { n: 2, sheetRow: 3 })]);
  eq(gone.diff.removed, ["1.1"], "an id gone from the sheet is a removal");
  const kept = gone.rows.find((r) => r.id === "1.1");
  eq(kept.status, "skipped", "a removed row is skipped, never deleted");
  eq(kept.clip, "clips/1.0/1.1.mp4", "a removed row keeps its clip — $1.36 is not thrown away on a reorder");

  const ticked = mergeRows([], [seg("1.1", { sheetComplete: true })]);
  eq(ticked.rows[0].status, "complete", "the sheet's Complete column outranks our state");
  eq(isPending(ticked.rows[0]), false, "a complete row never enters production");
  eq(isPending(mergeRows([], [seg("1.1")]).rows[0]), true, "an unmarked new row is pending");

  const order = mergeRows([], [seg("1.2", { n: 1 }), seg("1.1", { n: 2 })]);
  eq(order.rows.map((r) => r.id), ["1.2", "1.1"], "merge preserves sheet order — it is the edit order");
}

/* ----------------------------------------------------------- timeline ---- */
console.log("\ntimeline");
{
  const section = {
    id: "1.0", label: "Lesson 1 - Section 1.0",
    rows: [
      { id: "1.1", status: "uploaded", clip: "clips/1.0/1.1.mp4", duration: "30s", wantSeconds: 27, visual: "" },
      { id: "1.2", status: "rendered", clip: "clips/1.0/1.2.mp4", duration: "30s", wantSeconds: 30, visual: "chart" },
      { id: "1.3", status: "pending", clip: null, duration: "25s", wantSeconds: 22, visual: "" },
    ],
  };
  const t = buildTimeline(section);
  eq(t.segments.map((s) => s.id), ["1.1", "1.2"], "only rendered segments reach the timeline");
  eq(t.segments[0].clipFrames, 30 * FPS, "clipFrames is what Wan rendered");
  eq(t.segments[0].trimAfter, Math.round((27 + TRIM_SAFETY_S) * FPS), "trimAfter cuts the snap-up padding, plus safety");
  ok(t.segments[0].trimAfter < t.segments[0].clipFrames, "a 27s script in a 30s clip is trimmed");
  eq(t.segments[1].trimAfter, t.segments[1].clipFrames, "a 30s script in a 30s clip is not trimmed past its own end");
  eq(t.segments[1].visual, "chart", "the Visual note rides along for stage 2");
  eq(t.segments.map((s) => s.layout), ["full", "pip"], "a row with a Visual note goes pip; the rest stay full-frame");
  eq([t.fps, t.section], [FPS, "1.0"], "timeline carries fps and the section id");
}

/* -------------------------------------------------------------- quote ---- */
console.log("\nquote");
eq(priceOf({ quote: 1.36 }), 1.36, "priceOf unwraps Wan's { quote: 1.36 } — the live shape");
eq(priceOf({ quote: { usd: 1.14 } }), 1.14, "priceOf unwraps a nested object quote");
eq(priceOf({ price: 1.36 }), 1.36, "priceOf reads .price");
eq(priceOf({ usd: 1.14 }), 1.14, "priceOf reads .usd");
eq(priceOf({ cost: 0.91 }), 0.91, "priceOf reads .cost");
eq(priceOf(1.36), 1.36, "priceOf accepts a bare number");
eq(priceOf({ nothing: 1 }), null, "priceOf refuses to guess a price");

/* --------------------------------------------------------- rows.json ---- */
// rows.json is rewritten whole, the same hazard jobs.json had: an unguarded
// read-modify-write saves the array it read before awaiting a render, erasing every
// status written meanwhile. 109 rows over several hours makes that a certainty.
console.log("\nrows.json lock");
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "venice-batch-"));
  await withRows(dir, (s) => {
    s.rows = Array.from({ length: 12 }, (_, i) => ({ id: "1." + (i + 1), section: "1.0", status: "pending" }));
  });

  // Every patch awaits inside its mutate, which is exactly when the old bug struck.
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      patchRow(dir, "1." + (i + 1), (r) => { r.status = "rendered"; r.clip = `clips/1.0/1.${i + 1}.mp4`; })
    )
  );

  const rows = await listRows(dir);
  const lost = rows.filter((r) => r.status !== "rendered").map((r) => r.id);
  eq(lost, [], "12 concurrent row patches all persist");
  eq(rows.length, 12, "no row is dropped by the rewrite");

  const settings = await readSettings(dir);
  eq(settings.model, DEFAULTS.model, "settings fall back to defaults when batch.json is absent");
  eq(settings.stopBetweenSections, true, "a section the balance cannot finish is not begun, by default");
  eq(settings.creditFloor, 10, "the credit floor defaults to $10");

  await fs.rm(dir, { recursive: true, force: true });
}

console.log(failures ? `\nFAIL ${failures} assertion(s)` : "\nPASS all assertions");
process.exit(failures ? 1 : 0);
