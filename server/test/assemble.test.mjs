// Stage 2 from the UI: spawn the Remotion render for one section and follow it.
// Run: node server/test/assemble.test.mjs
//
// Remotion itself is never invoked here. The thing worth testing is the state machine
// around the child process — what it refuses, what it reports while running, whether a
// non-zero exit is recorded as a failure rather than passing for a finished video, and
// whether a flake is retried — and a stub script exercises all of that in a second, for
// free. The real render is covered by running it.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let failures = 0;
const eq = (a, b, label) => {
  if (JSON.stringify(a) === JSON.stringify(b)) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n         expected ${JSON.stringify(b)}\n         actual   ${JSON.stringify(a)}`);
};
const throws = async (fn, re, label) => {
  try { await fn(); failures++; console.error(`  FAIL ${label}\n         expected a throw matching ${re}`); }
  catch (e) {
    if (re.test(e.message)) return console.log(`  ok   ${label}`);
    failures++;
    console.error(`  FAIL ${label}\n         expected ${re}\n         actual   ${e.message}`);
  }
};

const { assemble, assembleState } = await import(new URL("../lib/assemble.js", import.meta.url).href);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "venice-assemble-"));
await fs.mkdir(path.join(dir, "timeline"), { recursive: true });
await fs.writeFile(path.join(dir, "timeline", "1.0.json"), JSON.stringify({ section: "1.0", segments: [] }));

// Stands in for remotion/render.mjs: the same shape of output, none of the work. The \r
// matters — the real script draws its progress that way, with no newline until the end.
const ok = path.join(dir, "stub-ok.mjs");
await fs.writeFile(ok, `
process.stdout.write("project  " + process.env.VENICE_PROJECT_DIR + "\\n");
process.stdout.write("sections " + process.argv[2] + "\\n");
process.stdout.write("bundling…\\rbundled  \\n");
process.stdout.write("\\rsection " + process.argv[2] + "  10%");
process.stdout.write("\\rsection " + process.argv[2] + "  64%");
process.stdout.write("\\rsection " + process.argv[2] + " 100%  900f / 30.0s  12.3 MB\\n");
`);

// Shaped like the real Remotion crash: the line that explains it comes first, then a
// stack, and node signs off with its own version banner. Reporting "the last line" is the
// obvious implementation and it names the banner as the cause — which is how this was
// first shipped, and what these assertions exist to stop.
const bad = path.join(dir, "stub-bad.mjs");
await fs.writeFile(bad, `
console.error("Error: Compositor error: No frame found at position 407552 for source clips/1.0/1.1.mp4");
console.error("    at OpenedVideoManager::get_frame_id");
console.error("   3: remotion::thread::WorkerThread::run_on_thread");
console.error("Node.js v20.20.2");
process.exit(1);
`);

// Fails once, then succeeds — the observed fault exactly. The marker file is how one
// process tells the next that it has already had its turn.
const flaky = path.join(dir, "stub-flaky.mjs");
await fs.writeFile(flaky, `
import fs from "node:fs";
const marker = process.env.VENICE_PROJECT_DIR + "/flaked";
if (fs.existsSync(marker)) {
  process.stdout.write("\\rsection " + process.argv[2] + " 100%  900f / 30.0s  12.3 MB\\n");
} else {
  fs.writeFileSync(marker, "x");
  console.error("Error: Compositor error: No frame found at position 407552");
  process.exit(1);
}
`);

const settle = async () => {
  const deadline = Date.now() + 30_000;
  while (assembleState(dir).running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return assembleState(dir);
};

eq(assembleState(dir), { running: false }, "nothing is running before anything is asked for");

await throws(() => assemble(dir, "9.9", { script: ok }), /No timeline/, "a section with no timeline is refused, not spawned");

const started = await assemble(dir, "1.0", { script: ok });
eq(started.running, true, "starting returns immediately with the run marked live");
eq(started.section, "1.0", "and says which section it is assembling");
eq("child" in started, false, "without leaking the child process into the API payload");

await throws(() => assemble(dir, "1.0", { script: ok }), /already running/, "a second assembly is refused while one is in flight");

const done = await settle();
eq(done.running, false, "the run ends");
eq(done.error, null, "with no error");
eq(done.percent, 100, "and at 100%");
eq(done.retried, false, "a render that works first time is not recorded as retried");
eq(typeof done.finishedAt, "string", "stamped with a finish time");
eq(done.output.includes(dir), true, "the child was pinned to this project directory, not the registry's first entry");

console.log("");

// The whole reason for the retry: a transient compositor miss on a clip that is fine.
await assemble(dir, "1.0", { script: flaky });
const recovered = await settle();
eq(recovered.error, null, "a flake on the first attempt is retried and succeeds");
eq(recovered.percent, 100, "reaching 100%");
eq(recovered.retried, true, "while still recording that a retry was needed");
eq(recovered.attempt, 2, "on the second attempt");
eq(/No frame found/.test(recovered.output), true, "and keeping the failed attempt in the log as evidence");

console.log("");

// A render that exits non-zero must not read as a finished video.
await assemble(dir, "1.0", { script: bad });
const failed = await settle();
eq(failed.running, false, "a failing render also ends");
eq(failed.percent, 0, "and does not claim 100%");
eq(failed.attempt, 2, "after being retried");
eq(/exited 1/.test(failed.error || ""), true, "the exit code is reported");
eq(/No frame found/.test(failed.error || ""), true, "along with the line that names the real cause");
eq(/failed 2 attempts/.test(failed.error || ""), true, "and the fact that retrying did not help");
eq(/Node\.js v/.test(failed.error || ""), false, "not node's version banner, which is merely the last thing printed");
eq(/WorkerThread|get_frame_id/.test(failed.error || ""), false, "and not a stack frame");

// One attempt is still available for a caller that does not want the second spend of time.
await assemble(dir, "1.0", { script: bad, attempts: 1 });
const once = await settle();
eq(once.attempt, 1, "attempts:1 spawns exactly once");
eq(/attempts/.test(once.error || ""), false, "and reports the error plainly, with no retry tally");

await fs.rm(dir, { recursive: true, force: true });
console.log(failures ? `\nFAIL ${failures} assertion(s)` : "\nPASS all assertions");
process.exit(failures ? 1 : 0);
