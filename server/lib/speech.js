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
 * @returns {Promise<number>} seconds from the clip's start to the end of the last speech,
 * or 0 if the clip is silent throughout.
 */
export async function measureSpeechEnd(clip, ffmpeg = ffmpegPath()) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "venice-speech-"));
  try {
    // Via a wav file rather than a pipe: the bundled ffmpeg decodes s16le but does not
    // mux it, so `-f s16le -` fails.
    const wav = path.join(tmp, "a.wav");
    await run(ffmpeg, ["-y", "-v", "error", "-i", clip, "-ac", "1", "-ar", String(SR),
      "-c:a", "pcm_s16le", wav]);
    const buf = await fsp.readFile(wav);

    // Skip the 44-byte canonical wav header; ffmpeg writes exactly that for pcm_s16le.
    const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) >> 1);
    const hop = Math.round(SR * HOP_S);
    const hops = Math.floor(pcm.length / hop);
    if (hops < 2) return 0;

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
    for (let i = hops - 1; i >= 0; i--) if (env[i] > floor) return (i + 1) * HOP_S;
    return 0;
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

/**
 * Measure every segment whose clip is new or has changed, and return `{ id: seconds }`
 * for the whole section. Cheap to call: an unchanged clip keeps its measurement.
 */
export async function ensureSpeech(dir, rows, section, log = () => {}) {
  const have = readSpeech(dir, section);
  const withClips = rows.filter((r) => r.clip);

  const stale = (row) => {
    const cached = have[row.id];
    if (!cached) return true;
    try {
      const { size, mtimeMs } = fs.statSync(path.join(dir, row.clip));
      return cached.size !== size || cached.mtimeMs !== mtimeMs;
    } catch {
      return false; // no clip on disk: leave whatever is cached, measure nothing
    }
  };

  const missing = withClips.filter(stale);
  if (!missing.length) return Object.fromEntries(Object.entries(have).map(([id, v]) => [id, v.endsAt]));

  const ffmpeg = ffmpegPath();
  for (const row of missing) {
    const clip = path.join(dir, row.clip);
    try {
      const endsAt = await measureSpeechEnd(clip, ffmpeg);
      const { size, mtimeMs } = fs.statSync(clip);
      have[row.id] = { endsAt: Number(endsAt.toFixed(2)), size, mtimeMs };
      log(`speech ${row.id} ends at ${have[row.id].endsAt}s`);
    } catch (e) {
      // A clip that cannot be measured falls back to the stated timing rather than
      // failing the timeline: a wrong trim is recoverable, no timeline is not.
      log(`speech ${row.id} could not be measured (${e.message}) — falling back to the sheet's timing`);
    }
  }

  await fsp.mkdir(path.dirname(speechFile(dir, section)), { recursive: true });
  await fsp.writeFile(speechFile(dir, section), JSON.stringify(have, null, 2) + "\n");
  return Object.fromEntries(Object.entries(have).map(([id, v]) => [id, v.endsAt]));
}
