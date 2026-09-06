/**
 * Check the clips a timeline depends on before spending minutes rendering it.
 *
 * This exists because of the failure it does *not* catch. Remotion's frame extractor
 * intermittently reports "No frame found at position N" for a clip that is provably
 * intact — the same timeline rendered clean on the next attempt — and no amount of
 * checking the input prevents that. A retry does; see assemble.js.
 *
 * What it does catch is the deterministic cousin of that error, which reads identically
 * in the log and is a real defect: a clip that is missing, unreadable, or genuinely
 * shorter than the stretch of it the timeline intends to use. Ask for two seconds that
 * were never rendered and you get "no frame found" every single time, four minutes into
 * a render, in the middle of a Rust backtrace. Answering that in two seconds, naming the
 * segment, is the whole point.
 *
 * No imports on purpose: the comparison is arithmetic, so it stays testable without
 * Remotion, ffmpeg or a single mp4 on disk. The caller supplies the probe.
 */

/**
 * Problems with one segment, as human sentences. Empty means fine.
 *
 * Durations are compared in seconds rather than frames because the clip and the timeline
 * need not agree on a frame rate — a 30fps timeline may cut a 29.97fps clip, and
 * comparing frame counts across two different rates silently comes out wrong.
 */
export function problemsFor(segment, meta, fps) {
  if (!meta) return [`${segment.id}: clip missing or unreadable — ${segment.clip}`];

  const out = [];
  const have = Number(meta.durationInSeconds) || 0;
  if (have <= 0) {
    out.push(`${segment.id}: clip has no duration — ${segment.clip}`);
    return out;
  }

  // A frame boundary of slack: a clip is allowed to end exactly where the trim does.
  const need = segment.trimAfter / fps;
  if (have + 1 / fps < need) {
    out.push(
      `${segment.id}: the timeline uses ${need.toFixed(2)}s of ${segment.clip} but the clip is only ${have.toFixed(2)}s`
    );
  }
  return out;
}

/**
 * Walk a whole timeline. `probe(relativeClipPath)` returns Remotion's video metadata, or
 * throws — a throw is treated as "unreadable", which is the same answer for the caller.
 */
export async function preflight(timeline, probe) {
  const problems = [];
  for (const segment of timeline.segments || []) {
    let meta = null;
    try { meta = await probe(segment.clip); } catch { meta = null; }
    problems.push(...problemsFor(segment, meta, timeline.fps));
  }
  return problems;
}
