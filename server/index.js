import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { VeniceError } from "./venice.js";
import { DryRun } from "./lib/llm.js";
import { providerStatus } from "./lib/providers.js";
import { openProject, inside } from "./lib/store.js";
import models from "./routes/models.js";
import billing from "./routes/billing.js";
import projects from "./routes/projects.js";
import { mountProjectRoutes } from "./routes/project-routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3939);

const app = express();
app.use(express.json({ limit: "50mb" }));

app.use("/api/models", models);
app.use("/api/billing", billing);
app.use("/api/projects", projects);
mountProjectRoutes(app);

// Serve any file inside a project folder: /media/:projectId/<relative path>
app.get("/media/:id/*", async (req, res, next) => {
  try {
    const { dir } = await openProject(req.params.id);
    const abs = inside(dir, req.params[0]);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return res.status(404).end();
    res.sendFile(abs);
  } catch (e) { next(e); }
});

app.get("/api/providers", (_req, res) => res.json(providerStatus()));

// Production: serve the built web app
const dist = path.join(__dirname, "..", "web", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use((err, _req, res, _next) => {
  if (err instanceof DryRun) return res.json({ dry: true, ...err.dry });
  const status = err.status || (err instanceof VeniceError ? err.status : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message, detail: err.detail ?? null });
});

app.listen(PORT, () => console.log(`Venice Studio API on http://localhost:${PORT}`));
