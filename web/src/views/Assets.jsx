import React, { useState } from "react";
import { api, media, fileToBase64 } from "../lib/api.js";
import { useProject, useStudio } from "../lib/store.jsx";
import { Button, StepHead, Thumb } from "../components/ui.jsx";

const KINDS = [["plate", "Scene plate (no people)"], ["prop", "Prop"], ["style", "Style reference"], ["wardrobe", "Wardrobe"], ["other", "Other"]];

export default function Assets() {
  const { id, assets, reload } = useProject();
  const { toast } = useStudio();
  const [busy, setBusy] = useState(false);
  const files = assets?.files || [];
  const tag = async (path, kind, note) => { try { await api.put(`/api/projects/${id}/assets/tag`, { path, kind, note }); await reload(); } catch (e) { toast(e.message, "error"); } };
  const upload = async (list) => { setBusy(true); try { for (const f of list) await api.post(`/api/projects/${id}/assets/upload`, { name: f.name, data: await fileToBase64(f) }); await reload(); toast(`Added ${list.length} file(s).`, "ok"); } catch (e) { toast(e.message, "error"); } finally { setBusy(false); } };
  return (
    <div className="page wide">
      <StepHead stepKey="assets" checklist={[
        { done: files.length > 0, label: "Files present in the assets folder", hint: "drop images into the folder below, or upload" },
        { done: files.some((f) => f.kind === "plate"), label: "At least one scene plate tagged", hint: "clean, uncluttered, no people — used as @Image references and keyframe style refs" },
      ]}>
        <div className="row">
          <label className="btn" style={{ margin: 0 }}>{busy ? "Uploading…" : "Upload files…"}<input type="file" multiple accept="image/*,video/*,audio/*" style={{ display: "none" }} onChange={(e) => upload([...e.target.files])} /></label>
          <Button onClick={reload}>Rescan folder</Button>
        </div>
      </StepHead>
      <div className="card" style={{ padding: "10px 16px" }}><span className="dim small">Folder:</span> <code>{assets?.dir}</code> <span className="dim small">— anything you put here (Explorer, Finder, a download) shows up after Rescan. Tag each file so the pipeline knows how to use it.</span></div>
      {!files.length ? <div className="card dim">Nothing here yet. Location plates from step 3 also count — they live under elements/.</div> : (
        <div className="thumbs" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
          {files.map((f) => (
            <div key={f.path} className="stack" style={{ gap: 6 }}>
              {f.kind === "image" || /\.(png|jpe?g|webp|gif)$/i.test(f.path) ? <Thumb wide src={media(id, f.path)} caption={f.path.replace(/^assets\//, "")} tag={f.kind || undefined} /> : f.path.match(/\.(mp4|webm|mov)$/i) ? <Thumb wide video src={media(id, f.path)} caption={f.path.replace(/^assets\//, "")} /> : <div className="empty wide">{f.path.replace(/^assets\//, "")}</div>}
              <select value={f.kind || ""} onChange={(e) => tag(f.path, e.target.value || null, f.note)} style={{ padding: "5px 30px 5px 8px", fontSize: 12.5 }}>
                <option value="">— untagged —</option>
                {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <input placeholder="Note (e.g. lighthouse interior, night)" defaultValue={f.note || ""} onBlur={(e) => e.target.value !== (f.note || "") && tag(f.path, f.kind, e.target.value)} style={{ padding: "5px 8px", fontSize: 12.5 }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
