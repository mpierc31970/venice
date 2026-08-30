// Persistent per-project video job queue with a background poller.
import path from "node:path";
import { videoQueue, videoRetrieve, videoComplete } from "../venice.js";
import { readJson, writeJson, P } from "./store.js";
import { saveBuffer, minVideoBytes } from "./media.js";

const CONCURRENCY = 2;
const POLL_MS = 8000;
const active = new Map(); // projectDir -> { timer }

async function load(dir) { return (await readJson(P.jobs(dir), { jobs: [] })).jobs; }
async function save(dir, jobs) { await writeJson(P.jobs(dir), { jobs }); }

export async function listJobs(dir) { return load(dir); }

/**
 * Enqueue a video job. `request` is the exact /video/queue payload (data URLs included),
 * `outFile` is the absolute path to write the mp4, `meta` is free-form (shotId etc.).
 */
export async function enqueue(dir, { request, outFile, meta = {} }) {
  const jobs = await load(dir);
  const job = {
    id: "job_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    status: "PENDING", createdAt: new Date().toISOString(),
    model: request.model, outFile: path.relative(dir, outFile).split(path.sep).join("/"),
    meta, attempts: 0, error: null, queueId: null, downloadUrl: null, eta: null, elapsed: null,
    // Keep the request but drop heavy data URLs for the on-disk record (provenance keeps refs by path in shot.json).
    request: stripData(request),
  };
  jobs.push(job);
  await save(dir, jobs);
  await savePayload(dir, job.id, request);
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
  const jobs = await load(dir);
  const j = jobs.find((x) => x.id === id);
  if (j && (j.status === "PENDING" || j.status === "FAILED")) { j.status = "CANCELLED"; await dropPayload(dir, id); await save(dir, jobs); }
  return j;
}

export async function retryJob(dir, id, request) {
  const jobs = await load(dir);
  const j = jobs.find((x) => x.id === id);
  if (!j) return null;
  j.status = "PENDING"; j.error = null; j.queueId = null; j.attempts += 1;
  await savePayload(dir, id, request);
  await save(dir, jobs);
  ensurePoller(dir);
  return j;
}

export function ensurePoller(dir) {
  if (active.has(dir)) return;
  const timer = setInterval(() => tick(dir).catch((e) => console.error("[jobs]", e.message)), POLL_MS);
  active.set(dir, { timer });
  tick(dir).catch((e) => console.error("[jobs]", e.message));
}

const hooks = new Set();
/** Register a callback(dir, job) fired when a job completes or fails. */
export function onJobDone(fn) { hooks.add(fn); }

async function tick(dir) {
  const jobs = await load(dir);
  let dirty = false;
  const running = jobs.filter((j) => j.status === "PROCESSING");

  // Submit pending jobs up to concurrency.
  for (const j of jobs.filter((j) => j.status === "PENDING")) {
    if (running.length >= CONCURRENCY) break;
    const request = await loadPayload(dir, j.id);
    if (!request) { j.status = "FAILED"; j.error = "Request payload missing. Re-render the shot."; dirty = true; continue; }
    try {
      const out = await videoQueue(request);
      j.queueId = out.queue_id; j.downloadUrl = out.download_url || null;
      j.status = "PROCESSING"; j.submittedAt = new Date().toISOString();
      running.push(j); await dropPayload(dir, j.id); dirty = true;
    } catch (e) {
      j.status = "FAILED"; j.error = e.message; await dropPayload(dir, j.id); dirty = true;
      for (const h of hooks) h(dir, j);
    }
  }

  // Poll processing jobs.
  for (const j of running) {
    try {
      const r = await videoRetrieve({ model: j.model, queue_id: j.queueId });
      if (r.json) {
        const s = r.json;
        j.eta = s.average_execution_time ?? j.eta; j.elapsed = s.execution_duration ?? j.elapsed;
        const status = String(s.status || "").toUpperCase();
        if (status === "COMPLETED" && j.downloadUrl) {
          const buf = Buffer.from(await (await fetch(j.downloadUrl)).arrayBuffer());
          await finish(dir, j, buf, request_resolution(j));
        } else if (status === "FAILED" || status === "ERROR") {
          j.status = "FAILED"; j.error = s.error || s.message || "Venice reported failure";
          for (const h of hooks) h(dir, j);
        }
        dirty = true;
      } else if (r.buffer) {
        await finish(dir, j, r.buffer, request_resolution(j));
        dirty = true;
      }
    } catch (e) {
      // 404/410 etc: mark failed; transient network errors: leave for next tick
      if (e.status && e.status >= 400 && e.status < 500) { j.status = "FAILED"; j.error = e.message; dirty = true; for (const h of hooks) h(dir, j); }
      else console.warn("[jobs] poll error", e.message);
    }
  }

  if (dirty) await save(dir, jobs);
  if (!jobs.some((j) => j.status === "PENDING" || j.status === "PROCESSING")) {
    clearInterval(active.get(dir)?.timer); active.delete(dir);
  }
}

const request_resolution = (j) => j.request?.resolution || "";

async function finish(dir, j, buf, resolution) {
  if (buf.length < minVideoBytes(resolution)) {
    j.status = "FAILED"; j.error = `Venice returned a suspiciously small file (${buf.length} bytes) — likely a silent rejection. Try again or adjust the prompt/references.`;
  } else {
    await saveBuffer(path.join(dir, j.outFile), buf);
    j.status = "COMPLETED"; j.completedAt = new Date().toISOString(); j.bytes = buf.length;
    videoComplete({ model: j.model, queue_id: j.queueId });
  }
  for (const h of hooks) h(dir, j);
}
