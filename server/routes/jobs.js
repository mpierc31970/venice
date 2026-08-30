import { Router } from "express";
import { listJobs, cancelJob, ensurePoller } from "../lib/jobs.js";

const r = Router();

r.get("/", async (req, res, next) => {
  try {
    const jobs = await listJobs(req.proj.dir);
    if (jobs.some((j) => j.status === "PENDING" || j.status === "PROCESSING")) ensurePoller(req.proj.dir);
    res.json(jobs.slice().reverse());
  } catch (e) { next(e); }
});

r.post("/:jobId/cancel", async (req, res, next) => {
  try { res.json(await cancelJob(req.proj.dir, req.params.jobId)); } catch (e) { next(e); }
});

export default r;
