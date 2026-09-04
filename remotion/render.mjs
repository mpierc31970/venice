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
import { renderMedia, selectComposition } from "@remotion/renderer";
import { ensureFocus } from "./focus.mjs";
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
  ensureFocus(dir, timeline, (line) => console.log(line));
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

  const out = path.join(dir, "sections", `${section}.mp4`);
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
