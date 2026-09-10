/**
 * Where she actually stops speaking, per clip.
 *
 * buildTimeline used to cut every segment at `wantSeconds + TRIM_SAFETY_S`, and
 * `wantSeconds` is not a measurement of anything: sheet.js parses it out of the sheet's
 * "Timing - Words" column, so it is a length somebody typed while writing the script,
 * before the clip existed. Wan delivers slower than those numbers — 2.06 to 2.32 words a
 * second across section 1.1, where the stated timings implied faster — and the 0.4s of
 * safety was about two seconds short of covering it. Seven of that section's fifteen
 * segments were cut mid-word, and the worst lost 2.05 seconds of speech.
 *
 * So the trim is measured instead of assumed. The measurement is the RMS envelope of the
 * clip's own audio in 50ms hops, and the end of speech is the last hop above a floor set
 * relative to that clip's own speaking level — not an absolute dB, which would depend on
 * how loudly this particular generation happened to come out.
 *
 * Cached in `speech/<section>.json` beside `timeline/` and `plates/`, keyed on each
 * clip's size and mtime, so a re-rendered segment is measured again and an untouched one
 * is never measured twice. Deleting the folder costs a minute and nothing else.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const REMOTION_DIR = path.join(here, "..", "..", "remotion");

/** Remotion ships ffmpeg inside its platform-specific compositor package. */
function ffmpegPath() {
  const dir = path.join(REMOTION_DIR, "node_modules", "@remotion");
  for (const pkg of fs.readdirSync(dir)) {
    if (!pkg.startsWith("compositor-")) continue;
    for (const name of ["ffmpeg.exe", "ffmpeg"]) {
      const bin = path.join(dir, pkg, name);
      if (fs.existsSync(bin)) return bin;
    }
  }
  throw new Error(`No ffmpeg in ${dir} — is @remotion/renderer installed?`);
}

const SR = 16000;      // speech is well covered; smaller files, faster reads
const HOP_S = 0.05;
const QUIET = 0.08;    // 22dB below her speaking level counts as not speaking

/**
 * The samples out of a RIFF/WAVE buffer, by walking its chunk table.
 *
 * Not by skipping a fixed 44 bytes: this ffmpeg writes a LIST chunk between `fmt ` and
 * `data`, putting the samples at byte 78. Assuming 44 fed 34 bytes of chunk header into
 * the envelope as a burst of noise at position zero, which read as speech starting
 * immediately and put every `startsAt` at 0.
 */
function samplesOf(buf) {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let i = 12;
  while (i + 8 <= buf.length) {
    const id = buf.toString("ascii", i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const body = i + 8;
    if (id === "data") {
      const usable = Math.min(size, buf.length - body) & ~1;
      // Copy rather than view: `body` has no alignment guarantee and Int16Array over an
      // odd byteOffset throws.
      return new Int16Array(buf.buffer.slice(buf.byteOffset + body, buf.byteOffset + body + usable));
    }
    i = body + size + (size % 2); // chunks are word-aligned
  }
  throw new Error("no data chunk in the wav");
}

/**
 * @returns {Promise<{startsAt: number, endsAt: number}>} when she starts and stops
 * speaking, in seconds from the clip's start. Both 0 if the clip is silent throughout.
 *
 * The start matters as much as the end: captions are spread across this span, and Wan
 * leaves 0.3 to 0.8 seconds of silence before the first word. Spread from frame zero
 * instead and every caption in the clip arrives early.
 */
export async function measureSpeechSpan(clip, ffmpeg = ffmpegPath()) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "venice-speech-"));
  try {
    // Via a wav file rather than a pipe: the bundled ffmpeg decodes s16le but does not
    // mux it, so `-f s16le -` fails.
    const wav = path.join(tmp, "a.wav");
    await run(ffmpeg, ["-y", "-v", "error", "-i", clip, "-ac", "1", "-ar", String(SR),
      "-c:a", "pcm_s16le", wav]);
    const buf = await fsp.readFile(wav);

    const pcm = samplesOf(buf);
    const hop = Math.round(SR * HOP_S);
    const hops = Math.floor(pcm.length / hop);
    if (hops < 2) return { startsAt: 0, endsAt: 0 };

    const env = new Float64Array(hops);
    for (let i = 0; i < hops; i++) {
      let sum = 0;
      for (let j = i * hop; j < (i + 1) * hop; j++) sum += (pcm[j] / 32768) ** 2;
      env[i] = Math.sqrt(sum / hop);
    }

    // Her speaking level, taken as the 90th percentile so one loud consonant does not set
    // it and a long tail of near-silence does not drag it down.
    const sorted = Float64Array.from(env).sort();
    const floor = sorted[Math.floor(hops * 0.9)] * QUIET;

    let first = -1, last = -1;
    for (let i = 0; i < hops; i++) if (env[i] > floor) { if (first < 0) first = i; last = i; }
    if (first < 0) return { startsAt: 0, endsAt: 0 };
    return { startsAt: first * HOP_S, endsAt: (last + 1) * HOP_S };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

const speechFile = (dir, section) => path.join(dir, "speech", `${section}.json`);

export function readSpeech(dir, section) {
  try {
    return JSON.parse(fs.readFileSync(speechFile(dir, section), "utf8"));
  } catch {
    return {};
  }
}

const spans = (have) =>
  Object.fromEntries(Object.entries(have).map(([id, v]) => [id, { startsAt: v.startsAt ?? 0, endsAt: v.endsAt }]));

/**
 * Measure every segment whose clip is new or has changed, and return
 * `{ id: { startsAt, endsAt } }` for the whole section. Cheap to call: an unchanged clip
 * keeps its measurement.
 */
export async function ensureSpeech(dir, rows, section, log = () => {}) {
  const have = readSpeech(dir, section);
  const withClips = rows.filter((r) => r.clip);

  const stale = (row) => {
    const cached = have[row.id];
    // `startsAt` arrived after `endsAt` did, so an entry without one predates captions
    // being timed from the measurement and has to be taken again.
    if (!cached || cached.startsAt === undefined) return true;
    try {
      const { size, mtimeMs } = fs.statSync(path.join(dir, row.clip));
      return cached.size !== size || cached.mtimeMs !== mtimeMs;
    } catch {
      return false; // no clip on disk: leave whatever is cached, measure nothing
    }
  };

  const missing = withClips.filter(stale);
  if (!missing.length) return spans(have);

  const ffmpeg = ffmpegPath();
  for (const row of missing) {
    const clip = path.join(dir, row.clip);
    try {
      const { startsAt, endsAt } = await measureSpeechSpan(clip, ffmpeg);
      const { size, mtimeMs } = fs.statSync(clip);
      have[row.id] = {
        startsAt: Number(startsAt.toFixed(2)),
        endsAt: Number(endsAt.toFixed(2)),
        size, mtimeMs,
      };
      log(`speech ${row.id} runs ${have[row.id].startsAt}s to ${have[row.id].endsAt}s`);
    } catch (e) {
      // A clip that cannot be measured falls back to the stated timing rather than
      // failing the timeline: a wrong trim is recoverable, no timeline is not.
      log(`speech ${row.id} could not be measured (${e.message}) — falling back to the sheet's timing`);
    }
  }

  await fsp.mkdir(path.dirname(speechFile(dir, section)), { recursive: true });
  await fsp.writeFile(speechFile(dir, section), JSON.stringify(have, null, 2) + "\n");
  return spans(have);
}
