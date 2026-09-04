// Production-script Google Sheet -> segment rows.
//
// Source of truth is a Google Sheet, read through its CSV export. Columns:
//
//   Lesson - Section | Production Segment | Timing - Words | Visual | Script | Complete
//   Lesson 1 - Sec…  | 1.1                | 30 secs - 65 … |        | Every… | x
//
// Three things about this data that are easy to get wrong:
//
//  1. Section ids and segment ids share a format and COLLIDE. "1.1" is Section 1.1
//     in column A and Production Segment 1.1 in column B — different things.
//     Segment 1.1 lives in section 1.0; section 1.1 starts at segment 1.9.
//     Never build one id -> row index across both.
//
//  2. Segments exist only because the video model caps at 30s. A section is one
//     continuous piece of narration chopped to fit, so sheet order IS edit order
//     and a change in column A starts the next video. Nothing is sorted.
//
//  3. Complete is hand-maintained. A row marked complete never enters production,
//     whatever our own render state says.

/* --------------------------------------------------------------- fetch ---- */

/** Accepts a share URL, an /edit URL, or an export URL. Returns the CSV export URL. */
export function csvUrl(url) {
  const s = String(url || "").trim();
  const id = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(s)?.[1];
  if (!id) throw new Error("Not a Google Sheets URL — expected .../spreadsheets/d/<id>/...");
  const gid = /[#&?]gid=(\d+)/.exec(s)?.[1];
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ""}`;
}

/**
 * Fetch the sheet as CSV text. The sheet must be link-readable.
 * Google answers an unshared sheet with an HTML sign-in page and a 200, so
 * content-type is checked rather than trusted.
 */
export async function fetchSheet(url, { timeoutMs = 30_000 } = {}) {
  const target = csvUrl(url);
  const ctl = AbortSignal.timeout(timeoutMs);
  const res = await fetch(target, { signal: ctl, redirect: "follow" });
  const type = res.headers.get("content-type") || "";
  if (!res.ok) throw new Error(`Google Sheets returned ${res.status} fetching the CSV export`);
  if (!/text\/csv/i.test(type)) {
    throw new Error(
      "Google returned a sign-in page instead of CSV. Set the sheet's General access " +
      "to \"Anyone with the link\" (Viewer is enough) and try again."
    );
  }
  return res.text();
}

/* ----------------------------------------------------------------- csv ---- */

/** RFC4180 reader — handles quoted commas and newlines, which the Script column has. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const src = String(text).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const table = rows.filter((r) => r.some((c) => String(c).trim() !== ""));
  if (!table.length) throw new Error("Sheet is empty");
  return { headers: table[0], rows: table.slice(1) };
}

/* ---------------------------------------------------------------- rows ---- */

/** Duration ladder entries a video model offers, as seconds. */
export const parseLadder = (durations = []) =>
  durations.filter((d) => /^\d+s$/.test(d)).map((d) => parseInt(d, 10)).sort((a, b) => a - b);

/**
 * Snap UP to the next allowed duration, never down: a clip must never be shorter
 * than its narration, or the last words are cut and the only fix is a paid
 * re-render. The resulting padding is trimmed at assembly instead.
 */
export function snapUp(seconds, ladder) {
  const nums = Array.isArray(ladder) && ladder.length ? ladder : [5];
  return (nums.find((n) => n >= seconds) ?? nums[nums.length - 1]) + "s";
}

/** "30 secs - 65 words" -> 30. Returns null rather than guessing. */
export function parseSeconds(timing) {
  const m = /(\d+)\s*(?:secs?|seconds?)\b/i.exec(String(timing ?? ""));
  return m ? parseInt(m[1], 10) : null;
}

/** "Lesson 1 - Section 1.0" -> "1.0". Falls back to the trimmed label. */
export function parseSection(label) {
  const s = String(label ?? "").trim();
  return /section\s+([\d.]+)/i.exec(s)?.[1] ?? s;
}

/**
 * Is this row marked done in the Complete column?
 * Deliberately liberal — the column is hand-maintained in Google Sheets, so
 * accept any reasonable affirmative and treat everything else as not-complete.
 */
export function isComplete(cell) {
  if (cell === true) return true;
  if (cell === false || cell == null) return false;
  if (typeof cell === "number") return cell === 1;
  const v = String(cell).trim().toLowerCase();
  if (!v) return false;
  if (["no", "n", "0", "false", "-", "todo", "pending"].includes(v)) return false;
  return ["x", "y", "yes", "1", "true", "✓", "✔", "☑"].includes(v) || /^(done|complete)/.test(v);
}

const COLUMNS = {
  section:  /lesson\s*-?\s*section|^section/i,
  id:       /production\s*segment|^segment/i,
  timing:   /timing/i,
  visual:   /visual/i,
  script:   /script/i,
  complete: /complete|done|rendered/i,
};

/** Resolve header text -> column index, falling back to sheet order A-F. */
export function mapColumns(headers) {
  const found = {};
  headers.forEach((h, i) => {
    const text = String(h ?? "").trim();
    if (!text) return;
    for (const [field, re] of Object.entries(COLUMNS)) {
      if (found[field] === undefined && re.test(text)) found[field] = i;
    }
  });
  const fallback = { section: 0, id: 1, timing: 2, visual: 3, script: 4, complete: 5 };
  for (const [field, i] of Object.entries(fallback)) {
    if (found[field] === undefined && headers.length > i) found[field] = i;
  }
  return found;
}

/**
 * Turn a parsed sheet into segment rows.
 * `ladder` is the model's allowed durations in seconds, e.g. [2,5,10,15,20,25,30].
 * Returns { rows, warnings, columns } — warnings surface in the import preview
 * rather than throwing, so one malformed row can't block an import.
 */
export function rowsFromSheet({ headers, rows }, ladder) {
  const col = mapColumns(headers);
  const out = [];
  const warnings = [];

  rows.forEach((r, i) => {
    const sheetRow = i + 2; // 1-based, plus the header
    const id = String(r[col.id] ?? "").trim();
    const script = String(r[col.script] ?? "").trim();
    if (!id && !script) return;

    if (!id) return warnings.push({ sheetRow, message: "No Production Segment id — row skipped" });
    if (!script) return warnings.push({ sheetRow, message: `Segment ${id} has no Script — row skipped` });

    const wantSeconds = parseSeconds(r[col.timing]);
    if (wantSeconds == null) {
      return warnings.push({ sheetRow, message: `Segment ${id}: no duration in "${r[col.timing] ?? ""}" — row skipped` });
    }

    const sheetComplete = isComplete(r[col.complete]);
    out.push({
      id,
      section: parseSection(r[col.section]),
      sectionLabel: String(r[col.section] ?? "").trim(),
      n: out.length + 1,
      sheetRow,
      wantSeconds,
      duration: snapUp(wantSeconds, ladder),
      visual: String(r[col.visual] ?? "").trim(),
      script,
      sheetComplete,
      // The sheet's Complete column outranks our own state: a row marked
      // complete never enters production, however it got that way.
      status: sheetComplete ? "complete" : "pending",
    });
  });

  const dupes = [...new Set(out.map((r) => r.id).filter((id, i, a) => a.indexOf(id) !== i))];
  if (dupes.length) {
    throw new Error(`Duplicate Production Segment ids: ${dupes.join(", ")}. Ids must be unique — the merge keys on them.`);
  }

  return { rows: out, warnings, columns: col };
}

/**
 * Group rows into sections by walking sheet order and cutting where column A
 * changes. Asserts contiguity: a section may not reappear once another has
 * begun, because then sheet order would no longer define the videos.
 */
export function groupSections(rows) {
  const sections = [];
  const seen = new Set();
  for (const row of rows) {
    const last = sections[sections.length - 1];
    if (!last || last.id !== row.section) {
      if (seen.has(row.section)) {
        throw new Error(`Section ${row.section} reappears at segment ${row.id} after another section started. Sections must be contiguous in sheet order.`);
      }
      seen.add(row.section);
      sections.push({ id: row.section, label: row.sectionLabel, rows: [] });
    }
    sections[sections.length - 1].rows.push(row);
  }
  return sections;
}

/** Seconds of finished video a section runs to, after snapping. */
export const sectionSeconds = (section) =>
  section.rows.reduce((t, r) => t + parseInt(r.duration, 10), 0);
