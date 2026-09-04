/**
 * Where the presenter is inside a clip, so the PiP circle can be centred on her.
 *
 * Wan generates every clip independently, and the framing drifts: across section 1.0 the
 * subject sits at x = 0.49 in seven clips and x = 0.41 in the eighth. Full frame that is
 * invisible; cropped to a circle a quarter of the screen wide, it reads as the avatar
 * sitting off to one side. So the crop is measured per clip rather than assumed centred.
 *
 * The measurement is the centroid of movement: on a fixed camera with a still background,
 * what moves is the presenter. No model, no face detection — just the frames differing
 * from their own average, which for a talking head lands on her.
 *
 * Results are cached in focus/<section>.json next to timeline/<section>.json, keyed by
 * segment id, and only pip segments are measured — nothing else is cropped. The cache
 * records the clip's size and modification time alongside the measurement, so a segment
 * re-rendered under a changed prompt is measured again rather than inheriting the
 * framing of the take it replaced.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectDir } from "./project-dir.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Remotion ships ffmpeg inside its platform-specific compositor package. */
function ffmpegPath() {
  const dir = path.join(here, "node_modules", "@remotion");
  for (const pkg of fs.readdirSync(dir)) {
    if (!pkg.startsWith("compositor-")) continue;
    for (const name of ["ffmpeg.exe", "ffmpeg"]) {
      const bin = path.join(dir, pkg, name);
      if (fs.existsSync(bin)) return bin;
    }
  }
  throw new Error(`No ffmpeg in ${dir} — is @remotion/renderer installed?`);
}

const W = 208, H = 120;          // enough to locate a head; small enough to be instant
const FROM = 3, SECONDS = 8;     // skip the first moments, then a long enough sample
const SAMPLE_FPS = 4;
const THRESHOLD = 0.35;          // ignore faint shimmer, which would drag the centroid to the middle

/** @returns {{x: number, y: number}} the presenter's centre, as a fraction of the frame */
export function measure(clip, ffmpeg = ffmpegPath()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "venice-focus-"));
  try {
    execFileSync(ffmpeg, [
      "-y", "-loglevel", "error", "-ss", String(FROM), "-t", String(SECONDS), "-i", clip,
      "-r", String(SAMPLE_FPS), "-vf", `scale=${W}:${H},format=gray`,
      "-f", "image2", "-c:v", "rawvideo", "-pix_fmt", "gray", path.join(dir, "f%04d.raw"),
    ]);
    const frames = fs.readdirSync(dir).sort().map((f) => fs.readFileSync(path.join(dir, f)));
    if (frames.length < 2) throw new Error(`Only ${frames.length} frames from ${clip}`);

    const n = frames.length;
    const mean = new Float64Array(W * H);
    for (const f of frames) for (let i = 0; i < W * H; i++) mean[i] += f[i] / n;
    const weight = new Float64Array(W * H);
    for (const f of frames) for (let i = 0; i < W * H; i++) weight[i] += Math.abs(f[i] - mean[i]);

    let max = 0;
    for (const w of weight) if (w > max) max = w;
    let sx = 0, sy = 0, s = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const w = weight[y * W + x];
        if (w < max * THRESHOLD) continue;
        sx += x * w; sy += y * w; s += w;
      }
    }
    if (!s) throw new Error(`Nothing moves in ${clip}`);

    return { x: sx / s / W, y: sy / s / H };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const focusFile = (dir, section) => path.join(dir, "focus", `${section}.json`);

export function readFocus(dir, section) {
  try {
    return JSON.parse(fs.readFileSync(focusFile(dir, section), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Measure any pip segment whose clip is new or has changed on disk, and return the whole
 * map. Cheap to call: an unchanged clip is never re-measured.
 */
export function ensureFocus(dir, timeline, log = () => {}) {
  const pip = timeline.segments.filter((s) => s.layout === "pip");
  const have = readFocus(dir, timeline.section);
  const stale = (segment) => {
    const cached = have[segment.id];
    if (!cached) return true;
    const { size, mtimeMs } = fs.statSync(path.join(dir, segment.clip));
    return cached.size !== size || cached.mtimeMs !== mtimeMs;
  };
  const missing = pip.filter(stale);
  if (!missing.length) return have;

  const ffmpeg = ffmpegPath();
  for (const segment of missing) {
    const clip = path.join(dir, segment.clip);
    const f = measure(clip, ffmpeg);
    const { size, mtimeMs } = fs.statSync(clip);
    have[segment.id] = { x: Number(f.x.toFixed(4)), y: Number(f.y.toFixed(4)), size, mtimeMs };
    log(`focus ${segment.id}  x=${have[segment.id].x}  y=${have[segment.id].y}`);
  }
  fs.mkdirSync(path.dirname(focusFile(dir, timeline.section)), { recursive: true });
  fs.writeFileSync(focusFile(dir, timeline.section), JSON.stringify(have, null, 2) + "\n");
  return have;
}

// node focus.mjs [section...] — measure without rendering, e.g. before opening Studio.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const dir = projectDir();
  const all = fs.readdirSync(path.join(dir, "timeline")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : all;
  for (const section of wanted) {
    const timeline = JSON.parse(fs.readFileSync(path.join(dir, "timeline", `${section}.json`), "utf8"));
    ensureFocus(dir, timeline, (line) => console.log(line));
  }
  console.log("focus up to date");
}
