import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { useStudio } from "../lib/store.jsx";
import { Button } from "../components/ui.jsx";

export default function Settings() {
  const { billing, refreshBilling, toast } = useStudio();
  const [s, setS] = useState({ lowBalanceUsd: 5, criticalBalanceUsd: 1 });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (billing?.settings) setS(billing.settings); }, [billing]);
  const save = async () => {
    setBusy(true);
    try { await api.put("/api/billing/settings", { lowBalanceUsd: Number(s.lowBalanceUsd), criticalBalanceUsd: Number(s.criticalBalanceUsd) }); await refreshBilling(); toast("Saved", "ok"); }
    catch (e) { toast(e.message, "error"); } finally { setBusy(false); }
  };
  return (
    <>
      <h1>Settings</h1>
      <div className="card">
        <h2>Credit warnings</h2>
        <p className="muted">The balance chip in the top bar turns amber under the low threshold and red under the critical one. Current balance: <b>${billing?.usd?.toFixed(2) ?? "—"}</b>.</p>
        <div className="grid2">
          <div className="field"><label>Warn below (USD)</label><input type="number" step="0.5" value={s.lowBalanceUsd} onChange={(e) => setS({ ...s, lowBalanceUsd: e.target.value })} /></div>
          <div className="field"><label>Critical below (USD)</label><input type="number" step="0.5" value={s.criticalBalanceUsd} onChange={(e) => setS({ ...s, criticalBalanceUsd: e.target.value })} /></div>
        </div>
        <div className="row"><Button className="primary" busy={busy} onClick={save}>Save</Button><a className="btn" href="https://venice.ai/settings/api" target="_blank" rel="noreferrer">Add credits on venice.ai ↗</a></div>
      </div>
      <div className="card">
        <h2>API key</h2>
        <p className="muted">Read from <code>VENICE_API_KEY</code> in the repo's <code>.env</code>. Claude, images, video and voices all go through this single key.</p>
      </div>
    </>
  );
}
