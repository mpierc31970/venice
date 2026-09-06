/**
 * Stage 1.5: turn a green-screen clip into a plate — her, cut out, with a per-frame
 * record of where she is and how big she is.
 *
 * The clip Wan returns is never modified. `clips/<section>/<id>.mp4` stays exactly as it
 * was paid for and uploaded, so it can go into Premiere and be keyed by hand with Ultra
 * Key if a section ever needs that. Everything here writes to `plates/` and is free to
 * delete: it rebuilds from the original in a couple of minutes.
 *
 * Two things come out:
 *
 *   plates/<section>/<id>.webm   her on transparency — VP9 with alpha, which Chromium
 *                                decodes natively, so Remotion composites it directly
 *   plates/<section>.json        the measurements, and the per-frame transform that puts
 *                                her at the same size and place in every clip
 *
 * The geometry is *data*, not baked into the pixels. Rekeying is slow; changing where she
 * sits is not, and separating them means the target framing can be retuned without
 * touching a single frame of video.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { segmentName } from "../server/lib/store.js";

/* ------------------------------------------------------------- geometry ---- */
// Everything below is arithmetic. No ffmpeg, no files — so it is testable on its own.

/** Bounding box of everything opaque in a mask. Null when the frame is empty. */
export function bboxFromMask(mask, w, h, threshold = 128) {
  let x0 = w, x1 = -1, y0 = h, y1 = -1, count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] < threshold) continue;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, cx: (x0 + x1) / 2, top: y0, cover: count / (w * h) };
}

/**
 * A centred moving average, shrinking at the ends rather than padding.
 *
 * Correcting straight from the raw measurement is worse than not correcting at all: the
 * mask edge flickers by a pixel or two between frames, and feeding that into a transform
 * turns a slow drift nobody notices into a jitter everybody does. The window is about
 * half a second, which is long enough to kill the flicker and short enough to still
 * follow a real move.
 */
export function smooth(series, window = 15) {
  const half = Math.floor(window / 2);
  return series.map((_, i) => {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(series.length - 1, i + half); j++) {
      sum += series[j];
      n++;
    }
    return sum / n;
  });
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The one geometry every clip in the section is normalised to.
 *
 * Deliberately the median across the *whole section*, not each clip's own middle. A clip
 * normalised to itself is steady on its own and still lands somewhere different from the
 * clip before it — which is the fault that shows at a cut. One target for the section
 * makes every join a change of pose and nothing else.
 */
export function targetFrom(tracks) {
  const all = tracks.flat();
  if (!all.length) throw new Error("No frames measured — cannot choose a target framing");
  return {
    w: median(all.map((b) => b.w)),
    cx: median(all.map((b) => b.cx)),
    top: median(all.map((b) => b.top)),
  };
}

/**
 * Per-frame transform mapping this clip's measured box onto the target, as fractions of
 * the source frame so the result is independent of the plate's pixel size.
 *
 * Applied with transform-origin at the top left: scale first, then translate.
 */
export function transformsFor(track, target, frame, { window = 15, maxScale = 1.35 } = {}) {
  const cx = smooth(track.map((b) => b.cx), window);
  const top = smooth(track.map((b) => b.top), window);
  const w = smooth(track.map((b) => b.w), window);

  return track.map((_, i) => {
    // A clip that came out much smaller than the section's median would have to be blown
    // up to match, and past a point that is worse than the mismatch: soft, and cropping
    // her edges. Clamp, and let the residual difference stand.
    const s = Math.min(maxScale, Math.max(1 / maxScale, target.w / w[i]));
    return {
      s: +s.toFixed(5),
      dx: +((target.cx - cx[i] * s) / frame.width).toFixed(5),
      dy: +((target.top - top[i] * s) / frame.height).toFixed(5),
    };
  });
}

/* ---------------------------------------------------------------- ffmpeg ---- */

let cachedFfmpeg = null;
async function ffmpegPath() {
  if (!cachedFfmpeg) cachedFfmpeg = (await import("ffmpeg-static")).default;
  return cachedFfmpeg;
}

/**
 * The clip's own pixel size, measured rather than assumed.
 *
 * The timeline carries the *output* size — 1920x1080 — which is not this. Wan returns
 * 832x480 for 16:9 and 624x624 for 1:1 at the same price, so the source dimensions are a
 * property of the file and nothing else can be trusted to know them.
 */
export async function probeSize(clip) {
  const { getVideoMetadata } = await import("@remotion/renderer");
  const m = await getVideoMetadata(clip);
  return { width: m.width, height: m.height, fps: m.fps, frames: Math.round(m.durationInSeconds * m.fps) };
}
const run = (bin, args) => execFileSync(bin, ["-y", "-loglevel", "error", ...args], { maxBuffer: 1 << 28 });

/**
 * The key, as one filter string.
 *
 * `format=yuva420p` first is not optional and not cosmetic: without it chromakey has no
 * alpha plane to write into, every filter downstream silently sees an opaque frame, and
 * the masks come back empty with no error anywhere.
 *
 * similarity 0.06 sits in the middle of a measured plateau — 0.01 to 0.08 all keep her
 * intact and remove the screen, and 0.10 starts eating her. Blend is deliberately small;
 * a soft edge on a 480p source turns into a halo once it is scaled up to 1080.
 */
export const keyFilter = (screen, { similarity = 0.06, blend = 0.02 } = {}) =>
  `format=yuva420p,chromakey=color=${screen}:similarity=${similarity}:blend=${blend},despill=type=green:mix=0.5:expand=0`;

/** The screen's colour, read from the top strip — background for certain, whatever the pose. */
export async function screenColour(clip, { at = 5 } = {}) {
  const bin = await ffmpegPath();
  const tmp = path.join(os.tmpdir(), `venice-screen-${process.pid}.raw`);
  try {
    run(bin, ["-ss", String(at), "-i", clip, "-frames:v", "1", "-vf", "scale=160:-1", "-pix_fmt", "rgb24", "-f", "rawvideo", tmp]);
    const buf = fs.readFileSync(tmp);
    const w = 160, rows = Math.max(1, Math.floor((buf.length / 3 / w) * 0.05));
    const chan = [[], [], []];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        chan[0].push(buf[i]); chan[1].push(buf[i + 1]); chan[2].push(buf[i + 2]);
      }
    }
    const med = chan.map((c) => Math.round(median(c)));
    return "0x" + med.map((v) => v.toString(16).padStart(2, "0")).join("");
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Her silhouette on every frame, measured at quarter size and scaled back up. */
export async function trackClip(clip, screen, { width, height, divisor = 4 } = {}) {
  const bin = await ffmpegPath();
  const mw = Math.round(width / divisor), mh = Math.round(height / divisor);
  const tmp = path.join(os.tmpdir(), `venice-mask-${process.pid}.raw`);
  try {
    run(bin, ["-i", clip, "-vf", `${keyFilter(screen)},alphaextract,scale=${mw}:${mh},format=gray`,
      "-f", "rawvideo", "-pix_fmt", "gray", tmp]);
    const mask = fs.readFileSync(tmp);
    const frames = Math.floor(mask.length / (mw * mh));
    const out = [];
    for (let n = 0; n < frames; n++) {
      const box = bboxFromMask(mask.subarray(n * mw * mh, (n + 1) * mw * mh), mw, mh);
      if (!box) continue;
      const s = width / mw;
      out.push({ w: box.w * s, cx: box.cx * s, top: box.top * s, cover: box.cover });
    }
    if (!out.length) throw new Error(`Nothing survived the key in ${clip} — is it really a green screen?`);
    return out;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Key the clip to a transparent plate. Geometry is left alone — that lives in the JSON. */
export async function writePlate(clip, screen, out) {
  const bin = await ffmpegPath();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  run(bin, ["-i", clip, "-vf", keyFilter(screen), "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
    "-b:v", "4M", "-row-mt", "1", "-an", out]);
  return out;
}

/* ------------------------------------------------------------ the stage ---- */

const platesFile = (dir, section) => path.join(dir, "plates", `${section}.json`);

export function readPlates(dir, section) {
  try { return JSON.parse(fs.readFileSync(platesFile(dir, section), "utf8")); } catch { return {}; }
}

/**
 * Bring every segment's plate up to date, and re-derive the section's target framing.
 *
 * Cheap to call: a clip whose size and mtime are unchanged keeps its measurements. But the
 * target is a property of the whole section, so when any clip changes, every transform is
 * recomputed from the cached tracks — which is arithmetic, not video, and instant.
 */
export async function ensurePlates(dir, timeline, log = () => {}) {
  const have = readPlates(dir, timeline.section).segments || {};
  const segments = timeline.segments;

  for (const segment of segments) {
    const clip = path.join(dir, segment.clip);
    const { size, mtimeMs } = fs.statSync(clip);
    // `<id>.plate.webm`, not `<id>.webm`. It keeps the segment id first so a plate sorts
    // beside its siblings and matches clips/<section>/<id>.mp4 at a glance, while still
    // saying what it is once the file is on its own — dragged onto a timeline, attached to
    // a message, sitting in a downloads folder. A bare `1.1.webm` says none of that.
    const plateRel = path.posix.join("plates", timeline.section, `${segmentName(timeline.section, segment.id)}.plate.webm`);
    const plateAbs = path.join(dir, plateRel);
    const cached = have[segment.id];
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs && fs.existsSync(plateAbs)) continue;

    const { width, height } = await probeSize(clip);
    const screen = await screenColour(clip);
    const track = await trackClip(clip, screen, { width, height });
    await writePlate(clip, screen, plateAbs);
    have[segment.id] = {
      size, mtimeMs, screen, plate: plateRel, width, height,
      track: track.map((b) => ({ w: +b.w.toFixed(1), cx: +b.cx.toFixed(1), top: +b.top.toFixed(1) })),
    };
    log(`plate ${segment.id}  screen ${screen}  ${track.length} frames  cover ${(track[0].cover * 100).toFixed(0)}%`);
  }

  // One target for the section, then transforms for every clip against it.
  const tracks = segments.map((s) => have[s.id].track);
  const target = targetFrom(tracks);
  for (const segment of segments) {
    const entry = have[segment.id];
    entry.transforms = transformsFor(entry.track, target, { width: entry.width, height: entry.height });
  }
  // `target` sits beside `segments` rather than among them: it is a property of the whole
  // section, and Remotion needs it to place her, so it must not be mistakable for a
  // segment id.
  const out = { section: timeline.section, at: new Date().toISOString(), target, segments: have };
  fs.mkdirSync(path.dirname(platesFile(dir, timeline.section)), { recursive: true });
  fs.writeFileSync(platesFile(dir, timeline.section), JSON.stringify(out, null, 2) + "\n");
  log(`target framing: width ${target.w.toFixed(0)}px, centre x ${target.cx.toFixed(0)}px, head top ${target.top.toFixed(0)}px`);
  return out;
}
