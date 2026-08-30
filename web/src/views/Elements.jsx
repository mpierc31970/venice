import React, { useEffect, useMemo, useRef, useState } from "react";
import { Routes, Route, useNavigate, useParams, Link } from "react-router-dom";
import { api, media, fileToBase64 } from "../lib/api.js";
import { useProject, useStudio } from "../lib/store.jsx";
import { Button, ImproveField, ModelPicker, StepHead, Thumb, Empty, money } from "../components/ui.jsx";
import { ClaudeAction, ImportButton } from "../components/manual.jsx";

const ANGLES = [["frontal", "Frontal"], ["q45", "45°"], ["profile", "Profile"], ["rear", "¾ rear"]];
const LOC_ANGLES = [["frontal", "Establishing"], ["q45", "45° left"], ["profile", "Cross view"], ["rear", "Reverse"]];
const QA = [["silhouette", "Form & silhouette"], ["wardrobe", "Material & wardrobe"], ["features", "Fingerprint features present"], ["style", "Style coherent"], ["scale", "Scale correct"]];

export default function Elements() {
  return (
    <Routes>
      <Route index element={<ElementList />} />
      <Route path="bakeoff" element={<Bakeoff />} />
      <Route path=":slug" element={<ElementEditor />} />
    </Routes>
  );
}

function ElementList() {
  const { id, elements, reload } = useProject();
  const { toast } = useStudio();
  const nav = useNavigate();
  const [name, setName] = useState(""); const [type, setType] = useState("character");
  const chars = elements.filter((e) => e.type === "character");
  const add = async () => { try { const e = await api.post(`/api/projects/${id}/elements`, { name, type }); await reload(); nav(e.slug); } catch (e) { toast(e.message, "error"); } };
  return (
    <div className="page">
      <StepHead stepKey="elements" checklist={[
        { done: chars.length > 0, label: "At least one character", hint: "create from the bible in step 2, or add below" },
        { done: chars.length > 0 && chars.every((c) => c.description), label: "Every character has a verbatim description" },
        { done: chars.length > 0 && chars.every((c) => c.angles?.frontal), label: "Every character has a chosen frontal reference" },
        { done: chars.length > 0 && chars.every((c) => c.locked), label: "Every character is QA'd and locked" },
        { done: chars.length > 0 && chars.every((c) => c.voice?.voice || c.voice?.vvId), label: "Every character has a voice" },
      ]}>
        <Link className="btn" to="bakeoff">Image model bake-off</Link>
      </StepHead>
      <div className="card flush">
        <div className="list">
          {elements.map((e) => (
            <div key={e.slug} className="item" onClick={() => nav(e.slug)}>
              <div style={{ width: 44, height: 56, borderRadius: 6, overflow: "hidden", background: "var(--bg-3)", flex: "none" }}>{e.angles?.frontal ? <img src={media(id, e.angles.frontal.file)} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt="" /> : null}</div>
              <div className="grow"><div style={{ fontWeight: 500 }}>{e.name} <span className="dim small">· {e.type}</span></div><div className="dim small">{e.role || e.bio?.slice(0, 90) || "—"}</div></div>
              <div className="row">
                {e.description ? <span className="chip ok">described</span> : <span className="chip">no description</span>}
                {Object.keys(e.angles || {}).length ? <span className="chip info">{Object.keys(e.angles || {}).length}/4 {e.type === "presence" ? "states" : "angles"}</span> : null}
                {e.type === "character" ? (e.voice?.voice || e.voice?.vvId ? <span className="chip ok">voice</span> : <span className="chip">no voice</span>) : null}
                {e.locked ? <span className="chip accent">locked</span> : null}
              </div>
            </div>
          ))}
          {!elements.length ? <div className="item dim">No elements yet. Extract the cast in step 2, or add one below.</div> : null}
        </div>
      </div>
      <div className="card">
        <h3>Add an element</h3>
        <div className="row"><input className="grow" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} /><select style={{ width: 160 }} value={type} onChange={(e) => setType(e.target.value)}><option value="character">Character</option><option value="presence">Presence (non-human, no body)</option><option value="prop">Prop</option><option value="location">Location</option></select><Button className="primary" onClick={add} disabled={!name}>Add</Button></div>
      </div>
    </div>
  );
}

function ElementEditor() {
  const { slug } = useParams();
  const { id, project, elements, reload } = useProject();
  const { toast, models, refreshBilling } = useStudio();
  const nav = useNavigate();
  const initial = elements.find((e) => e.slug === slug);
  const [el, setEl] = useState(initial);
  const [busy, setBusy] = useState(null);
  const [boardCount, setBoardCount] = useState(4);
  const [imageModel, setImageModel] = useState(initial?.imageModel || null);
  const [preview, setPreview] = useState("");
  const audioRef = useRef(null);
  useEffect(() => { const e = elements.find((x) => x.slug === slug); if (e) { setEl(e); setImageModel(e.imageModel || null); } }, [elements, slug]);
  if (!el) return <div className="page"><p>Element not found. <Link to="..">Back</Link></p></div>;

  const call = async (key, fn, okMsg) => { setBusy(key); try { const r = await fn(); await reload(); refreshBilling(); if (okMsg) toast(okMsg, "ok"); return r; } catch (e) { toast(e.message, "error"); } finally { setBusy(null); } };
  const save = () => call("save", () => api.patch(`/api/projects/${id}/elements/${slug}`, { name: el.name, type: el.type, role: el.role, bio: el.bio, fingerprint: el.fingerprint, description: el.description, negatives: el.negatives, voiceHint: el.voiceHint, voice: el.voice, imageModel, states: el.states }), "Saved");
  const draft = () => call("draft", () => api.post(`/api/projects/${id}/elements/${slug}/draft`, {}), "Claude drafted the bio, fingerprint and verbatim description.");
  const board = () => call("board", async () => { await api.patch(`/api/projects/${id}/elements/${slug}`, { description: el.description, negatives: el.negatives }); return api.post(`/api/projects/${id}/elements/${slug}/board`, { count: boardCount, model: imageModel || undefined, seedMode: "random" }); }, `Generated ${boardCount} candidate(s). Pick the one face you'll anchor everything to.`);
  const pick = (file) => call("pick", () => api.post(`/api/projects/${id}/elements/${slug}/pick`, { file }), "Frontal chosen. Now derive the other three angles.");
  const angles = () => call("angles", async () => { const r = await api.post(`/api/projects/${id}/elements/${slug}/angles`, {}); if (r.errors?.length) toast(r.errors.map((e) => `${e.angle}: ${e.error}`).join("\n"), "error", 9000); return r; }, "Angles derived. Run the QA checklist on each.");
  const regenAngle = (a) => call("angle-" + a, () => api.post(`/api/projects/${id}/elements/${slug}/angles`, { angles: [a] }), `Regenerated ${a}.`);
  const qa = (angle, key, val) => { const checks = { ...(el.qa?.[angle]?.checks || {}), [key]: val }; return call("qa", async () => { const r = await api.put(`/api/projects/${id}/elements/${slug}/qa`, { angle, checks }); if (r.advice !== "OK") toast(r.advice, "info"); }); };
  const lock = (locked) => call("lock", () => api.post(`/api/projects/${id}/elements/${slug}/lock`, { locked }), locked ? `${el.name} locked. References are now used for every shot.` : "Unlocked.");
  const previewVoice = async () => {
    const model = el.voice?.model || project.defaults.ttsModel; const voice = el.voice?.vvId || el.voice?.voice;
    if (!voice) return toast("Pick a voice first", "info");
    setBusy("voice");
    try { const blob = await api.post(`/api/projects/${id}/tts/preview`, { model, voice, text: preview || `Hi, I'm ${el.name}. ${el.bio?.split(".")[0] || "This is my voice."}.` }); const url = URL.createObjectURL(blob); audioRef.current.src = url; audioRef.current.play(); refreshBilling(); }
    catch (e) { toast(e.message, "error"); } finally { setBusy(null); }
  };
  const clone = async (file) => { if (!file) return; setBusy("clone"); try { const data = await fileToBase64(file); const r = await api.post(`/api/projects/${id}/tts/clone`, { slug, name: el.name, data, filename: file.name, model: el.voice?.model || project.defaults.ttsModel }); await reload(); toast(`Cloned voice: ${r.element.voice.vvId || "(see console)"}`, "ok"); } catch (e) { toast(e.message, "error"); } finally { setBusy(null); } };

  const ttsModel = (models.tts || []).find((m) => m.id === (el.voice?.model || project.defaults.ttsModel));
  const isPresence = el.type === "presence";
  const isLocation = el.type === "location";
  const SLOTS = isPresence ? (el.states || []).map((s, i) => [i === 0 ? "frontal" : s.key, s.name]) : isLocation ? LOC_ANGLES : ANGLES;
  const anglesDone = SLOTS.filter(([a]) => el.angles?.[a]).length;
  const qaPassed = SLOTS.filter(([a]) => el.qa?.[a]?.verdict === "pass").length;
  const isChar = el.type === "character" || isPresence;
  const wideRef = el.type === "location" || isPresence;
  const imgModel = (models.image || []).find((m) => m.id === (imageModel || project.defaults.imageModel));
  const perImage = imgModel?.pricing?.resolutions?.[project.defaults.resolution]?.usd ?? imgModel?.pricing?.usd ?? null;

  return (
    <div className="page">
      <div className="row"><Link to=".." className="btn ghost sm">← All elements</Link><h1 className="grow">{el.name} <span className="dim" style={{ fontWeight: 400 }}>· {el.type}</span></h1>{el.locked ? <span className="chip accent">locked</span> : null}</div>

      <div className="card">
        <header><h2>A · Identity on paper</h2><span className="grow" /><ClaudeAction url={`/api/projects/${id}/elements/${slug}/draft`} label="Draft with Claude" busy={busy === "draft"} onRun={draft} onApplied={reload} small /></header>
        <div className="grid2">
          <div className="field"><label>Name</label><input value={el.name} onChange={(e) => setEl({ ...el, name: e.target.value })} /></div>
          <div className="field"><label>Role</label><input value={el.role || ""} onChange={(e) => setEl({ ...el, role: e.target.value })} /></div>
        </div>
        <div className="field" style={{ maxWidth: 320 }}><label>Type</label><select value={el.type} onChange={(e) => setEl({ ...el, type: e.target.value })}><option value="character">Character</option><option value="presence">Presence (non-human, no body)</option><option value="prop">Prop</option><option value="location">Location</option></select></div>
        <ImproveField label={isPresence ? "What it is and what it wants" : isChar ? "Biography" : "Purpose & history"} kind="bio" rows={3} value={el.bio} onChange={(v) => setEl({ ...el, bio: v })} />
        <div className="field"><label>{isPresence ? "Behaviour rules — 3–5 never-drift rules of how it manifests (one per line)" : "Identity fingerprint — 3–5 never-drift features (one per line)"}</label><textarea rows={3} value={(el.fingerprint || []).join("\n")} onChange={(e) => setEl({ ...el, fingerprint: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })} placeholder={"brass compass on a leather cord\nleft eyebrow scar\nclose-cropped grey hair"} /></div>
        <ImproveField label={isPresence ? "Verbatim manifestation — baseline state (pasted unchanged into every prompt)" : "Verbatim description (pasted unchanged into every prompt)"} kind="description" rows={5} value={el.description} onChange={(v) => setEl({ ...el, description: v })} hint="The model treats 'red jacket' and 'crimson coat' as different subjects. Lock this wording and never retype it." />
        {isPresence ? (
          <div className="field"><label>States — 4, from baseline to most intense (Claude drafts them from the bible)</label>
            <div className="stack">
              {(el.states || []).map((s, i) => (
                <div className="row top" key={i}>
                  <input style={{ width: 160 }} value={s.name} placeholder="name" onChange={(e) => setEl({ ...el, states: el.states.map((x, j) => (j === i ? { ...x, name: e.target.value, key: x.key || e.target.value } : x)) })} />
                  <textarea className="grow" rows={2} value={s.description} placeholder="what changes from baseline" onChange={(e) => setEl({ ...el, states: el.states.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} />
                </div>
              ))}
              {(el.states || []).length < 4 ? <Button className="ghost xs" onClick={() => setEl({ ...el, states: [...(el.states || []), { key: "", name: "", description: "" }] })}>+ state</Button> : null}
            </div>
          </div>
        ) : null}
        <ImproveField label="Element negatives (comma-separated)" kind="generic" single value={el.negatives} onChange={(v) => setEl({ ...el, negatives: v })} />
        <div className="row"><Button className="primary" busy={busy === "save"} onClick={save}>Save</Button></div>
      </div>

      <div className="card">
        <header><h2>{isPresence ? "B · Manifestation board → one baseline plate" : isLocation ? "B · Establishing plates → one winning plate" : "B · Identity board → one winning face"}</h2><span className="grow" /><span className="dim small">{perImage != null ? `≈ ${money(perImage)} / image` : ""}</span></header>
        <p className="muted">{isPresence ? "Generate baseline-state plates of the manifestation (no people). Pick ONE; every other state is derived from it so the environment stays identical." : "Generate frontal candidates with the verbatim description. Pick ONE. Everything downstream anchors to it. (Don't generate pretty world shots first — you'll fall for off-canon faces.)"}</p>
        <div className="row">
          <ModelPicker type="image" value={imageModel} onChange={setImageModel} allowEmpty small filter={(m) => !/bg-remover|upscal|edit/.test(m.id)} />
          <select style={{ width: 120 }} value={boardCount} onChange={(e) => setBoardCount(Number(e.target.value))}>{[1, 2, 4, 6, 8, 12].map((n) => <option key={n} value={n}>{n} image{n > 1 ? "s" : ""}</option>)}</select>
          <Button className="primary" busy={busy === "board"} onClick={board} disabled={!el.description || (isPresence && !(el.states || []).length)}>Generate candidates{perImage != null ? ` (≈${money(perImage * boardCount)})` : ""}</Button>
          <ImportButton label="Import my own image ($0)" accept="image/*" onFile={async (f) => { await call("import", async () => api.post(`/api/projects/${id}/elements/${slug}/import`, { name: f.name, data: await fileToBase64(f) }), "Added to the board — click it to make it the frontal."); }} />
        </div>
        {el.board?.length ? (
          <div className="thumbs">
            {el.board.map((b) => <Thumb key={b.file} src={media(id, b.file)} selected={el.angles?.frontal?.file === b.file} onClick={() => pick(b.file)} caption={`seed ${b.seed}`} wide={wideRef} />)}
          </div>
        ) : <p className="dim small">No candidates yet.</p>}
      </div>

      <div className="card">
        <header><h2>{isPresence ? "C · Four locked states" : isLocation ? "C · Four locked camera positions" : "C · Four locked angles"}</h2><span className="grow" /><span className="chip">{anglesDone}/{SLOTS.length || 4} {isPresence ? "states" : "angles"} · {qaPassed} QA passed</span></header>
        <p className="muted">{isPresence ? "Each state is derived from the baseline plate with the identical manifestation text — only the state clause changes. Score each; fail 2+ checks → regenerate that state." : isLocation ? "Each camera position is re-shot from the identical description (no people), seeded from the establishing plate and using it as a style reference. Score each; fail 2+ checks → regenerate that position." : "Derived from the winning frontal with the identical description — only the angle instruction changes. Score each: fail 2+ checks → regenerate that angle; 3+ angles failing → go back to B."}</p>
        <div className="row"><Button className="primary" busy={busy === "angles"} onClick={angles} disabled={!el.angles?.frontal}>{isPresence ? "Derive the other states" : isLocation ? "Shoot 45° / cross / reverse" : "Derive 45° / profile / ¾ rear"}</Button><span className="dim small">{isLocation ? `image model: ${imageModel || project.defaults.imageModel}` : `edit model: ${project.defaults.editModel}`}</span></div>
        <div className="angles">
          {SLOTS.map(([a, label]) => {
            const ang = el.angles?.[a]; const q = el.qa?.[a];
            return (
              <div className="slot" key={a}>
                <div className="name">{label}</div>
                {ang ? <Thumb src={media(id, ang.file)} wide={wideRef} /> : <Empty wide={wideRef}><span>{a === "frontal" ? "pick from the board" : "not derived yet"}<br /><ImportButton className="xs ghost" label="Import" accept="image/*" onFile={async (f) => { await call("import-" + a, async () => api.post(`/api/projects/${id}/elements/${slug}/import`, { name: f.name, data: await fileToBase64(f), angle: a }), `Imported ${label}.`); }} /></span></Empty>}
                {ang ? (
                  <div className="stack" style={{ gap: 4 }}>
                    {QA.map(([k, lbl]) => <label key={k} style={{ display: "flex", gap: 6, alignItems: "center", margin: 0, fontSize: 11.5 }}><input type="checkbox" style={{ width: "auto" }} checked={q?.checks?.[k] === true} onChange={(e) => qa(a, k, e.target.checked)} />{lbl}</label>)}
                    {q ? <span className={`chip ${q.verdict === "pass" ? "ok" : "warn"}`} style={{ alignSelf: "flex-start" }}>{q.verdict === "pass" ? `pass (${q.fails} fail)` : "regenerate"}</span> : null}
                    {a !== "frontal" ? <Button className="xs" busy={busy === "angle-" + a} onClick={() => regenAngle(a)}>Regenerate</Button> : null}
                    <ImportButton className="xs ghost" label="Import" accept="image/*" onFile={async (f) => { await call("import-" + a, async () => api.post(`/api/projects/${id}/elements/${slug}/import`, { name: f.name, data: await fileToBase64(f), angle: a }), `Imported ${label}.`); }} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="row">
          {el.locked ? <Button className="sm" busy={busy === "lock"} onClick={() => lock(false)}>Unlock</Button> : <Button className="primary" busy={busy === "lock"} onClick={() => lock(true)} disabled={!el.angles?.frontal}>Lock {el.name} {anglesDone < SLOTS.length ? `(only ${anglesDone}/${SLOTS.length} — allowed, but consistency suffers)` : ""}</Button>}
        </div>
      </div>

      {isChar ? (
        <div className="card">
          <header><h2>D · Voice{isPresence ? " (optional — only if it ever speaks)" : ""}</h2><span className="grow" /><span className="dim small">{el.voiceHint}</span></header>
          <div className="grid2">
            <ModelPicker label="TTS model" type="tts" value={el.voice?.model || project.defaults.ttsModel} onChange={(v) => setEl({ ...el, voice: { ...el.voice, model: v, voice: null } })} />
            <div className="field"><label>Voice</label>
              <select value={el.voice?.vvId ? "__clone__" : el.voice?.voice || ""} onChange={(e) => setEl({ ...el, voice: { ...el.voice, voice: e.target.value === "__clone__" ? el.voice.voice : e.target.value, vvId: e.target.value === "__clone__" ? el.voice.vvId : null } })}>
                <option value="">— choose —</option>
                {el.voice?.vvId ? <option value="__clone__">Cloned voice ({el.voice.vvId})</option> : null}
                {(ttsModel?.voices || []).map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
          </div>
          <div className="row">
            <input className="grow" placeholder="Preview line (optional)" value={preview} onChange={(e) => setPreview(e.target.value)} />
            <Button busy={busy === "voice"} onClick={previewVoice}>▶ Preview</Button>
            <Button className="primary sm" busy={busy === "save"} onClick={save}>Save voice</Button>
          </div>
          <audio ref={audioRef} controls style={{ width: "100%" }} />
          {ttsModel?.voiceCloning || ttsModel?.supportsCustomVoiceId ? (
            <div className="row"><label className="btn sm" style={{ margin: 0 }}>Clone from sample… <input type="file" accept="audio/*" style={{ display: "none" }} onChange={(e) => clone(e.target.files?.[0])} /></label><span className="dim small">{ttsModel.voiceCloning ? `${ttsModel.voiceCloning.mode}, ≥${ttsModel.voiceCloning.min_sample_seconds}s sample, handle expires in ${ttsModel.voiceCloning.retention_days} days (sample is kept locally).` : "This model accepts custom voice IDs."}</span></div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Bakeoff() {
  const { id, project, patchProject, reload } = useProject();
  const { models, toast, refreshBilling } = useStudio();
  const [prompt, setPrompt] = useState("A lone figure on a rain-slick pier at dusk, lantern in hand, sea fog rolling in.");
  const [sel, setSel] = useState(["nano-banana-pro", "flux-2-max", "seedream-v5-pro", "qwen-image-3-pro", "gpt-image-2"]);
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`/api/projects/${id}/elements/bakeoff/last`).then((r) => r && setResults(r.results)).catch(() => {}); }, [id]);
  const list = (models.image || []).filter((m) => !/bg-remover|upscal|edit/.test(m.id));
  const run = async () => { setBusy(true); try { setResults(await api.post(`/api/projects/${id}/elements/bakeoff`, { prompt, models: sel })); refreshBilling(); } catch (e) { toast(e.message, "error"); } finally { setBusy(false); } };
  const choose = async (m) => { await patchProject({ defaults: { imageModel: m } }); await reload(); toast(`${m} is now the project's image model.`, "ok"); };
  const est = sel.reduce((s, idm) => s + (list.find((m) => m.id === idm)?.pricing?.resolutions?.[project.defaults.resolution]?.usd || 0), 0);
  return (
    <div className="page">
      <div className="row"><Link to=".." className="btn ghost sm">← Elements</Link><h1>Image model bake-off</h1></div>
      <div className="card">
        <p className="muted">Pick your image model by taste, not spec sheets: one identical prompt (with your world seed prepended) across several models. Choose the winner and it becomes the project default.</p>
        <ImproveField label="Test prompt" kind="image" rows={2} value={prompt} onChange={setPrompt} />
        <div className="row" style={{ gap: 6 }}>
          {list.map((m) => <label key={m.id} className={`chip ${sel.includes(m.id) ? "accent" : ""}`} style={{ cursor: "pointer" }}><input type="checkbox" style={{ display: "none" }} checked={sel.includes(m.id)} onChange={(e) => setSel(e.target.checked ? [...sel, m.id] : sel.filter((x) => x !== m.id))} />{m.id}</label>)}
        </div>
        <div className="row"><Button className="primary" busy={busy} onClick={run} disabled={!sel.length}>Run bake-off ({sel.length} models{est ? `, ≈${money(est)}` : ""})</Button></div>
      </div>
      {results ? (
        <div className="thumbs" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
          {results.map((r) => r.file ? (
            <div key={r.model} className="stack">
              <Thumb wide src={media(id, r.file)} caption={r.model} selected={project.defaults.imageModel === r.model} onClick={() => choose(r.model)} />
              <Button className="sm" onClick={() => choose(r.model)}>{project.defaults.imageModel === r.model ? "✓ Project default" : "Use this model"}</Button>
            </div>
          ) : <div key={r.model} className="empty wide">{r.model}<br />{r.error}</div>)}
        </div>
      ) : null}
    </div>
  );
}
