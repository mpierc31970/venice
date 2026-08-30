import React, { useEffect, useRef, useState } from "react";
import { api, stream } from "../lib/api.js";
import { useProject, useStudio } from "../lib/store.jsx";
import { Button, ImproveField, ModelPicker, StepHead } from "../components/ui.jsx";

const SECTIONS = ["Pitch", "World", "Locations", "Cast", "Aesthetic", "Hard negatives", "Official world seed", "Canon"];

export default function Bible() {
  const { id, project, bible, reload, elements } = useProject();
  const { toast, refreshBilling } = useStudio();
  const [text, setText] = useState(bible?.bible || "");
  const [seed, setSeed] = useState(bible?.worldSeed || "");
  const [notes, setNotes] = useState("");
  const [model, setModel] = useState(null);
  const [busy, setBusy] = useState(null); // "gen" | "extract" | "save" | section name
  const [dirty, setDirty] = useState(false);
  const [secInstr, setSecInstr] = useState({});
  const ref = useRef(null);
  useEffect(() => { setText(bible?.bible || ""); setSeed(bible?.worldSeed || ""); setDirty(false); }, [bible]);

  const generate = async () => {
    if (text && !confirm("Replace the current bible with a fresh one?")) return;
    setBusy("gen"); setText("");
    try {
      await stream(`/api/projects/${id}/bible/generate`, { notes, model: model || undefined }, (_d, full) => { setText(full); ref.current?.scrollTo(0, ref.current.scrollHeight); });
      toast("Bible written. Next: extract the world seed.", "ok"); await reload(); refreshBilling();
    } catch (e) { toast(e.message, "error"); } finally { setBusy(null); }
  };
  const save = async () => { setBusy("save"); try { await api.put(`/api/projects/${id}/bible`, { bible: text, worldSeed: seed }); setDirty(false); await reload(); toast("Saved", "ok"); } catch (e) { toast(e.message, "error"); } finally { setBusy(null); } };
  const extract = async () => {
    setBusy("extract");
    try { if (dirty) await api.put(`/api/projects/${id}/bible`, { bible: text }); const r = await api.post(`/api/projects/${id}/bible/extract`, { model: model || undefined }); setSeed(r.worldSeed || ""); await reload(); toast(`Extracted world seed, ${r.cast?.length || 0} characters, ${r.locations?.length || 0} locations.`, "ok"); refreshBilling(); }
    catch (e) { toast(e.message, "error"); } finally { setBusy(null); }
  };
  const createElements = async () => {
    setBusy("elements");
    try { const r = await api.post(`/api/projects/${id}/bible/create-elements`, {}); await reload(); toast(r.created.length ? `Created ${r.created.length} element(s).` : "All cast and locations already exist.", "ok"); }
    catch (e) { toast(e.message, "error"); } finally { setBusy(null); }
  };
  const rewriteSection = async (heading) => {
    setBusy(heading);
    try {
      const out = await stream(`/api/projects/${id}/bible/section`, { heading, instructions: secInstr[heading] || "", model: model || undefined });
      setText((t) => spliceSection(t, heading, out)); setDirty(true); toast(`Rewrote "${heading}". Save, then re-extract if the world seed or cast changed.`, "ok");
    } catch (e) { toast(e.message, "error"); } finally { setBusy(null); }
  };

  const ex = bible?.extracted;
  return (
    <div className="page">
      <StepHead stepKey="bible" checklist={[
        { done: !!text.trim(), label: "Bible written (Claude drafts it from your logline; edit freely)" },
        { done: !!seed.trim(), label: "World seed extracted", hint: "the block prepended to every image and video prompt" },
        { done: (elements || []).length > 0, label: "Cast & locations turned into elements", hint: "so step 3 can lock their references" },
      ]}>
        <div className="row"><ModelPicker type="text" value={model} onChange={setModel} allowEmpty small /></div>
      </StepHead>

      <div className="card">
        <header><h2>1 · Write the bible with Claude</h2><span className="grow" /><span className="chip">{project.defaults.textModel}</span></header>
        <ImproveField label="Creator notes (optional)" kind="generic" rows={3} value={notes} onChange={setNotes} placeholder="Tone, era, references, must-haves, must-nots, number of characters…" />
        <div className="row"><Button className="claude" busy={busy === "gen"} onClick={generate}>✦ {text ? "Regenerate whole bible" : "Write the bible"}</Button><span className="dim small">Logline: {project.logline || "(set it in step 1)"}</span></div>
      </div>

      <div className="card">
        <header><h2>2 · Review & edit</h2><span className="grow" />{dirty ? <span className="chip warn">unsaved</span> : null}<Button className="sm" busy={busy === "save"} onClick={save} disabled={!dirty}>Save</Button></header>
        <textarea ref={ref} className="mono" rows={26} value={text} onChange={(e) => { setText(e.target.value); setDirty(true); }} placeholder="Your story bible appears here as Claude writes it…" />
        <details>
          <summary className="muted" style={{ cursor: "pointer" }}>Rewrite one section with Claude</summary>
          <div className="stack" style={{ marginTop: 10 }}>
            {SECTIONS.map((h) => (
              <div className="row" key={h}>
                <span style={{ width: 160 }} className="mono small">{h}</span>
                <input className="grow" placeholder="Instructions (optional): e.g. make the palette colder, add a rival" value={secInstr[h] || ""} onChange={(e) => setSecInstr({ ...secInstr, [h]: e.target.value })} />
                <Button className="claude xs" busy={busy === h} onClick={() => rewriteSection(h)} disabled={!text}>✦ Rewrite</Button>
              </div>
            ))}
          </div>
        </details>
      </div>

      <div className="card">
        <header><h2>3 · Extract the canon</h2><span className="grow" /><Button className="claude" busy={busy === "extract"} onClick={extract} disabled={!text.trim()}>✦ Extract world seed & cast</Button></header>
        <p className="muted">Claude pulls the official world seed, hard negatives, palette and cast into structured data. The world seed below is what every prompt starts with — tune it here.</p>
        <ImproveField label="Official world seed" kind="image" rows={5} value={seed} onChange={(v) => { setSeed(v); setDirty(true); }} hint="60–120 words: style, palette, era, lighting, render canon, mood. No character names." />
        {ex ? (
          <div className="grid2">
            <div><h4>Cast</h4><ul className="muted small" style={{ margin: "6px 0 0", paddingLeft: 18 }}>{(ex.cast || []).map((c) => <li key={c.name}><b>{c.name}</b> — {c.role}</li>)}</ul></div>
            <div><h4>Locations</h4><ul className="muted small" style={{ margin: "6px 0 0", paddingLeft: 18 }}>{(ex.locations || []).map((l) => <li key={l.name}>{l.name}</li>)}</ul></div>
            <div><h4>Palette</h4><div className="row" style={{ marginTop: 6 }}>{Object.entries(ex.palette || {}).map(([k, v]) => <span key={k} className="chip"><i style={{ width: 12, height: 12, borderRadius: 3, background: v, display: "inline-block" }} />{v}</span>)}</div></div>
            <div><h4>Prohibitions</h4><div className="row" style={{ marginTop: 6 }}>{(ex.prohibitions || []).map((p, i) => <span key={i} className="chip bad">{p}</span>)}</div></div>
          </div>
        ) : null}
        <div className="row"><Button className="primary" busy={busy === "elements"} onClick={createElements} disabled={!ex}>Create elements from cast & locations</Button><span className="dim small">Existing elements are never overwritten.</span></div>
      </div>
    </div>
  );
}

function spliceSection(text, heading, replacement) {
  const re = new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*\\n[\\s\\S]*?(?=^## |(?![\\s\\S]))`, "m");
  const clean = replacement.trim().replace(/\n?$/, "\n\n");
  return re.test(text) ? text.replace(re, clean) : text + "\n\n" + clean;
}
