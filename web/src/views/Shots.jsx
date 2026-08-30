import React, { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, media } from "../lib/api.js";
import { useProject, useStudio } from "../lib/store.jsx";
import { Button, ImproveField, ModelPicker, StepHead, Thumb, Empty, money } from "../components/ui.jsx";
import { ClaudeAction, ImportButton } from "../components/manual.jsx";
import { fileToBase64 } from "../lib/api.js";

const MODE = {
  keyframes: { step: "keyframes", title: "Keyframe" },
  render: { step: "render", title: "Render" },
  dialogue: { step: "dialogue", title: "Dialogue" },
};

export default function Shots() {
  const { mode } = useParams();
  const { id, shots, script, elements } = useProject();
  const [sel, setSel] = useState(shots[0]?.id || null);
  useEffect(() => { if (!shots.find((s) => s.id === sel)) setSel(shots[0]?.id || null); }, [shots]); // eslint-disable-line
  const m = MODE[mode] || MODE.keyframes;
  const shot = shots.find((s) => s.id === sel);
  const scenes = script?.scenes || [];
  const linesNeeded = shots.flatMap((sh) => (sh.dialogueLines || []).map((i) => `${sh.id}:${i}`));

  const checklist = {
    keyframes: [{ done: shots.length > 0, label: "Shot list exists (step 5)" }, { done: shots.length > 0 && shots.every((s) => s.keyframePrompt), label: "Every shot has a keyframe prompt" }, { done: shots.length > 0 && shots.every((s) => s.keyframe), label: "Every shot has a locked keyframe" }],
    render: [{ done: shots.length > 0 && shots.every((s) => s.keyframe), label: "Every shot has a keyframe (step 6)" }, { done: elements.filter((e) => e.type === "character").every((e) => e.locked), label: "Characters locked (step 3) so their 4 angles ride along as @Elements" }, { done: shots.length > 0 && shots.every((s) => s.clip), label: "Every shot has a clip" }],
    dialogue: [{ done: linesNeeded.length > 0 || shots.length > 0, label: "Shots reference dialogue lines" }, { done: elements.filter((e) => e.type === "character").every((e) => e.voice?.voice || e.voice?.vvId), label: "Every character has a voice (step 3)" }, { done: linesNeeded.length > 0 && linesNeeded.every((k) => shots.some((sh) => sh.id === k.split(":")[0] && (sh.lines || []).some((l) => String(l.lineIndex) === k.split(":")[1]))), label: "Every line rendered" }],
  }[mode] || [];

  return (
    <div className="page wide">
      <StepHead stepKey={m.step} checklist={checklist}>
        {mode === "render" ? <BatchRender /> : null}
      </StepHead>
      {!shots.length ? <div className="card dim">No shots yet — build shot lists in <Link to={`/p/${id}/script`}>step 5</Link>.</div> : (
        <div className="split">
          <div className="card flush side">
            <div className="list">
              {scenes.map((sc) => (
                <React.Fragment key={sc.id}>
                  <div className="item" style={{ cursor: "default", background: "var(--bg-2)" }}><span className="mono dim small">{sc.id}</span><span className="small grow">{sc.title}</span></div>
                  {shots.filter((s) => s.sceneId === sc.id).map((s) => (
                    <div key={s.id} className={`item ${sel === s.id ? "active" : ""}`} onClick={() => setSel(s.id)}>
                      <div style={{ width: 48, height: 30, borderRadius: 4, overflow: "hidden", background: "var(--bg-3)", flex: "none" }}>{s.keyframe ? <img src={media(id, s.keyframe)} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt="" /> : null}</div>
                      <div className="grow" style={{ minWidth: 0 }}><div className="mono small">{s.id} <span className="dim">{s.durationS}</span></div><div className="dim small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.action}</div></div>
                      <StatusDot shot={s} mode={mode} />
                    </div>
                  ))}
                </React.Fragment>
              ))}
            </div>
          </div>
          {shot ? (mode === "render" ? <RenderPanel key={shot.id} shot={shot} /> : mode === "dialogue" ? <DialoguePanel key={shot.id} shot={shot} /> : <KeyframePanel key={shot.id} shot={shot} />) : null}
        </div>
      )}
    </div>
  );
}

function StatusDot({ shot, mode }) {
  const { jobs } = useProject();
  const job = jobs?.find((j) => j.id === shot.jobId);
  const active = job && (job.status === "PENDING" || job.status === "PROCESSING");
  const done = mode === "keyframes" ? !!shot.keyframe : mode === "render" ? !!shot.clip : (shot.dialogueLines || []).length > 0 && (shot.dialogueLines || []).every((i) => (shot.lines || []).some((l) => l.lineIndex === i));
  const na = mode === "dialogue" && !(shot.dialogueLines || []).length;
  return <span className="led" style={{ width: 8, height: 8, borderRadius: "50%", flex: "none", background: active ? "var(--accent)" : na ? "var(--line-2)" : done ? "var(--ok)" : "var(--bg-3)", boxShadow: active ? "0 0 8px var(--accent)" : "none" }} />;
}

function useShotOps(shot) {
  const { id, reload } = useProject();
  const { toast, refreshBilling } = useStudio();
  const [busy, setBusy] = useState(null);
  const run = async (key, fn, ok) => { setBusy(key); try { const r = await fn(); await reload(); refreshBilling(); if (ok) toast(typeof ok === "function" ? ok(r) : ok, "ok"); return r; } catch (e) { toast(e.message, "error", 8000); } finally { setBusy(null); } };
  const patch = (p) => api.patch(`/api/projects/${id}/shots/${shot.id}`, p);
  return { busy, run, patch, id };
}

function ShotMeta({ shot, local, setLocal }) {
  const { assets, elements, id } = useProject();
  const plates = [...(assets?.files || []).filter((f) => f.kind === "plate" || f.kind === "style").map((f) => ({ path: f.path, label: f.path.replace(/^assets\//, "") })), ...elements.filter((e) => e.type === "location" && e.angles?.frontal).map((e) => ({ path: e.angles.frontal.file, label: `${e.name} (location plate)` }))];
  return (
    <>
      <div className="grid2">
        <div className="field"><label>Action (one motion idea)</label><textarea rows={2} value={local.action} onChange={(e) => setLocal({ ...local, action: e.target.value })} /></div>
        <div className="field"><label>Camera (one instruction)</label><input value={local.camera || ""} onChange={(e) => setLocal({ ...local, camera: e.target.value })} /></div>
      </div>
      <div className="field"><label>Scene plates / style references for this shot</label>
        <div className="row" style={{ gap: 6 }}>
          {plates.map((p) => <label key={p.path} className={`chip ${local.plates?.includes(p.path) ? "accent" : ""}`} style={{ cursor: "pointer" }}><input type="checkbox" style={{ display: "none" }} checked={!!local.plates?.includes(p.path)} onChange={(e) => setLocal({ ...local, plates: e.target.checked ? [...(local.plates || []), p.path] : local.plates.filter((x) => x !== p.path) })} />{p.label}</label>)}
          {!plates.length ? <span className="dim small">No plates tagged yet (step 4) and no location references (step 3).</span> : null}
        </div>
      </div>
      <div className="row dim small">Cast in shot: {(shot.characters || []).map((c) => { const e = elements.find((x) => x.name.toLowerCase() === c.toLowerCase()); return <span key={c} className={`chip ${e?.locked ? "ok" : e ? "warn" : "bad"}`}>{c}{e?.locked ? " · locked" : e ? " · not locked" : " · unknown"}</span>; })}</div>
    </>
  );
}

function KeyframePanel({ shot }) {
  const { project } = useProject();
  const { models } = useStudio();
  const { busy, run, patch, id } = useShotOps(shot);
  const [local, setLocal] = useState({ action: shot.action, camera: shot.camera, plates: shot.plates || [], keyframePrompt: shot.keyframePrompt || "", image: shot.models?.image || null });
  const [variants, setVariants] = useState(2);
  const saveMeta = () => patch({ action: local.action, camera: local.camera, plates: local.plates, keyframePrompt: local.keyframePrompt, models: { image: local.image } });
  const compose = () => run("compose", async () => { await saveMeta(); const s = await api.post(`/api/projects/${id}/shots/${shot.id}/keyframe-prompt`, {}); setLocal((l) => ({ ...l, keyframePrompt: s.keyframePrompt })); }, "Keyframe prompt composed from the bible + verbatim descriptions.");
  const gen = () => run("gen", async () => { await saveMeta(); return api.post(`/api/projects/${id}/shots/${shot.id}/keyframe`, { variants, model: local.image || undefined }); }, "Keyframe candidates generated. Click one to lock it.");
  const lockKf = (file) => run("lock", () => patch({ keyframe: file }), "Keyframe locked.");
  const imgModel = (models.image || []).find((m) => m.id === (local.image || project.defaults.imageModel));
  const per = imgModel?.pricing?.resolutions?.[project.defaults.resolution]?.usd;
  return (
    <div className="stack">
      <div className="card">
        <header><h2>{shot.id} · Keyframe</h2><span className="grow" /><span className="chip">{shot.type} · {shot.durationS}</span></header>
        <ShotMeta shot={shot} local={local} setLocal={setLocal} />
        <div className="row top"><ClaudeAction url={`/api/projects/${id}/shots/${shot.id}/keyframe-prompt`} label="Compose keyframe prompt" busy={busy === "compose"} onRun={compose} onApplied={async () => { const s = await api.get(`/api/projects/${id}/shots/${shot.id}`); setLocal((l) => ({ ...l, keyframePrompt: s.keyframePrompt })); }} /><Button className="ghost sm" busy={busy === "save"} onClick={() => run("save", saveMeta, "Saved")}>Save</Button></div>
        <ImproveField label="Keyframe (still image) prompt" kind="image" rows={6} value={local.keyframePrompt} onChange={(v) => setLocal({ ...local, keyframePrompt: v })} context={`Shot ${shot.id}: ${shot.type}, ${shot.camera}. ${shot.action}`} hint="World seed + plate + verbatim character descriptions + blocking + framing + lighting. Don't paraphrase the verbatim blocks." />
        <div className="row">
          <ModelPicker type="image" value={local.image} onChange={(v) => setLocal({ ...local, image: v })} allowEmpty small filter={(m) => !/bg-remover|upscal|edit/.test(m.id)} />
          <select style={{ width: 110 }} value={variants} onChange={(e) => setVariants(Number(e.target.value))}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} variant{n > 1 ? "s" : ""}</option>)}</select>
          <Button className="primary" busy={busy === "gen"} onClick={gen} disabled={!local.keyframePrompt}>Generate{per ? ` (≈${money(per * variants)})` : ""}</Button>
          <ImportButton label="Import my own still ($0)" accept="image/*" onFile={async (f) => { await run("import", async () => api.post(`/api/projects/${id}/shots/${shot.id}/import`, { kind: "keyframe", name: f.name, data: await fileToBase64(f) }), "Imported and locked as the keyframe."); }} />
        </div>
      </div>
      <div className="card">
        <h3>Candidates — click to lock</h3>
        {shot.keyframes?.length ? <div className="thumbs" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>{shot.keyframes.map((k) => <Thumb key={k.file} wide src={media(id, k.file)} selected={shot.keyframe === k.file} onClick={() => lockKf(k.file)} caption={k.model} />)}</div> : <p className="dim small">None yet.</p>}
      </div>
    </div>
  );
}

function RenderPanel({ shot }) {
  const { project, jobs, elements } = useProject();
  const { models, billing } = useStudio();
  const { busy, run, patch, id } = useShotOps(shot);
  const [local, setLocal] = useState({ action: shot.action, camera: shot.camera, plates: shot.plates || [], videoPrompt: shot.videoPrompt || "", video: shot.models?.video || null, duration: shot.durationS, resolution: project.defaults.videoResolution });
  const [quote, setQuote] = useState(null);
  const vm = (models.video || []).find((m) => m.id === (local.video || project.defaults.videoModel));
  const c = vm?.constraints || {};
  const durations = (c.durations || []).filter((d) => /^\d+s$/.test(d));
  const saveMeta = () => patch({ action: local.action, camera: local.camera, plates: local.plates, videoPrompt: local.videoPrompt, durationS: local.duration, models: { video: local.video || project.defaults.videoModel } });
  const compose = () => run("compose", async () => { await saveMeta(); const s = await api.post(`/api/projects/${id}/shots/${shot.id}/video-prompt`, {}); setLocal((l) => ({ ...l, videoPrompt: s.videoPrompt })); }, "Video prompt composed.");
  const getQuote = () => run("quote", async () => { await saveMeta(); const q = await api.post(`/api/projects/${id}/shots/${shot.id}/quote`, { resolution: local.resolution }); setQuote(q); if (q.error) throw new Error(q.error); });
  const render = () => run("render", async () => { await saveMeta(); setQuote(null); return api.post(`/api/projects/${id}/shots/${shot.id}/render`, { resolution: local.resolution }); }, "Queued. Watch the Renders tray — the clip lands here when done.");
  const reroll = () => run("reroll", () => api.post(`/api/projects/${id}/shots/${shot.id}/reroll`, {}), "Re-rolling with the identical prompt, model and references.");
  const job = jobs?.find((j) => j.id === shot.jobId);
  const active = job && (job.status === "PENDING" || job.status === "PROCESSING");
  const price = quote?.quote?.price ?? quote?.quote?.usd ?? quote?.quote?.cost ?? (typeof quote?.quote === "number" ? quote.quote : null);
  const isR2V = /reference-to-video/.test(vm?.id || "");
  const castLocked = (shot.characters || []).map((n) => elements.find((e) => e.name.toLowerCase() === n.toLowerCase())).filter((e) => e?.angles?.frontal).length;
  return (
    <div className="stack">
      <div className="card">
        <header><h2>{shot.id} · Render</h2><span className="grow" />{shot.keyframe ? <span className="chip ok">keyframe locked</span> : <span className="chip warn">no keyframe</span>}</header>
        <div className="grid2">
          <div>{shot.keyframe ? <Thumb wide src={media(id, shot.keyframe)} caption="start frame" /> : <Empty wide>Lock a keyframe in step 6 (recommended, not required)</Empty>}</div>
          <div className="stack">
            <ModelPicker label="Video model" type="video" value={local.video} onChange={(v) => setLocal({ ...local, video: v })} allowEmpty filter={(m) => !/upscale|motion-control/.test(m.id)} />
            <div className="grid2">
              <div className="field"><label>Duration</label><select value={local.duration} onChange={(e) => setLocal({ ...local, duration: e.target.value })}>{(durations.length ? durations : [local.duration]).map((d) => <option key={d}>{d}</option>)}</select></div>
              <div className="field"><label>Resolution</label><select value={local.resolution} onChange={(e) => setLocal({ ...local, resolution: e.target.value })}>{(c.resolutions?.length ? c.resolutions : [local.resolution]).map((d) => <option key={d}>{d}</option>)}</select></div>
            </div>
            <div className="row small">
              {isR2V ? <span className="chip ok">reference-to-video · {castLocked} character ref(s) as @Element</span> : <span className="chip warn">not reference-to-video — identity carried by keyframe only</span>}
              {c.audio ? <span className="chip info">generates audio</span> : null}
            </div>
          </div>
        </div>
        <ShotMeta shot={shot} local={local} setLocal={setLocal} />
        <div className="row top"><ClaudeAction url={`/api/projects/${id}/shots/${shot.id}/video-prompt`} label="Compose video prompt" busy={busy === "compose"} onRun={compose} onApplied={async () => { const s = await api.get(`/api/projects/${id}/shots/${shot.id}`); setLocal((l) => ({ ...l, videoPrompt: s.videoPrompt })); }} /><span className="dim small">Tip: paste this prompt into Sora / Veo in your subscription, then import the clip below.</span></div>
        <ImproveField label="Video prompt" kind="video" rows={6} value={local.videoPrompt} onChange={(v) => setLocal({ ...local, videoPrompt: v })} context={`Shot ${shot.id}: ${shot.type}, ${shot.camera}, ${local.duration}. Model ${vm?.id || ""}.`} hint="[subject @Element] + one motion + environment (@Image1) + one camera instruction + lighting. 50–150 words. Duration in parentheses." />
        <div className="row">
          <Button busy={busy === "quote"} onClick={getQuote} disabled={!local.videoPrompt}>Get quote</Button>
          {quote?.quote ? <span className="chip accent">{price != null ? money(price) : JSON.stringify(quote.quote)} {billing && price != null && price > billing.usd ? " — exceeds balance!" : ""}</span> : null}
          {quote?.refs ? <span className="dim small">{quote.refs.elements.length} element(s), {quote.refs.plates.length} plate(s){quote.refs.keyframe ? ", keyframe" : ""}</span> : null}
          <span className="grow" />
          <Button className="primary" busy={busy === "render"} onClick={render} disabled={!local.videoPrompt || active}>{active ? "Rendering…" : "Queue render"}</Button>
          {shot.provenance?.length ? <Button className="sm" busy={busy === "reroll"} onClick={reroll} disabled={active}>Re-roll last</Button> : null}
          <ImportButton label="Import my own clip ($0)" accept="video/*" onFile={async (f) => { await run("import", async () => api.post(`/api/projects/${id}/shots/${shot.id}/import`, { kind: "clip", name: f.name, data: await fileToBase64(f) }), "Clip imported and selected for this shot."); }} />
        </div>
        {job ? <div className="dim small">Job {job.id}: {job.status}{job.eta ? ` · ~${Math.round(job.eta / 1000)}s typical` : ""}{job.error ? ` · ${job.error}` : ""}</div> : null}
      </div>
      <div className="card">
        <h3>Clips</h3>
        {shot.clips?.filter((c) => c.file).length ? <div className="thumbs" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>{shot.clips.filter((c) => c.file).map((c) => <Thumb key={c.jobId} wide video src={media(id, c.file)} selected={shot.clip === c.file} caption={c.file.split("/").pop()} onClick={() => run("pick", () => patch({ clip: c.file }), "Selected as the shot's clip.")} />)}</div> : <p className="dim small">No clips yet.</p>}
      </div>
    </div>
  );
}

function DialoguePanel({ shot }) {
  const { script, elements } = useProject();
  const { busy, run, id } = useShotOps(shot);
  const scene = script?.scenes?.find((s) => s.id === shot.sceneId);
  const lines = (shot.dialogueLines || []).map((i) => ({ i, ...(scene?.dialogue?.[i] || {}) })).filter((l) => l.line);
  const gen = (l) => run("line-" + l.i, () => api.post(`/api/projects/${id}/tts/line`, { shotId: shot.id, lineIndex: l.i, character: l.character, text: l.line }), `Rendered line ${l.i}.`);
  const all = () => run("all", async () => { for (const l of lines) await api.post(`/api/projects/${id}/tts/line`, { shotId: shot.id, lineIndex: l.i, character: l.character, text: l.line }); }, "All lines rendered.");
  return (
    <div className="card">
      <header><h2>{shot.id} · Dialogue</h2><span className="grow" /><Button className="primary sm" busy={busy === "all"} onClick={all} disabled={!lines.length}>Render all lines</Button></header>
      {!lines.length ? <p className="dim">No dialogue lines are assigned to this shot.</p> : (
        <table><thead><tr><th>#</th><th>Character</th><th>Line</th><th style={{ width: 300 }}>Audio</th></tr></thead>
          <tbody>{lines.map((l) => { const done = (shot.lines || []).find((x) => x.lineIndex === l.i); const el = elements.find((e) => e.name.toLowerCase() === (l.character || "").toLowerCase()); return (
            <tr key={l.i}><td className="mono dim">{l.i}</td><td>{l.character}<div className="dim small">{el?.voice?.vvId ? "cloned" : el?.voice?.voice || <span style={{ color: "var(--danger)" }}>no voice</span>}</div></td><td>{l.line}<div className="dim small">{l.direction}</div></td>
              <td><div className="row">{done ? <audio controls src={media(id, done.file)} style={{ height: 32, width: 200 }} /> : null}<Button className="xs" busy={busy === "line-" + l.i} onClick={() => gen(l)}>{done ? "Redo" : "Render"}</Button></div></td></tr>); })}</tbody></table>
      )}
    </div>
  );
}

function BatchRender() {
  const { id, shots, reload } = useProject();
  const { toast } = useStudio();
  const [busy, setBusy] = useState(false);
  const pending = shots.filter((s) => s.videoPrompt && !s.clip && !s.jobId);
  const go = async () => {
    if (!confirm(`Queue ${pending.length} shot(s)? Each is billed by Venice at its quoted price.`)) return;
    setBusy(true);
    try { for (const s of pending) await api.post(`/api/projects/${id}/shots/${s.id}/render`, {}); await reload(); toast(`Queued ${pending.length} render(s).`, "ok"); }
    catch (e) { toast(e.message, "error"); } finally { setBusy(false); }
  };
  return <Button busy={busy} onClick={go} disabled={!pending.length}>Queue all ready shots ({pending.length})</Button>;
}
