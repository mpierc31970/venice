// The talking-head batch renderer — the whole app, on one page.
//
// Reading order matches the order of operations: the two reference images the run
// depends on, then the sheet, then the settings, then the sections. Above all of it
// the budget line, because "how far does the balance reach" is the only question that
// has to be answered before pressing Run.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api, media, fileToBase64 } from "../lib/api.js";
import { useStudio } from "../lib/store.jsx";
import { Button, Thumb, Empty, money, ImportButton, Spinner } from "../components/ui.jsx";

const STATUS = {
  pending:   { label: "pending",   color: "var(--ink-3)" },
  rendering: { label: "rendering", color: "var(--accent)" },
  rendered:  { label: "rendered",  color: "var(--ok)" },
  uploaded:  { label: "uploaded",  color: "var(--ok)" },
  complete:  { label: "complete",  color: "var(--ok)" },
  failed:    { label: "failed",    color: "var(--danger)" },
  skipped:   { label: "skipped",   color: "var(--ink-3)" },
};

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

export default function Batch({ id }) {
  const { toast, refreshBilling } = useStudio();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);
  const [preview, setPreview] = useState(null);

  const load = useCallback(async () => {
    try { setData(await api.get(`/api/projects/${id}/batch`)); }
    catch (e) { toast(e.message, "error"); }
  }, [id, toast]);
  useEffect(() => { load(); }, [load]);

  // Poll only while a run is live. Depend on the boolean, not on `data`: every poll
  // replaces the object, which would tear down and rebuild the timer on each tick.
  const running = !!data?.run?.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [running, load]);

  const run = (name, fn, okMsg) => async () => {
    setBusy(name);
    try { const r = await fn(); if (okMsg) toast(okMsg, "ok"); await load(); refreshBilling(); return r; }
    catch (e) { toast(e.message, "error"); }
    finally { setBusy(null); }
  };

  if (!data) return <div className="page"><Spinner /></div>;

  const { settings, budget, balance, images, sections, run: runInfo } = data;

  return (
    <div className="page stack">
      <BudgetLine budget={budget} balance={balance} sections={sections} />

      <RunBar
        id={id} run={runInfo} busy={busy} load={load}
        onRun={run("run", () => api.post(`/api/projects/${id}/batch/run`, {}), "Run started.")}
        onDry={run("dry", () => api.post(`/api/projects/${id}/batch/run`, { dryRun: true }), "Dry run started — nothing will be rendered.")}
        onStop={run("stop", () => api.post(`/api/projects/${id}/batch/stop`, {}), "Stopping after the current segment.")}
      />

      <References id={id} images={images} settings={settings} onUpload={run} />

      <Sheet
        id={id} data={data} preview={preview} setPreview={setPreview} busy={busy}
        onPreview={run("preview", async () => setPreview(await api.post(`/api/projects/${id}/batch/import`, {})))}
        onCommit={run("commit", async () => { await api.post(`/api/projects/${id}/batch/import/commit`, {}); setPreview(null); }, "Sheet imported.")}
      />

      <SettingsCard id={id} settings={settings} onSave={run} />

      <Sections id={id} sections={sections} budget={budget} busy={busy} onRender={run} />
    </div>
  );
}

/* --------------------------------------------------------------- budget ---- */

/** The one number that makes the decision legible: how far the balance reaches. */
function BudgetLine({ budget, balance, sections }) {
  if (!budget || budget.error) {
    return <div className="card"><div className="dim small">Balance {money(balance)} · costs unavailable{budget?.error ? ` — ${budget.error}` : ""}</div></div>;
  }
  const reach = budget.reach || [];
  const done = sections.filter((s) => !s.pending).length;
  const seconds = sections.filter((s) => reach.includes(s.id)).reduce((t, s) => t + s.seconds, 0);
  return (
    <div className="card" style={{ padding: "12px 16px" }}>
      <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
        <strong style={{ fontSize: 18 }}>{money(balance)} balance</strong>
        {reach.length ? (
          <span>· completes sections <strong>{reach[0]}–{reach[reach.length - 1]}</strong>{" "}
            <span className="dim">({reach.length} of {sections.length} videos, {mmss(seconds)}, {money(budget.affordable)})</span>
          </span>
        ) : <span className="dim">· not enough to finish any remaining section</span>}
        <span className="grow" />
        {budget.shortfall > 0
          ? <span className="chip warn">{money(budget.shortfall)} more needed for the rest</span>
          : <span className="chip ok">the whole lesson fits</span>}
      </div>
      <div className="dim small" style={{ marginTop: 6 }}>
        {money(budget.total)} outstanding · {done} of {sections.length} sections done · stops while {money(budget.floor)} is still left
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ run ---- */

function RunBar({ run, busy, onRun, onDry, onStop }) {
  const live = run?.running;
  return (
    <div className="card">
      <header>
        <h2>Run</h2>
        <span className="grow" />
        {live
          ? <span className="chip accent">{run.dryRun ? "dry run" : "running"}{run.current ? ` · ${run.current.row}` : ""}</span>
          : run?.reason ? <span className="dim small">last run: {run.reason}</span> : null}
      </header>
      <div className="row">
        <Button className="primary" busy={busy === "run"} disabled={live} onClick={onRun}>Run — section at a time</Button>
        <Button busy={busy === "dry"} disabled={live} onClick={onDry} title="Walks the whole run — quotes, budget checks, prompts — without rendering anything. Free.">Dry run ($0)</Button>
        <Button className="ghost" busy={busy === "stop"} disabled={!live} onClick={onStop} title="Finishes the segment in flight — a clip already paid for is not abandoned">Stop</Button>
        {live ? <span className="dim small">{run.rendered} rendered · {run.failed} failed · {money(run.spent)} spent this run</span> : null}
      </div>
      {run?.log?.length ? (
        <div className="mono small" style={{ maxHeight: 160, overflow: "auto", background: "var(--bg-2)", borderRadius: 8, padding: 10 }}>
          {run.log.slice(-40).map((l, i) => <div key={i}>{l.at.slice(11, 19)} {l.message}</div>)}
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------- references ---- */

/** The two images every clip depends on, so they sit at the top and read filled or empty at a glance. */
function References({ id, images, settings, onUpload }) {
  const upload = (slot) => async (file) => {
    const data = await fileToBase64(file);
    await onUpload("img-" + slot, () => api.post(`/api/projects/${id}/batch/image`, { slot, name: file.name, data }), `${slot} replaced.`)();
  };
  return (
    <div className="card">
      <header><h2>References</h2><span className="dim small">Both go into every clip whole — @image1 is the avatar, @image2 the background</span></header>
      <div className="grid2">
        {["avatar", "background"].map((slot) => {
          const img = images?.[slot];
          return (
            <div key={slot} className="stack">
              {img
                ? <Thumb wide src={`${media(id, settings[slot])}?t=${encodeURIComponent(img.at)}`} caption={`${slot} · ${settings[slot]} · ${(img.bytes / 1024).toFixed(0)} KB`} />
                : <Empty wide>No {slot} yet</Empty>}
              <ImportButton
                label={img ? `Replace ${slot}` : `Upload ${slot}`}
                accept="image/*"
                onFile={upload(slot)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- sheet ---- */

function Sheet({ id, data, preview, busy, onPreview, onCommit, setPreview }) {
  const [url, setUrl] = useState(data.sheetUrl || data.settings.sheetUrl || "");
  const total = data.sections.reduce((t, s) => t + s.rows.length, 0);
  const seconds = data.sections.reduce((t, s) => t + s.seconds, 0);
  return (
    <div className="card">
      <header>
        <h2>Script sheet</h2>
        <span className="grow" />
        {data.importedAt ? <span className="dim small">imported {data.importedAt.slice(0, 16).replace("T", " ")}</span> : null}
      </header>
      <div className="row">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" style={{ flex: 1 }} />
        <Button busy={busy === "preview"} onClick={onPreview}>Check for changes ($0)</Button>
      </div>
      {total ? (
        <div className="dim small">{total} segments · {data.sections.length} sections · {mmss(seconds)} of finished video</div>
      ) : <div className="dim small">Nothing imported yet.</div>}

      {preview ? (
        <div className="card" style={{ background: "var(--bg-2)", padding: 12 }}>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <strong>{preview.counts.rows} rows</strong>
            <span className="chip">{preview.counts.added} new</span>
            <span className={`chip ${preview.counts.changed ? "warn" : ""}`}>{preview.counts.changed} changed</span>
            <span className="chip">{preview.counts.unchanged} unchanged</span>
            {preview.counts.removed ? <span className="chip warn">{preview.counts.removed} gone from the sheet</span> : null}
          </div>
          {preview.counts.changed
            ? <div className="dim small">Changed scripts reset to pending — they have to be re-rendered, and that costs.</div>
            : null}
          {preview.warnings?.length
            ? <div className="dim small">{preview.warnings.length} warning(s): {preview.warnings.slice(0, 3).map((w) => `row ${w.sheetRow}: ${w.message}`).join(" · ")}</div>
            : null}
          <div className="row">
            <Button className="primary sm" busy={busy === "commit"} onClick={onCommit}>Apply to the manifest</Button>
            <Button className="ghost sm" onClick={() => setPreview(null)}>Discard</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- settings ---- */

function SettingsCard({ id, settings, onSave }) {
  const [s, setS] = useState(settings);
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => { setS(settings); }, [settings]);
  const set = (k, v) => setS((x) => ({ ...x, [k]: v }));
  const setW = (k, v) => setS((x) => ({ ...x, wasabi: { ...x.wasabi, [k]: v } }));
  const save = onSave("settings", () => api.patch(`/api/projects/${id}/batch`, s), "Settings saved.");

  return (
    <div className="card">
      <header>
        <h2>Settings</h2>
        <span className="grow" />
        <Button className="ghost sm" onClick={() => setAdvanced(!advanced)}>{advanced ? "▾ Advanced" : "Advanced ▸"}</Button>
      </header>
      <div className="grid2">
        <div className="field"><label>Wasabi bucket</label><input value={s.wasabi?.bucket || ""} onChange={(e) => setW("bucket", e.target.value)} placeholder="my-bucket" /></div>
        <div className="field"><label>Key prefix</label><input value={s.wasabi?.prefix || ""} onChange={(e) => setW("prefix", e.target.value)} placeholder="lesson1" /></div>
        <div className="field"><label>Region</label><input value={s.wasabi?.region || ""} onChange={(e) => setW("region", e.target.value)} placeholder="us-east-1" /></div>
        <div className="field"><label>Credit floor (USD)</label><input type="number" min="0" step="1" value={s.creditFloor} onChange={(e) => set("creditFloor", Number(e.target.value))} /></div>
      </div>
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={!!s.stopBetweenSections} onChange={(e) => set("stopBetweenSections", e.target.checked)} />
        <span>Never start a section the balance can't finish <span className="dim small">— stops between sections, so what's behind you is deliverable</span></span>
      </label>
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={!!s.markCompleteInSheet} onChange={(e) => set("markCompleteInSheet", e.target.checked)} />
        <span>Tick the sheet's Complete column as each segment lands</span>
      </label>

      {advanced ? (
        <div className="stack">
          <div className="field">
            <label>Prompt template <span className="dim small">— {"{script}"} {"{visual}"} {"{duration}"} {"{section}"}</span></label>
            <textarea className="mono" rows={9} value={s.promptTemplate || ""} onChange={(e) => set("promptTemplate", e.target.value)} />
            <div className="hint">The closing instruction is what stops her starting a new sentence in the seconds after the script ends. Most clips have 1–4 of them.</div>
          </div>
          <div className="field">
            <label>Negative prompt</label>
            <textarea className="mono" rows={3} value={s.negativePrompt || ""} onChange={(e) => set("negativePrompt", e.target.value)} />
            <div className="hint">The grid terms matter: the avatar is a four-panel contact sheet, and this stops the model echoing that layout.</div>
          </div>
          <div className="grid2">
            <div className="field"><label>Model</label><input value={s.model} onChange={(e) => set("model", e.target.value)} className="mono" /></div>
            <div className="field"><label>Resolution / aspect</label><input value={`${s.resolution} · ${s.aspect}`} readOnly className="mono" /></div>
          </div>
        </div>
      ) : null}

      <div className="row"><Button className="primary sm" onClick={save}>Save settings</Button></div>
    </div>
  );
}

/* ------------------------------------------------------------- sections ---- */

function Sections({ id, sections, budget, busy, onRender }) {
  const [open, setOpen] = useState({});
  const costOf = (sid) => budget?.sections?.find((b) => b.id === sid);
  if (!sections.length) return <div className="card"><Empty>Import the sheet to see the sections.</Empty></div>;
  return (
    <div className="stack">
      {sections.map((s) => {
        const b = costOf(s.id);
        const done = s.rows.filter((r) => ["rendered", "uploaded", "complete"].includes(r.status)).length;
        return (
          <div key={s.id} className="card" style={{ padding: 0 }}>
            <header style={{ padding: "12px 16px", cursor: "pointer" }} onClick={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))}>
              <strong>{open[s.id] ? "▾" : "▸"} Section {s.id}</strong>
              <span className="dim small">{s.rows[0]?.id}–{s.rows[s.rows.length - 1]?.id} · {s.rows.length} segments · {mmss(s.seconds)}</span>
              <span className="grow" />
              <span className="dim small">{done}/{s.rows.length} rendered</span>
              {b?.cost ? <span className={`chip ${b.fits ? "" : "warn"}`}>{money(b.cost)}</span> : null}
              {s.complete ? <span className="chip ok">complete</span> : null}
              {s.failed ? <span className="chip warn">{s.failed} failed</span> : null}
            </header>
            {open[s.id] ? (
              <div className="stack" style={{ padding: "0 16px 14px" }}>
                {s.rows.map((row) => <Row key={row.id} id={id} row={row} busy={busy} onRender={onRender} />)}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function Row({ id, row, busy, onRender }) {
  const [show, setShow] = useState(false);
  const st = STATUS[row.status] || STATUS.pending;
  const render = onRender("row-" + row.id,
    () => api.post(`/api/projects/${id}/batch/row/${row.id}/render`, {}),
    `Rendering segment ${row.id}.`);
  return (
    <div style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
      <div className="row" style={{ gap: 10, alignItems: "baseline" }}>
        <span className="mono" style={{ minWidth: 52 }}>{row.id}</span>
        <span className="dim small" style={{ minWidth: 84 }}>{row.wantSeconds}s → {row.duration}</span>
        <span style={{ color: st.color, minWidth: 76, fontSize: 12.5 }}>{st.label}</span>
        <span className="dim small grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.scriptText}</span>
        {row.visual ? <span className="chip">visual</span> : null}
        {row.quote ? <span className="dim small" title="what this row actually cost">{money(row.quote)}</span> : null}
        <Button className="ghost xs" onClick={() => setShow(!show)}>{show ? "hide" : "prompt"}</Button>
        <Button className="xs" busy={busy === "row-" + row.id} disabled={row.sheetComplete || row.status === "rendering"} onClick={render} title={row.sheetComplete ? "Marked Complete in the sheet" : "Renders this one segment now, and charges for it"}>Render this one{row.price != null ? ` · ${money(row.price)}` : ""}</Button>
      </div>
      {row.error ? <div className="small" style={{ color: "var(--danger)" }}>{row.error}</div> : null}
      {show ? (
        <div className="stack" style={{ margin: "8px 0" }}>
          <div className="mono small" style={{ background: "var(--bg-2)", borderRadius: 8, padding: 10, whiteSpace: "pre-wrap" }}>{row.prompt}</div>
          {row.clip ? <video src={media(id, row.clip)} controls preload="metadata" style={{ maxWidth: 480, borderRadius: 8 }} /> : null}
        </div>
      ) : null}
    </div>
  );
}
