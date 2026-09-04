// Persistent per-project video job queue with a background poller.
import path from "node:path";
import { videoQueue, videoRetrieve, videoComplete } from "../venice.js";
import { readJson, writeJson, P } from "./store.js";
import { saveBuffer, minVideoBytes } from "./media.js";

const CONCURRENCY = 2;
const POLL_MS = 8000;
const active = new Map(); // projectDir -> { timer, busy }

async function load(dir) { return (await readJson(P.jobs(dir), { jobs: [] })).jobs; }
async function save(dir, jobs) { await writeJson(P.jobs(dir), { jobs }); }

/**
 * Serialize every read-modify-write of jobs.json per project dir.
 * jobs.json is rewritten whole, so an unguarded caller saves the array it read
 * earlier — a tick() awaiting a Venice call or an mp4 download would silently
 * erase jobs enqueued meanwhile, and an enqueue would erase the tick's status
 * updates. Keep the critical section short: never await network work inside fn.
 */
const chains = new Map(); // projectDir -> Promise
function withJobs(dir, fn) {
  const run = (chains.get(dir) || Promise.resolve()).then(async () => {
    const jobs = await load(dir);
    const out = await fn(jobs);
    await save(dir, jobs);
    return out;
  });
  chains.set(dir, run.catch(() => {}));
  return run;
}

/** Apply mutate to one job under the lock, on a freshly loaded array. */
function patchJob(dir, id, mutate) {
  return withJobs(dir, (jobs) => {
    const j = jobs.find((x) => x.id === id);
    if (j) mutate(j);
    return j;
  });
}

export async function listJobs(dir) { return load(dir); }

/**
 * Enqueue a video job. `request` is the exact /video/queue payload (data URLs included),
 * `outFile` is the absolute path to write the mp4, `meta` is free-form (shotId etc.).
 */
export async function enqueue(dir, { request, outFile, meta = {} }) {
  const job = {
    id: "job_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    status: "PENDING", createdAt: new Date().toISOString(),
    model: request.model, outFile: path.relative(dir, outFile).split(path.sep).join("/"),
    meta, attempts: 0, error: null, queueId: null, downloadUrl: null, eta: null, elapsed: null,
    // Keep the request but drop heavy data URLs for the on-disk record (provenance keeps refs by path in shot.json).
    request: stripData(request),
  };
  // Payload first: a poller already running for this dir must never see a
  // PENDING job whose payload has not landed yet.
  await savePayload(dir, job.id, request);
  await withJobs(dir, (jobs) => { jobs.push(job); });
  ensurePoller(dir);
  return job;
}

// Full payloads (with data URLs) persisted under <project>/.jobs/<id>.json so they survive restarts.
const payloadFile = (dir, id) => path.join(dir, ".jobs", id + ".json");
async function savePayload(dir, id, request) { await writeJson(payloadFile(dir, id), request); }
async function loadPayload(dir, id) { return readJson(payloadFile(dir, id), null); }
async function dropPayload(dir, id) { try { await (await import("node:fs/promises")).unlink(payloadFile(dir, id)); } catch {} }
function stripData(req) {
  const clone = JSON.parse(JSON.stringify(req));
  const strip = (v) => (typeof v === "string" && v.startsWith("data:") ? `<data:${v.slice(5, 20)}... ${v.length} chars>` : v);
  for (const k of Object.keys(clone)) {
    const v = clone[k];
    if (Array.isArray(v)) clone[k] = v.map((x) => (typeof x === "string" ? strip(x) : typeof x === "object" && x ? Object.fromEntries(Object.entries(x).map(([a, b]) => [a, Array.isArray(b) ? b.map(strip) : strip(b)])) : x));
    else clone[k] = strip(v);
  }
  return clone;
}

export async function cancelJob(dir, id) {
  const j = await patchJob(dir, id, (j) => {
    if (j.status === "PENDING" || j.status === "FAILED") j.status = "CANCELLED";
  });
  if (j?.status === "CANCELLED") await dropPayload(dir, id);
  return j;
}

export async function retryJob(dir, id, request) {
  const existing = (await load(dir)).find((x) => x.id === id);
  if (!existing) return null;
  // Payload before status, so the poller cannot pick up a PENDING job early.
  await savePayload(dir, id, request);
  const j = await patchJob(dir, id, (j) => {
    j.status = "PENDING"; j.error = null; j.queueId = null; j.attempts += 1;
  });
  if (j) ensurePoller(dir);
  return j;
}

export function ensurePoller(dir) {
  if (active.has(dir)) return;
  const timer = setInterval(() => runTick(dir), POLL_MS);
  active.set(dir, { timer, busy: false });
  runTick(dir);
}

const hooks = new Set();
/** Register a callback(dir, job) fired when a job completes or fails. */
export function onJobDone(fn) { hooks.add(fn); }
function fire(dir, job) {
  for (const h of hooks) Promise.resolve(h(dir, job)).catch((e) => console.error("[jobs] hook", e.message));
}

/**
 * Guard against overlapping ticks: a tick that downloads a large mp4 can outlast
 * POLL_MS, and two concurrent ticks would submit the same PENDING job twice.
 */
function runTick(dir) {
  const entry = active.get(dir);
  if (!entry || entry.busy) return;
  entry.busy = true;
  tick(dir)
    .catch((e) => console.error("[jobs]", e.message))
    .finally(() => { const e2 = active.get(dir); if (e2) e2.busy = false; });
}

async function tick(dir) {
  const snapshot = await load(dir);
  const running = snapshot.filter((j) => j.status === "PROCESSING");

  // Submit pending jobs up to concurrency.
  for (const pending of snapshot.filter((j) => j.status === "PENDING")) {
    if (running.length >= CONCURRENCY) break;
    const request = await loadPayload(dir, pending.id);
    if (!request) {
      const j = await patchJob(dir, pending.id, (j) => {
        j.status = "FAILED"; j.error = "Request payload missing. Re-render the shot.";
      });
      if (j) fire(dir, j);
      continue;
    }
    try {
      const out = await videoQueue(request);
      const j = await patchJob(dir, pending.id, (j) => {
        j.queueId = out.queue_id; j.downloadUrl = out.download_url || null;
        j.status = "PROCESSING"; j.submittedAt = new Date().toISOString();
      });
      await dropPayload(dir, pending.id);
      if (j) running.push(j);
    } catch (e) {
      const j = await patchJob(dir, pending.id, (j) => { j.status = "FAILED"; j.error = e.message; });
      await dropPayload(dir, pending.id);
      if (j) fire(dir, j);
    }
  }

  // Poll processing jobs.
  for (const j of running) {
    try {
      const r = await videoRetrieve({ model: j.model, queue_id: j.queueId });
      if (r.json) {
        const s = r.json;
        await patchJob(dir, j.id, (x) => {
          x.eta = s.average_execution_time ?? x.eta;
          x.elapsed = s.execution_duration ?? x.elapsed;
        });
        const status = String(s.status || "").toUpperCase();
        if (status === "COMPLETED" && j.downloadUrl) {
          const buf = Buffer.from(await (await fetch(j.downloadUrl)).arrayBuffer());
          await finish(dir, j, buf, request_resolution(j));
        } else if (status === "COMPLETED") {
          // Completed with no download URL would otherwise poll forever.
          const done = await patchJob(dir, j.id, (x) => {
            x.status = "FAILED"; x.error = "Venice reported COMPLETED but returned no download URL.";
          });
          if (done) fire(dir, done);
        } else if (status === "FAILED" || status === "ERROR") {
          const done = await patchJob(dir, j.id, (x) => {
            x.status = "FAILED"; x.error = s.error || s.message || "Venice reported failure";
          });
          if (done) fire(dir, done);
        }
      } else if (r.buffer) {
        await finish(dir, j, r.buffer, request_resolution(j));
      }
    } catch (e) {
      // 404/410 etc: mark failed; transient network errors: leave for next tick
      if (e.status && e.status >= 400 && e.status < 500) {
        const done = await patchJob(dir, j.id, (x) => { x.status = "FAILED"; x.error = e.message; });
        if (done) fire(dir, done);
      } else console.warn("[jobs] poll error", e.message);
    }
  }

  const after = await load(dir);
  if (!after.some((j) => j.status === "PENDING" || j.status === "PROCESSING")) {
    clearInterval(active.get(dir)?.timer);
    active.delete(dir);
  }
}

const request_resolution = (j) => j.request?.resolution || "";

async function finish(dir, j, buf, resolution) {
  let done;
  if (buf.length < minVideoBytes(resolution)) {
    done = await patchJob(dir, j.id, (x) => {
      x.status = "FAILED";
      x.error = `Venice returned a suspiciously small file (${buf.length} bytes) — likely a silent rejection. Try again or adjust the prompt/references.`;
    });
  } else {
    await saveBuffer(path.join(dir, j.outFile), buf);
    done = await patchJob(dir, j.id, (x) => {
      x.status = "COMPLETED"; x.completedAt = new Date().toISOString(); x.bytes = buf.length;
    });
    videoComplete({ model: j.model, queue_id: j.queueId }); // swallows its own errors
  }
  if (done) fire(dir, done);
}
