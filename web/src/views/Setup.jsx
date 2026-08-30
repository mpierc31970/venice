import React, { useEffect, useState } from "react";
import { useProject, useStudio } from "../lib/store.jsx";
import { Button, ImproveField, ModelPicker, StepHead } from "../components/ui.jsx";
import { api } from "../lib/api.js";

const ASPECTS = ["16:9", "9:16", "1:1", "21:9", "4:3", "3:2"];

export default function Setup() {
  const { project, patchProject, dir } = useProject();
  const { toast } = useStudio();
  const [f, setF] = useState({ title: project.title, logline: project.logline || "", defaults: project.defaults });
  const [busy, setBusy] = useState(false);
  useEffect(() => setF({ title: project.title, logline: project.logline || "", defaults: project.defaults }), [project]);
  const [providers, setProviders] = useState([]);
  useEffect(() => { api.get("/api/providers").then(setProviders).catch(() => {}); }, []);
  const d = f.defaults;
  const setD = (k, v) => setF({ ...f, defaults: { ...d, [k]: v } });
  const save = async () => { setBusy(true); try { await patchProject(f); toast("Saved", "ok"); } catch (e) { toast(e.message, "error"); } finally { setBusy(false); } };

  return (
    <div className="page">
      <StepHead stepKey="setup" checklist={[
        { done: !!f.title, label: "Title" },
        { done: !!project.logline, label: "Logline saved", hint: "one or two sentences: who, wants what, against what, at what stake" },
        { done: !!d.textModel && !!d.imageModel && !!d.videoModel && !!d.ttsModel, label: "Default models chosen (you can override per scene and per shot later)" },
      ]} />
      <div className="card">
        <h2>The film</h2>
        <div className="field"><label>Title</label><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
        <ImproveField label="Logline" kind="logline" rows={2} value={f.logline} onChange={(v) => setF({ ...f, logline: v })} hint="Claude writes the bible from this. Make it specific." />
        <div className="dim small">Folder: <code>{dir}</code></div>
      </div>
      <div className="card">
        <h2>Default models</h2>
        <p className="muted">Lists come live from Venice. Claude does all the writing; pick your image, video and voice engines by taste — step 3 has a bake-off to compare image models on one prompt.</p>
        <div className="row" style={{ gap: 6 }}>
          {providers.map((p) => <span key={p.id} className={`chip ${p.configured ? (p.paid ? "info" : "ok") : ""}`} title={p.note}>{p.label}: {p.configured ? (p.paid ? "paid" : "free tier") : "not configured"}</span>)}
        </div>
        <p className="dim small">Text models come from every configured provider (add GEMINI_API_KEY / OPENAI_API_KEY to .env). Every ✦ button also has a <b>manual</b> mode: copy the prompt into ChatGPT / Gemini and paste the answer back — $0.</p>
        <div className="grid2">
          <ModelPicker label="Writing model" type="text" value={d.textModel} onChange={(v) => setD("textModel", v)} />
          <ModelPicker label="Images (references & keyframes)" type="image" value={d.imageModel} onChange={(v) => setD("imageModel", v)} filter={(m) => !/bg-remover|upscal/.test(m.id)} />
          <ModelPicker label="Image edit (deriving angles from the frontal)" type="image" value={d.editModel} onChange={(v) => setD("editModel", v)} filter={(m) => /edit/.test(m.id)} />
          <ModelPicker label="Video" type="video" value={d.videoModel} onChange={(v) => setD("videoModel", v)} filter={(m) => !/upscale|motion-control/.test(m.id)} />
          <ModelPicker label="Voices (TTS)" type="tts" value={d.ttsModel} onChange={(v) => setD("ttsModel", v)} />
          <div className="field"><label>Aspect ratio</label><select value={d.aspect} onChange={(e) => setD("aspect", e.target.value)}>{ASPECTS.map((a) => <option key={a}>{a}</option>)}</select></div>
          <div className="field"><label>Image resolution</label><select value={d.resolution} onChange={(e) => setD("resolution", e.target.value)}>{["1K", "2K", "4K"].map((a) => <option key={a}>{a}</option>)}</select></div>
          <div className="field"><label>Video resolution</label><select value={d.videoResolution} onChange={(e) => setD("videoResolution", e.target.value)}>{["480p", "720p", "1080p", "4k"].map((a) => <option key={a}>{a}</option>)}</select></div>
        </div>
        <div className="row">
          <label style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}><input type="checkbox" style={{ width: "auto" }} checked={!!d.safeMode} onChange={(e) => setD("safeMode", e.target.checked)} /> Safe mode (blur adult content)</label>
          <label style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}><input type="checkbox" style={{ width: "auto" }} checked={!!d.hideWatermark} onChange={(e) => setD("hideWatermark", e.target.checked)} /> Hide Venice watermark</label>
        </div>
        <div className="row"><Button className="primary" busy={busy} onClick={save}>Save defaults</Button></div>
      </div>
    </div>
  );
}
