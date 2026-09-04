// Sheet parser tests against the live Google Sheet.
// Run: node server/test/sheet.test.mjs
//
// Assertions encode facts measured from the real production script. If the
// parser reproduces the section counts and the duration histogram, the
// grouping rule and the snap policy are right.
import {
  fetchSheet, csvUrl, parseCsv, rowsFromSheet, groupSections, sectionSeconds,
  snapUp, parseSeconds, parseSection, isComplete, mapColumns,
} from "../lib/sheet.js";

const SHEET = process.env.SHEET_URL
  || "https://docs.google.com/spreadsheets/d/1MtNI8HK22aQnKGtARFBs9sFZWFKMSRUEtKRSm_4ZuU8/edit?usp=sharing";
const LADDER = [2, 5, 10, 15, 20, 25, 30];
const PRICE = { 20: 0.91, 25: 1.14, 30: 1.36 };

let failures = 0;
// Stable stringify: plain-object key order is an artefact of insertion, not a fact
// under test. Arrays keep their order, which for sections and ids is the point.
const norm = (v) =>
  Array.isArray(v) ? v.map(norm)
  : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]))
    : v;
const eq = (actual, expected, label) => {
  const a = JSON.stringify(norm(actual)), e = JSON.stringify(norm(expected));
  if (a === e) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
};
const ok = (cond, label) => eq(!!cond, true, label);

console.log("unit");
eq(snapUp(22, LADDER), "25s", "snapUp 22 -> 25s");
eq(snapUp(25, LADDER), "25s", "snapUp 25 -> 25s (exact stays)");
eq(snapUp(26, LADDER), "30s", "snapUp 26 -> 30s");
eq(snapUp(27, LADDER), "30s", "snapUp 27 -> 30s (never down to 25)");
eq(snapUp(31, LADDER), "30s", "snapUp above ceiling clamps");
eq(parseSeconds("30 secs - 65 words"), 30, "parseSeconds");
eq(parseSeconds("no timing here"), null, "parseSeconds refuses to guess");
eq(parseSection("Lesson 1 - Section 1.0"), "1.0", "parseSection");
eq([isComplete("x"), isComplete("YES"), isComplete(true), isComplete("Done")],
   [true, true, true, true], "isComplete accepts common markers");
eq([isComplete(""), isComplete(null), isComplete("no"), isComplete(0)],
   [false, false, false, false], "isComplete rejects blanks and negatives");
eq(mapColumns(["Lesson - Section", "Production Segment", "Timing - Words", "Visual", "Script", "Complete"]),
   { section: 0, id: 1, timing: 2, visual: 3, script: 4, complete: 5 }, "mapColumns by header");

console.log("\nurl");
eq(csvUrl("https://docs.google.com/spreadsheets/d/ABC123/edit?usp=sharing"),
   "https://docs.google.com/spreadsheets/d/ABC123/export?format=csv", "share url -> csv export");
eq(csvUrl("https://docs.google.com/spreadsheets/d/ABC123/edit#gid=42"),
   "https://docs.google.com/spreadsheets/d/ABC123/export?format=csv&gid=42", "keeps gid");

console.log("\ncsv");
eq(parseCsv('A,B\n"x,1","say ""hi"""\n').rows[0], ["x,1", 'say "hi"'], "quotes and escapes");
eq(parseCsv('A,B\n"line\none",2\n').rows[0], ["line\none", "2"], "newline inside a quoted field");

let csv;
try {
  csv = await fetchSheet(SHEET);
} catch (e) {
  console.error(`\nSKIPPED live sheet tests — ${e.message}`);
  process.exit(failures ? 1 : 0);
}

console.log("\nlive sheet");
const sheet = parseCsv(csv);
eq(sheet.headers,
   ["Lesson - Section", "Production Segment", "Timing - Words", "Visual", "Script", "Complete"],
   "headers incl. Complete");

const { rows, warnings } = rowsFromSheet(sheet, LADDER);
eq(rows.length, 109, "109 segment rows");
eq(warnings.length, 0, "no warnings");
eq([rows[0].id, rows.at(-1).id], ["1.1", "1.109"], "id range");
eq(new Set(rows.map((r) => r.id)).size, 109, "segment ids unique");
eq(rows.filter((r) => r.visual).length, 11, "11 rows carry a Visual");

const hist = {};
for (const r of rows) hist[r.duration] = (hist[r.duration] || 0) + 1;
eq(hist, { "25s": 5, "30s": 104 }, "duration histogram after snap-up");

const raw = {};
for (const r of rows) raw[r.wantSeconds] = (raw[r.wantSeconds] || 0) + 1;
eq(raw, { 22: 1, 23: 1, 24: 1, 25: 2, 26: 4, 27: 23, 28: 33, 29: 25, 30: 19 },
   "scripted seconds histogram");

console.log("\nsections");
const sections = groupSections(rows);
eq(sections.map((s) => s.id), ["1.0","1.1","1.2","1.3","1.4","1.5","1.6","1.7","1.8"], "9 section ids");
eq(sections.map((s) => s.rows.length), [8, 15, 12, 17, 13, 12, 10, 13, 9], "segments per section");

// The id-collision test: section "1.1" and segment "1.1" are different things.
const s11 = sections.find((s) => s.id === "1.1");
eq([s11.rows[0].id, s11.rows.at(-1).id], ["1.9", "1.23"], "section 1.1 spans segments 1.9-1.23");
eq(rows.find((r) => r.id === "1.1").section, "1.0", "segment 1.1 belongs to section 1.0");
ok(s11.rows.every((r) => r.id !== "1.1"), "section 1.1 does NOT contain segment 1.1");
ok(sections.every((s) => s.rows.every((r, i, a) => i === 0 || a[i - 1].sheetRow < r.sheetRow)),
   "rows keep sheet order within a section");

console.log("\ncost");
const cost = (rs) => rs.reduce((t, r) => t + PRICE[parseInt(r.duration, 10)], 0);
eq(+cost(rows).toFixed(2), 147.14, "full lesson $147.14");
eq(sections.map((s) => +cost(s.rows).toFixed(2)),
   [10.88, 20.18, 16.32, 23.12, 17.68, 16.32, 12.72, 17.68, 12.24], "per-section cost");
eq(sections.reduce((t, s) => t + sectionSeconds(s), 0), 3245, "total runtime 3245s");

let budget = 92.30, done = 0, spent = 0;
for (const s of sections) { const c = cost(s.rows); if (spent + c > budget) break; spent += c; done++; }
eq([done, +spent.toFixed(2)], [5, 88.18], "$92.30 completes 5 whole sections for $88.18");

console.log("\ncomplete column");
eq(rows.filter((r) => r.sheetComplete).length, 0, "nothing marked complete yet");
{
  const marked = {
    headers: sheet.headers,
    rows: sheet.rows.map((r, i) => (i < 3 ? [...r.slice(0, 5), "x"] : r)),
  };
  const got = rowsFromSheet(marked, LADDER);
  eq(got.rows.filter((r) => r.sheetComplete).length, 3, "3 rows read as complete");
  eq(got.rows.slice(0, 3).map((r) => r.status), ["complete", "complete", "complete"],
     "complete rows start out of production");
  eq(got.rows[3].status, "pending", "unmarked rows stay pending");
}

console.log(failures ? `\nFAIL ${failures} assertion(s)` : "\nPASS all assertions");
process.exit(failures ? 1 : 0);
