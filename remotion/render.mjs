#!/usr/bin/env node
/**
 * Render a finished section: timeline/<section>.json -> sections/<section>.mp4, both
 * inside the Venice Studio project directory.
 *
 *   node render.mjs            every section that has a timeline
 *   node render.mjs 1.0 1.2    just those
 *
 * The flat mp4 is the whole handoff to Premiere — graphics baked in, no XML, nothing to
 * reconcile. Re-rendering is free, so a change to a graphic is a re-render, not an edit.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { getVideoMetadata, renderMedia, selectComposition } from "@remotion/renderer";
import { ensureFocus } from "./focus.mjs";
import { ensurePlates, screenColour } from "./plates.mjs";
import { preflight } from "./preflight.mjs";
// One source of truth for what media files are called, shared with the server. store.js
// imports nothing but node builtins, so reaching across the workspace costs nothing.
import { sectionName } from "../server/lib/store.js";
import { projectDir } from "./project-dir.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = projectDir();

const bySection = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
};

async function timelines() {
  const files = await fs.readdir(path.join(dir, "timeline")).catch(() => []);
  return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort(bySection);
}

const wanted = process.argv.slice(2);
const available = await timelines();
const sections = wanted.length ? wanted : available;

const missing = sections.filter((s) => !available.includes(s));
if (missing.length) {
  console.error(`No timeline for ${missing.join(", ")} in ${path.join(dir, "timeline")}.`);
  console.error(`Have: ${available.join(", ") || "(none)"}`);
  process.exit(1);
}
if (!sections.length) {
  console.error(`Nothing to render — no timelines in ${path.join(dir, "timeline")}.`);
  process.exit(1);
}

console.log(`project  ${dir}`);
console.log(`sections ${sections.join(", ")}`);

// Before bundling, because the bundle copies the public dir and focus/<s>.json has to be
// in it. Only pip clips are measured, and only once — the file is the cache.
for (const section of sections) {
  const timeline = JSON.parse(
    await fs.readFile(path.join(dir, "timeline", `${section}.json`), "utf8")
  );

  // Two seconds of arithmetic against four minutes of rendering. A clip that is missing,
  // unreadable or shorter than the trim it is given fails deep inside the compositor as
  // "No frame found at position N", wrapped in a Rust backtrace, long after the bundle —
  // and it names a temp file rather than the segment. Answer it here, by name, first.
  const problems = await preflight(timeline, (clip) => getVideoMetadata(path.join(dir, clip)));
  if (problems.length) {
    console.error(`Section ${section} cannot be assembled — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ${p}`);
    console.error("Re-render the segments named above, then rebuild the timeline.");
    process.exit(1);
  }

  // Key the green screen and measure her, before the bundle — plates/<section>.json has
  // to be inside the public dir for Remotion to fetch it, exactly like focus/.
  // A section whose clips carry their own room is left alone: nothing to key.
  if (await isGreen(timeline)) {
    await ensurePlates(dir, timeline, (line) => console.log(line));
  } else {
    ensureFocus(dir, timeline, (line) => console.log(line));
  }
}

/**
 * Was this section shot against a screen, or in the room?
 *
 * Decided from the footage rather than a setting, because settings change and old clips
 * do not: a section rendered before the green screen must keep rendering the way it always
 * did, however the project is configured today. A frame that is overwhelmingly one
 * saturated colour at its edges is a screen; a spa room is not.
 */
async function isGreen(timeline) {
  const first = timeline.segments[0];
  if (!first) return false;
  const screen = await screenColour(path.join(dir, first.clip));
  const hex = screen.replace(/^0x/i, "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  if ([r, g, b].some(Number.isNaN)) return false;
  const green = g > r + 30 && g > b + 30;
  console.log(`screen ${screen} -> rgb(${r},${g},${b}) — ${green ? "green screen, keying" : "a room, playing the clips whole"}`);
  return green;
}

let last = -1;
const bar = (label) => (progress) => {
  const pct = Math.round(progress * 100);
  if (pct === last) return;
  last = pct;
  process.stdout.write(`\r${label} ${String(pct).padStart(3)}%`);
};

process.stdout.write("bundling…");
const serveUrl = await bundle({
  entryPoint: path.join(here, "src", "index.ts"),
  publicDir: dir,
  onProgress: () => {},
});
process.stdout.write("\rbundled  \n");

for (const section of sections) {
  const timeline = JSON.parse(
    await fs.readFile(path.join(dir, "timeline", `${section}.json`), "utf8")
  );
  const id = `section-${section.replace(/\./g, "-")}`;
  const composition = await selectComposition({ serveUrl, id });

  // The one thing worth asserting before spending minutes on a render: the composition
  // is exactly as long as the timeline says, which is the sum of the trimmed segments
  // minus one transition per join. A mismatch means a segment is playing untrimmed or a
  // dissolve is not overlapping, and both are invisible until you count frames.
  const overlap = timeline.transition.frames * Math.max(0, timeline.segments.length - 1);
  const expected = timeline.segments.reduce((n, s) => n + s.trimAfter, 0) - overlap;
  if (composition.durationInFrames !== timeline.durationInFrames || expected !== timeline.durationInFrames) {
    throw new Error(
      `Section ${section}: composition ${composition.durationInFrames}f, timeline ` +
        `${timeline.durationInFrames}f, segments-minus-overlap ${expected}f — these must agree.`
    );
  }

  const out = path.join(dir, "sections", `${sectionName(section)}.mp4`);
  await fs.mkdir(path.dirname(out), { recursive: true });

  last = -1;
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: out,
    onProgress: ({ progress }) => bar(`section ${section}`)(progress),
  });

  const { size } = await fs.stat(out);
  const seconds = (composition.durationInFrames / composition.fps).toFixed(1);
  process.stdout.write(
    `\rsection ${section} 100%  ${composition.durationInFrames}f / ${seconds}s  ` +
      `${(size / 1e6).toFixed(1)} MB  ${out}\n`
  );
}
