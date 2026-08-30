import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { useStudio } from "../lib/store.jsx";
import { Button } from "../components/ui.jsx";

export default function Projects() {
  const nav = useNavigate();
  const { toast } = useStudio();
  const [list, setList] = useState(null);
  const [mode, setMode] = useState(null); // "new" | "open"
  const [form, setForm] = useState({ title: "", dir: "", logline: "" });
  const [busy, setBusy] = useState(false);

  const load = () => api.get("/api/projects").then(setList).catch((e) => toast(e.message, "error"));
  useEffect(() => { load(); }, []); // eslint-disable-line

  const submit = async () => {
    setBusy(true);
    try {
      const r = mode === "new" ? await api.post("/api/projects", form) : await api.post("/api/projects/open", { dir: form.dir });
      nav(`/p/${r.id}/setup`);
    } catch (e) { toast(e.message, "error"); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="hero">
        <h1>Films, made from a bible.</h1>
        <p>Nine guided steps from logline to rendered clips and dialogue. Every prompt is derived from one locked canon so your characters never drift.</p>
      </div>
      <div className="row">
        <Button className="primary" onClick={() => setMode("new")}>New project</Button>
        <Button onClick={() => setMode("open")}>Open existing folder</Button>
      </div>
      {mode ? (
        <div className="card">
          <h2>{mode === "new" ? "New project" : "Open a project folder"}</h2>
          {mode === "new" ? (
            <div className="grid2">
              <div className="field"><label>Title</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="The Keeper's Light" /></div>
              <div className="field"><label>Project folder (created if missing)</label><input className="mono" value={form.dir} onChange={(e) => setForm({ ...form, dir: e.target.value })} placeholder="D:\Films\keepers-light" /></div>
            </div>
          ) : (
            <div className="field"><label>Folder containing project.json</label><input className="mono" value={form.dir} onChange={(e) => setForm({ ...form, dir: e.target.value })} placeholder="D:\Films\keepers-light" /></div>
          )}
          {mode === "new" ? <div className="field"><label>Logline (you can refine it in step 1)</label><textarea rows={2} value={form.logline} onChange={(e) => setForm({ ...form, logline: e.target.value })} placeholder="A lighthouse keeper discovers the light is alive — and it wants to leave." /></div> : null}
          <div className="row">
            <Button className="primary" busy={busy} onClick={submit} disabled={!form.dir || (mode === "new" && !form.title)}>{mode === "new" ? "Create project" : "Open"}</Button>
            <Button className="ghost" onClick={() => setMode(null)}>Cancel</Button>
          </div>
          <p className="dim small">Everything for this film — bible, references, clips, audio — lives in that folder. Drop scene assets into its <code>assets/</code> subfolder any time.</p>
        </div>
      ) : null}
      <h4>Recent projects</h4>
      {list === null ? <p className="dim">Loading…</p> : !list.length ? <p className="dim">No projects yet.</p> : (
        <div className="projects">
          {list.map((p) => (
            <div key={p.id} className="card project" onClick={() => p.exists && nav(`/p/${p.id}/setup`)} style={{ opacity: p.exists ? 1 : 0.5 }}>
              <h3>{p.title}</h3>
              <div className="dir">{p.dir}</div>
              {!p.exists ? <span className="chip bad">folder missing</span> : null}
              <div className="row" style={{ marginTop: 4 }}>
                {p.exists ? <Button className="xs" onClick={(e) => { e.stopPropagation(); api.post(`/api/projects/${p.id}/open-folder`, {}).catch((err) => toast(err.message, "error")); }}>📁 Open folder</Button> : null}
                <Button className="ghost xs danger" onClick={(e) => { e.stopPropagation(); api.del(`/api/projects/${p.id}`).then(load); }}>Remove from list</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
