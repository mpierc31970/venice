// Regression: a server restart mid-render must not strand a paid clip.
// Run: node server/test/orphan.test.mjs
//
// `node --watch` restarts on any file edit, which wipes the in-memory run state. The job
// keeps rendering at Venice and is charged for either way, so when it finishes with no
// run waiting on it, the row must still be updated — otherwise it sits at "rendering"
// for ever with a finished mp4 on disk beside it, and a re-run pays for it twice.
//
// This drives the real path: a real enqueue, the real poller, the real onJobDone hook
// that lib/batch.js registers at import. Nothing here is simulated except the network,
// so it makes no calls and spends nothing.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VENICE_API_KEY = "test-key-not-used";

const MP4 = Buffer.alloc(80_000, 7); // over minVideoBytes for 480p, so it counts as real
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/video/queue")) return json({ queue_id: "q_test", download_url: "https://example.test/clip.mp4" });
  if (u.includes("/video/retrieve")) return json({ status: "COMPLETED", average_execution_time: 120, execution_duration: 118 });
  if (u.includes("example.test")) return new Response(MP4, { status: 200, headers: { "content-type": "video/mp4" } });
  if (u.includes("/video/complete")) return json({ ok: true });
  throw new Error("unexpected fetch: " + u);
};

// Importing batch.js registers its onJobDone hook — the thing under test.
const batch = await import(new URL("../lib/batch.js", import.meta.url).href);
const { enqueue } = await import(new URL("../lib/jobs.js", import.meta.url).href);

let failures = 0;
const eq = (a, b, label) => {
  if (JSON.stringify(a) === JSON.stringify(b)) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n         expected ${JSON.stringify(b)}\n         actual   ${JSON.stringify(a)}`);
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "venice-orphan-"));
await batch.withRows(dir, (s) => {
  s.rows = [
    { id: "1.17", section: "1.1", n: 9, status: "rendering", jobId: null, clip: null, error: null },
    { id: "1.19", section: "1.1", n: 11, status: "pending", jobId: null, clip: null, error: null },
  ];
});

// A job carrying batchId, with no run in memory waiting on it — exactly the state a
// restart leaves behind. batch.start() is never called.
const job = await enqueue(dir, {
  request: { model: "wan-3-0-reference-to-video", prompt: "test", resolution: "480p" },
  outFile: path.join(dir, "clips", "1.1", "1.17.mp4"),
  meta: { batchId: "run_that_no_longer_exists", rowId: "1.17" },
});
await batch.patchRow(dir, "1.17", (r) => { r.jobId = job.id; });

// Let the poller submit, retrieve, download and fire the hook.
const deadline = Date.now() + 15_000;
let row;
do {
  await new Promise((r) => setTimeout(r, 250));
  row = (await batch.listRows(dir)).find((r) => r.id === "1.17");
} while (row.status === "rendering" && Date.now() < deadline);

eq(row.status, "rendered", "a completed orphan is recorded as rendered, not left rendering for ever");
eq(row.clip, "clips/1.1/1.17.mp4", "and keeps the clip that was paid for");
eq(row.error, null, "with no error recorded");

const onDisk = await fs.stat(path.join(dir, "clips", "1.1", "1.17.mp4")).then((s) => s.size).catch(() => 0);
eq(onDisk, MP4.length, "the mp4 really landed on disk at the deterministic path");

const other = (await batch.listRows(dir)).find((r) => r.id === "1.19");
eq(other.status, "pending", "rows the job had nothing to do with are untouched");

await fs.rm(dir, { recursive: true, force: true });
console.log(failures ? `\nFAIL ${failures} assertion(s)` : "\nPASS all assertions");
process.exit(failures ? 1 : 0);
