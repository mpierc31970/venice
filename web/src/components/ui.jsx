import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { useStudio, useProject, STEPS } from "../lib/store.jsx";
import { copyPrompt } from "./manual.jsx";

export const Spinner = () => <span className="spin" aria-label="loading" />;

export function Button({ children, busy, className = "", ...rest }) {
  return (
    <button className={`btn ${className}`} disabled={busy || rest.disabled} {...rest}>
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Toasts() {
  const { toasts } = useStudio();
  return (
    <div className="toasts" role="status">
      {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>)}
    </div>
  );
}

/** Balance chip: amber under lowBalanceUsd, red under criticalBalanceUsd. */
export function BalanceChip() {
  const { billing } = useStudio();
  if (!billing) return <span className="balance"><span className="led" style={{ background: "var(--ink-3)" }} />…</span>;
  const usd = billing.usd ?? 0;
  const { lowBalanceUsd = 5, criticalBalanceUsd = 1 } = billing.settings || {};
  const cls = usd < criticalBalanceUsd ? "crit" : usd < lowBalanceUsd ? "warn" : "";
  const label = usd < criticalBalanceUsd ? "Reload now" : usd < lowBalanceUsd ? "Running low" : "Venice balance";
  return (
    <a className={`balance ${cls}`} href="https://venice.ai/settings/api" target="_blank" rel="noreferrer" title={`${label}. Warn below $${lowBalanceUsd}, critical below $${criticalBalanceUsd}. Change in Settings.`}>
      <span className="led" />
      <span>${usd.toFixed(2)}</span>
      {billing.diem ? <span className="dim">· {billing.diem} DIEM</span> : null}
      {cls ? <span style={{ fontFamily: "var(--font)", fontSize: 12 }}>{label} →</span> : null}
    </a>
  );
}

/** Model picker fed by /api/models with constraint-aware option labels. */
export function ModelPicker({ type, value, onChange, filter, allowEmpty, label, small }) {
  const { models, loadModels } = useStudio();
  useEffect(() => { loadModels(type).catch(() => {}); }, [type]); // eslint-disable-line
  const list = useMemo(() => {
    let l = models[type] || [];
    if (filter) l = l.filter(filter);
    if (type === "text") {
      // Free providers first, then Claude, then the rest.
      const rank = (m) => (m.paid === false ? 0 : /claude/.test(m.id) ? 1 : 2);
      l = [...l].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
    }
    return l;
  }, [models, type, filter]);
  const norm = type === "text" && value && !value.includes(":") ? `venice:${value}` : value; // legacy unprefixed ids
  const sel = (
    <select value={norm || ""} onChange={(e) => onChange(e.target.value || null)} style={small ? { padding: "5px 30px 5px 8px", fontSize: 12.5 } : undefined}>
      {allowEmpty ? <option value="">(project default)</option> : null}
      {!list.length || (norm && !list.some((m) => m.id === norm)) ? <option value={norm || ""}>{norm || "loading…"}</option> : null}
      {list.map((m) => <option key={m.id} value={m.id}>{labelFor(m)}</option>)}
    </select>
  );
  return label ? <div className="field"><label>{label}</label>{sel}</div> : sel;
}

function labelFor(m) {
  const c = m.constraints || {};
  const bits = [];
  if (m.type === "text") { if (m.providerLabel) bits.push(m.providerLabel.split(" (")[0]); bits.push(m.paid === false ? "FREE tier" : "paid"); }
  if (m.type === "video") { if (c.model_type) bits.push(c.model_type.replace(/-/g, " ")); if (c.durations?.length) bits.push(`${c.durations[0]}–${c.durations[c.durations.length - 1]}`); if (c.audio) bits.push("audio"); }
  if (m.type === "image" && m.pricing?.resolutions?.["1K"]?.usd) bits.push(`$${m.pricing.resolutions["1K"].usd}/img`);
  if (m.type === "tts" && m.voices) bits.push(`${m.voices.length} voices`);
  if (m.privacy === "private") bits.push("private");
  return `${m.name || m.id}${bits.length ? ` — ${bits.join(" · ")}` : ""}`;
}

/**
 * Textarea/input with an "Improve with Claude" button. kind: image|video|description|bio|dialogue|logline|mood|generic.
 * Shows a before/after compare and lets the user accept or discard.
 */
export function ImproveField({ label, value, onChange, kind = "generic", context = "", rows = 4, mono, hint, placeholder, single, disabled }) {
  const { id } = useProject();
  const { toast } = useStudio();
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState(null);
  const [manual, setManual] = useState(false);
  const [pasted, setPasted] = useState("");
  const copy = async () => { if (!value?.trim()) return toast("Write something first.", "info"); setBusy(true); try { await copyPrompt(`/api/projects/${id}/bible/improve`, { kind, text: value, context }); toast("Prompt copied — paste into ChatGPT/Gemini, then paste the answer here.", "ok", 7000); } catch (e) { toast(e.message, "error"); } finally { setBusy(false); } };
  const improve = async () => {
    if (!value?.trim()) return toast("Write something first, then improve it.", "info");
    setBusy(true);
    try { const r = await api.post(`/api/projects/${id}/bible/improve`, { kind, text: value, context }); setProposal(r.text); }
    catch (e) { toast(e.message, "error"); } finally { setBusy(false); }
  };
  return (
    <div className="field">
      <div className="lbl">
        <label>{label}</label>
        <span className="grow" />
        <Button className="claude xs" onClick={improve} busy={busy} disabled={disabled} title="Rewrite with Claude using the story bible canon">✦ Improve with Claude</Button>
        <Button className="ghost xs" onClick={() => setManual(!manual)} disabled={disabled} title="Use your own ChatGPT / Gemini subscription instead ($0): copy the prompt, paste the answer back">{manual ? "▾" : "manual ▸"}</Button>
      </div>
      {manual ? (
        <div className="card" style={{ padding: 10, gap: 8, background: "var(--bg-2)" }}>
          <div className="row"><Button className="sm" busy={busy} onClick={copy}>1 · Copy prompt</Button><span className="dim small">→ paste in ChatGPT / Gemini</span></div>
          <textarea rows={4} className="mono" placeholder="2 · Paste the rewritten text here" value={pasted} onChange={(e) => setPasted(e.target.value)} />
          <div className="row"><Button className="primary sm" onClick={() => { setProposal(pasted.trim()); setPasted(""); setManual(false); }} disabled={!pasted.trim()}>3 · Review</Button></div>
        </div>
      ) : null}
      {single
        ? <input value={value || ""} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} />
        : <textarea className={mono ? "mono" : ""} rows={rows} value={value || ""} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} />}
      {hint ? <div className="hint">{hint}</div> : null}
      {proposal !== null ? (
        <div className="stack" style={{ marginTop: 6 }}>
          <div className="compare">
            <div className="box"><h4>Current</h4>{value}</div>
            <div className="box new"><h4 style={{ color: "var(--accent)" }}>Claude's rewrite</h4>{proposal}</div>
          </div>
          <div className="row">
            <Button className="primary sm" onClick={() => { onChange(proposal); setProposal(null); }}>Use rewrite</Button>
            <Button className="sm" onClick={improve} busy={busy}>Try again</Button>
            <Button className="ghost sm" onClick={() => setProposal(null)}>Keep mine</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Step header with the checklist and "continue" affordance. */
export function StepHead({ stepKey, checklist = [], children }) {
  const { steps, id } = useProject();
  const step = steps.find((s) => s.key === stepKey) || STEPS.find((s) => s.key === stepKey);
  const idx = STEPS.findIndex((s) => s.key === stepKey);
  const next = STEPS[idx + 1];
  return (
    <>
      <div className="stephead">
        <div className="grow">
          <div className="k">Step {step.n} of {STEPS.length}{step.optional ? " · optional" : ""}</div>
          <h1>{step.title}</h1>
          <p>{step.blurb}</p>
        </div>
        {children}
      </div>
      {checklist.length ? (
        <div className="card" style={{ padding: "12px 16px" }}>
          <div className="checklist">
            {checklist.map((c, i) => <div key={i} className={`item ${c.done ? "done" : ""}`}><span className="box">{c.done ? "✓" : ""}</span><span>{c.label}</span>{c.hint && !c.done ? <span className="dim small">— {c.hint}</span> : null}</div>)}
          </div>
        </div>
      ) : null}
      {next ? <NextBar to={`/p/${id}/${next.path}`} ready={step.status === "done" || step.optional} label={next.title} /> : null}
    </>
  );
}

function NextBar({ to, ready, label }) {
  return (
    <div className="nextbar" style={{ position: "static", padding: 0, background: "none", justifyContent: "flex-start" }}>
      <Link to={to} className={`btn ${ready ? "primary" : ""} sm`} title={ready ? "" : "You can continue, but the checklist above isn't complete yet"}>
        {ready ? "Continue" : "Skip ahead"}: {label} →
      </Link>
    </div>
  );
}

export function Thumb({ src, video, selected, onClick, caption, tag, wide, children }) {
  return (
    <div className={`thumb ${selected ? "sel" : ""} ${wide ? "wide" : ""}`} onClick={onClick}>
      {video ? <video src={src} controls preload="metadata" /> : <img src={src} alt="" loading="lazy" />}
      {tag ? <span className="chip accent tag">{tag}</span> : null}
      {caption ? <div className="cap">{caption}</div> : null}
      {children}
    </div>
  );
}

export function Empty({ children, wide }) { return <div className={`empty ${wide ? "wide" : ""}`}>{children}</div>; }

export const money = (n) => (n == null ? "—" : `$${Number(n).toFixed(n < 0.1 ? 3 : 2)}`);
