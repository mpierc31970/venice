import React, { useEffect, useState } from "react";
import { api, stream } from "../lib/api.js";
import { useProject, useStudio } from "../lib/store.jsx";
import { Button, ImproveField, ModelPicker, StepHead } from "../components/ui.jsx";

export default function Script() {
  const { id, project, script, elements, reload } = useProject();
  const { toast, refreshBilling } = useStudio();
  const [text, setText] = useState(script?.screenplay || "");
  const [scenes, setScenes] = useState(script?.scenes || []);
  const [notes, setNotes] = useState("");
  const [model, setModel] = useState(null);
  const [busy, setBusy] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(null);
  useEffect(() => { setText(script?.screenplay || ""); setScenes(script?.scenes || []); setDirty(false); }, [script]);

  const gen = async () => {
    if (text && !confirm("Replace the current screenplay?")) return;
    setBusy("gen"); setText("");
    try { await stream(`/api/projects/${id}/script/screenplay`, { notes, model: model || undefined }, (_d, full) => setText(full)); await reload(); refreshBilling(); toast("Screenplay written. Next: break it into scenes.", "ok"); }
    catch (e) { toast(e.message, "error"); } finally { setBusy(null); }
  };
  const save = async () => { setBusy("save"); try { await api.put(`/api/projects/${id}/script`, { screenplay: text, scenes }); setDirty(false); await reload(); toast("Saved", "ok"); } catch (e) { toast(e.message, "error"); } finally { setBusy(null); } };
  const breakdown = async () => {
    setBusy("scenes");
    try { if (dirty) await api.put(`/api/projects/${id}/script`, { screenplay: text }); const s = await api.post(`/api/projects/${id}/script/scenes`, { model: model || undefined }); setScenes(s); await reload(); refreshBilling(); toast(`${s.length} scene(s). Now build a shot list for each.`, "ok"); }
    catch (e) { toast(e.message, "error"); } finally { setBusy(null); }
  };
  const shotlist = async (sid, videoModel) => {
    setBusy("shots-" + sid);
    try { if (dirty) await api.put(`/api/projects/${id}/script`, { scenes }); const r = await api.post(`/api/projects/${id}/script/scenes/${sid}/shotlist`, { model: model || undefined, videoModel }); await reload(); refreshBilling(); toast(`${r.shots.length} shots for ${sid}.`, "ok"); }
    catch (e) { toast(e.message, "error"); } finally { setBusy(null); }
  };
  const setScene = (i, patch) => { const next = scenes.map((s, j) => (j === i ? { ...s, ...patch } : s)); setScenes(next); setDirty(true); };
  const setLine = (i, li, patch) => setScene(i, { dialogue: scenes[i].dialogue.map((d, j) => (j === li ? { ...d, ...patch } : d)) });
  const chars = elements.filter((e) => e.type === "character");

  return (
    <div className="page">
      <StepHead stepKey="script" checklist={[
        { done: !!text.trim(), label: "Screenplay written" },
        { done: scenes.length > 0, label: "Broken into scenes with mood and dialogue" },
        { done: scenes.length > 0 && scenes.every((s) => s.shots?.length), label: "Every scene has an AI-optimized shot list", hint: "one motion idea and one camera move per shot" },
      ]}>
        <div className="row"><ModelPicker type="text" value={model} onChange={setModel} allowEmpty small /></div>
      </StepHead>

      <div className="card">
        <header><h2>1 · Screenplay</h2><span className="grow" />{dirty ? <span className="chip warn">unsaved</span> : null}<Button className="sm" busy={busy === "save"} onClick={save} disabled={!dirty}>Save</Button></header>
        <ImproveField label="Notes for Claude (optional)" kind="generic" rows={2} value={notes} onChange={setNotes} placeholder="Length, structure, a scene you must have, an ending…" />
        <div className="row"><Button className="claude" busy={busy === "gen"} onClick={gen} disabled={!chars.length}>✦ {text ? "Rewrite screenplay" : "Write screenplay"}</Button>{!chars.length ? <span className="dim small">Needs at least one character (step 3).</span> : <span className="dim small">Uses the bible, world seed and every character's verbatim description.</span>}</div>
        <textarea className="mono" rows={18} value={text} onChange={(e) => { setText(e.target.value); setDirty(true); }} placeholder="INT. LIGHTHOUSE — NIGHT…" />
      </div>

      <div className="card">
        <header><h2>2 · Scenes</h2><span className="grow" /><Button className="claude" busy={busy === "scenes"} onClick={breakdown} disabled={!text.trim()}>✦ Break into scenes</Button></header>
        {!scenes.length ? <p className="dim">No scenes yet.</p> : scenes.map((s, i) => (
          <div key={s.id} className="card" style={{ background: "var(--bg-2)" }}>
            <header style={{ cursor: "pointer" }} onClick={() => setOpen(open === s.id ? null : s.id)}>
              <span className="mono dim">{s.id}</span><h3 className="grow">{s.title}</h3>
              <span className="chip">{s.location}</span>
              {s.shots?.length ? <span className="chip ok">{s.shots.length} shots</span> : <span className="chip warn">no shots</span>}
              <span className="dim">{open === s.id ? "▾" : "▸"}</span>
            </header>
            {open === s.id ? (
              <>
                <div className="grid2">
                  <div className="field"><label>Title</label><input value={s.title} onChange={(e) => setScene(i, { title: e.target.value })} /></div>
                  <div className="field"><label>Location</label><input value={s.location || ""} onChange={(e) => setScene(i, { location: e.target.value })} /></div>
                </div>
                <ImproveField label="Mood" kind="mood" rows={2} value={s.mood} onChange={(v) => setScene(i, { mood: v })} context={`Scene: ${s.title}. ${s.synopsis}`} />
                <div className="field"><label>Synopsis</label><textarea rows={3} value={s.synopsis || ""} onChange={(e) => setScene(i, { synopsis: e.target.value })} /></div>
                <div className="field"><label>Characters (comma-separated)</label><input value={(s.characters || []).join(", ")} onChange={(e) => setScene(i, { characters: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></div>
                <h4>Dialogue</h4>
                <table><thead><tr><th style={{ width: 40 }}>#</th><th style={{ width: 160 }}>Character</th><th>Line</th><th style={{ width: 180 }}>Direction</th></tr></thead>
                  <tbody>{(s.dialogue || []).map((d, li) => (
                    <tr key={li}><td className="mono dim">{li}</td>
                      <td><select value={d.character} onChange={(e) => setLine(i, li, { character: e.target.value })} style={{ padding: "4px 26px 4px 6px" }}>{[d.character, ...chars.map((c) => c.name)].filter((v, k, a) => a.indexOf(v) === k).map((n) => <option key={n}>{n}</option>)}</select></td>
                      <td><ImproveField label="" kind="dialogue" rows={1} value={d.line} onChange={(v) => setLine(i, li, { line: v })} context={`${d.character}, ${d.direction || ""}`} /></td>
                      <td><input value={d.direction || ""} onChange={(e) => setLine(i, li, { direction: e.target.value })} style={{ padding: "4px 6px" }} /></td></tr>
                  ))}</tbody></table>
                <div className="row"><Button className="ghost xs" onClick={() => setScene(i, { dialogue: [...(s.dialogue || []), { character: chars[0]?.name || "", line: "", direction: "" }] })}>+ line</Button></div>
                <hr />
                <div className="row">
                  <ModelPicker type="video" value={s.videoModel || project.defaults.videoModel} onChange={(v) => setScene(i, { videoModel: v })} small filter={(m) => !/upscale|motion-control/.test(m.id)} />
                  <Button className="claude" busy={busy === "shots-" + s.id} onClick={() => shotlist(s.id, s.videoModel)}>✦ {s.shots?.length ? "Rebuild shot list" : "Build shot list"}</Button>
                  <span className="dim small">Durations are matched to this video model's ladder.</span>
                </div>
                {s.shots?.length ? <ShotTable sid={s.id} /> : null}
              </>
            ) : null}
          </div>
        ))}
        {dirty ? <div className="row"><Button className="primary sm" busy={busy === "save"} onClick={save}>Save changes</Button></div> : null}
      </div>
    </div>
  );
}

function ShotTable({ sid }) {
  const { shots } = useProject();
  const list = shots.filter((s) => s.sceneId === sid);
  return (
    <table>
      <thead><tr><th>#</th><th>Type</th><th>Camera</th><th>Dur</th><th>Action</th><th>Cast</th></tr></thead>
      <tbody>{list.map((s) => <tr key={s.id}><td className="mono dim">{s.id}</td><td>{s.type}</td><td>{s.camera}</td><td className="mono">{s.durationS}</td><td>{s.action}</td><td className="dim">{(s.characters || []).join(", ")}</td></tr>)}</tbody>
    </table>
  );
}
