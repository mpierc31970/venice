// Manual mode: run any Claude-powered action through your own ChatGPT/Gemini subscription by copy/paste.
//   1. "Copy prompt" → server returns the exact system+user prompt without calling a model.
//   2. Paste the model's answer back → server re-runs the route with `result`, so it saves/parses exactly as if Claude had answered.
import React, { useState } from "react";
import { api, stream } from "../lib/api.js";
import { useStudio } from "../lib/store.jsx";
import { Button } from "./ui.jsx";

export async function copyPrompt(url, body = {}, isStream = false) {
  let d;
  if (isStream) {
    let payload = null;
    await streamRaw(url, { ...body, dry: true }, (evt) => { if (evt.dry) payload = evt; });
    d = payload;
  } else d = await api.post(url, { ...body, dry: true });
  if (!d?.dry) throw new Error("No prompt returned");
  const text = `${d.system ? `SYSTEM / INSTRUCTIONS:\n${d.system}\n\n` : ""}USER:\n${d.user}${d.json ? "\n\n(Reply with JSON only.)" : ""}`;
  await navigator.clipboard.writeText(text);
  return text;
}

async function streamRaw(url, body, onEvent) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); let i;
    while ((i = buf.indexOf("\n\n")) >= 0) { const f = buf.slice(0, i); buf = buf.slice(i + 2); const l = f.split("\n").find((x) => x.startsWith("data: ")); if (l) onEvent(JSON.parse(l.slice(6))); }
  }
}

/**
 * Wraps a Claude action button with a "manual" alternative.
 * props: url, body, isStream, label, busy, onRun (normal click), onResult(text) optional override for applying pasted text,
 *        onApplied() called after server-side apply.
 */
export function ClaudeAction({ url, body = {}, isStream = false, label, busy, onRun, onApplied, onResult, className = "claude", disabled, small }) {
  const { toast } = useStudio();
  const [open, setOpen] = useState(false);
  const [pasted, setPasted] = useState("");
  const [b, setB] = useState(null);
  const copy = async () => { setB("copy"); try { await copyPrompt(url, body, isStream); toast("Prompt copied. Paste it into ChatGPT / Gemini, then paste the answer below.", "ok", 7000); } catch (e) { toast(e.message, "error"); } finally { setB(null); } };
  const apply = async () => {
    if (!pasted.trim()) return;
    setB("apply");
    try {
      if (onResult) await onResult(pasted);
      else if (isStream) await stream(url, { ...body, result: pasted });
      else await api.post(url, { ...body, result: pasted });
      setPasted(""); setOpen(false); await onApplied?.(); toast("Applied.", "ok");
    } catch (e) { toast(e.message, "error", 8000); } finally { setB(null); }
  };
  return (
    <span className="stack" style={{ gap: 6, alignItems: "flex-start" }}>
      <span className="row" style={{ gap: 4 }}>
        <Button className={`${className} ${small ? "xs" : ""}`} busy={busy} onClick={onRun} disabled={disabled}>✦ {label}</Button>
        <Button className={`ghost ${small ? "xs" : "sm"}`} onClick={() => setOpen(!open)} title="Use your own ChatGPT / Gemini subscription instead: copy the prompt, paste the answer back" disabled={disabled}>{open ? "▾" : "manual ▸"}</Button>
      </span>
      {open ? (
        <span className="card" style={{ padding: 10, gap: 8, width: "100%", minWidth: 320, background: "var(--bg-2)" }}>
          <span className="row"><Button className="sm" busy={b === "copy"} onClick={copy}>1 · Copy prompt</Button><span className="dim small">→ paste in ChatGPT / Gemini (your subscription, $0)</span></span>
          <textarea rows={5} placeholder="2 · Paste the model's answer here" value={pasted} onChange={(e) => setPasted(e.target.value)} className="mono" />
          <span className="row"><Button className="primary sm" busy={b === "apply"} onClick={apply} disabled={!pasted.trim()}>3 · Apply answer</Button></span>
        </span>
      ) : null}
    </span>
  );
}

/** File picker → base64 upload helper for import buttons. */
export function ImportButton({ label, accept, onFile, className = "sm" }) {
  const [busy, setBusy] = useState(false);
  return (
    <label className={`btn ${className}`} style={{ margin: 0, cursor: "pointer" }}>
      {busy ? "Importing…" : label}
      <input type="file" accept={accept} style={{ display: "none" }} onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setBusy(true); try { await onFile(f); } finally { setBusy(false); e.target.value = ""; } }} />
    </label>
  );
}
