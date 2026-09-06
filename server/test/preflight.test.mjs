// The clip check that runs before a section is assembled.
// Run: node server/test/preflight.test.mjs
//
// Pure arithmetic over metadata, so this needs no Remotion, no ffmpeg and no mp4: the
// probe is a stub. What is under test is the judgement — which clips are a real problem
// and which are fine — because both mistakes are expensive. A false alarm blocks a
// section that would have rendered; a miss costs four minutes and reports the failure as
// a Rust backtrace naming a temp file.
import { problemsFor, preflight } from "../../remotion/preflight.mjs";

let failures = 0;
const eq = (a, b, label) => {
  if (JSON.stringify(a) === JSON.stringify(b)) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n         expected ${JSON.stringify(b)}\n         actual   ${JSON.stringify(a)}`);
};

const FPS = 30;
const seg = (id, trimAfter) => ({ id, clip: `clips/1.0/${id}.mp4`, trimAfter });
const meta = (durationInSeconds, fps = 30) => ({ durationInSeconds, fps });

console.log("one segment");

// The real shape: a 30s clip trimmed to 27.4s of speech plus safety.
eq(problemsFor(seg("1.1", 822), meta(30.023), FPS), [], "a clip longer than its trim is fine");
eq(problemsFor(seg("1.1", 900), meta(30.023), FPS), [], "and a trim that uses almost all of it is fine");
eq(problemsFor(seg("1.1", 901), meta(30.023), FPS), [], "a trim one frame over is within tolerance, not an alarm");

{
  const p = problemsFor(seg("1.4", 900), meta(26.5), FPS);
  eq(p.length, 1, "a clip shorter than its trim is one problem");
  eq(/1\.4/.test(p[0]) && /26\.50s/.test(p[0]) && /30\.00s/.test(p[0]), true,
     "and the message names the segment, what is needed and what exists");
}

eq(problemsFor(seg("1.2", 900), null, FPS), ["1.2: clip missing or unreadable — clips/1.0/1.2.mp4"],
   "an unreadable clip is reported by name");
eq(problemsFor(seg("1.3", 900), meta(0), FPS).length, 1, "a zero-length clip is a problem");

// A 30fps timeline cutting 29.97fps footage is ordinary, and comparing frame counts
// across two rates is how you get a false alarm. Seconds are the honest comparison.
eq(problemsFor(seg("1.5", 900), meta(30.023, 29.97), FPS), [],
   "a clip at a different frame rate is not a problem if it is long enough");

console.log("\na whole timeline");
{
  const timeline = { fps: FPS, segments: [seg("1.1", 900), seg("1.2", 900), seg("1.3", 900)] };
  const lengths = { "clips/1.0/1.1.mp4": 30.023, "clips/1.0/1.2.mp4": 12.0, "clips/1.0/1.3.mp4": 30.023 };
  const probe = async (clip) => {
    if (!(clip in lengths)) throw new Error("ENOENT");
    return meta(lengths[clip]);
  };
  eq(await preflight(timeline, probe), [
    "1.2: the timeline uses 30.00s of clips/1.0/1.2.mp4 but the clip is only 12.00s",
  ], "only the short clip is reported, and the good ones are silent");

  const allFine = { fps: FPS, segments: [seg("1.1", 822), seg("1.3", 810)] };
  eq(await preflight(allFine, probe), [], "a healthy section reports nothing");

  const missing = { fps: FPS, segments: [seg("9.9", 900)] };
  eq((await preflight(missing, probe)).length, 1, "a probe that throws counts as unreadable, not a crash");
}

console.log(failures ? `\nFAIL ${failures} assertion(s)` : "\nPASS all assertions");
process.exit(failures ? 1 : 0);
