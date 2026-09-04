// Regression test: jobs.json is rewritten whole, so every read-modify-write must
// be serialized. Before lib/jobs.js took a per-project lock, a tick() awaiting a
// slow /video/queue saved the array it had loaded and erased every job enqueued
// meanwhile — 10 of 11 renders vanished in this scenario.
//
// Run: node server/test/jobs-race.test.mjs
// Stubs global fetch, so it makes no network calls and spends no Venice credit.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VENICE_API_KEY = "test-key-not-used";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

// Slow /video/queue: this is the window during which writes used to be lost.
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/video/queue")) { await sleep(400); return json({ queue_id: "q_" + Math.random().toString(36).slice(2) }); }
  if (u.includes("/video/retrieve")) return json({ status: "PENDING" });
  return json({});
};

const { enqueue } = await import(new URL("../lib/jobs.js", import.meta.url).href);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "venice-jobs-race-"));
const req = (n) => ({ model: "test-video", prompt: "shot " + n, resolution: "720p" });
const COUNT = 10;

// 1. First enqueue starts the poller; its tick immediately awaits the slow queue call.
await enqueue(dir, { request: req(0), outFile: path.join(dir, "shots/s0/clip.mp4"), meta: { shotId: "s0" } });

// 2. While that tick is mid-flight, enqueue more — what a user does clicking Render repeatedly.
await sleep(50);
await Promise.all(
  Array.from({ length: COUNT }, (_, i) =>
    enqueue(dir, { request: req(i + 1), outFile: path.join(dir, `shots/s${i + 1}/clip.mp4`), meta: { shotId: "s" + (i + 1) } })
  )
);

// 3. Let the in-flight tick finish and write.
await sleep(1200);

const onDisk = JSON.parse(await fs.readFile(path.join(dir, "jobs.json"), "utf8")).jobs;
const seen = new Set(onDisk.map((j) => j.meta.shotId));
const missing = Array.from({ length: COUNT + 1 }, (_, i) => "s" + i).filter((s) => !seen.has(s));

console.log(`enqueued ${COUNT + 1}, persisted ${onDisk.length}`);
await fs.rm(dir, { recursive: true, force: true });

if (missing.length) {
  console.error("FAIL - jobs lost to the jobs.json race: " + missing.join(", "));
  process.exit(1);
}
console.log("PASS - no jobs lost");
process.exit(0);
