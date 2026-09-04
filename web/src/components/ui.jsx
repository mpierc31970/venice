import React, { useState } from "react";
import { useStudio } from "../lib/store.jsx";

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

/** File picker → the caller receives the File and does the upload. */
export function ImportButton({ label, accept, onFile, className = "sm" }) {
  const [busy, setBusy] = useState(false);
  return (
    <label className={`btn ${className}`} style={{ margin: 0, cursor: "pointer" }}>
      {busy ? "Importing…" : label}
      <input type="file" accept={accept} style={{ display: "none" }} onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setBusy(true); try { await onFile(f); } finally { setBusy(false); e.target.value = ""; } }} />
    </label>
  );
}

/** Sub-cent prices keep three decimals; zero and ordinary amounts keep two. */
export const money = (n) => (n == null ? "—" : `$${Number(n).toFixed(n > 0 && n < 0.1 ? 3 : 2)}`);
