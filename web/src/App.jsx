import React from "react";
import { Routes, Route, Link, useParams } from "react-router-dom";
import { StudioProvider, useStudio } from "./lib/store.jsx";
import { BalanceChip, Toasts, Button } from "./components/ui.jsx";
import { api } from "./lib/api.js";
import Projects from "./views/Projects.jsx";
import Batch from "./views/Batch.jsx";
import Settings from "./views/Settings.jsx";

export default function App() {
  return (
    <StudioProvider>
      <Routes>
        <Route path="/" element={<Frame><Projects /></Frame>} />
        <Route path="/settings" element={<Frame><Settings /></Frame>} />
        <Route path="/b/:id" element={<BatchPage />} />
      </Routes>
      <Toasts />
    </StudioProvider>
  );
}

/** One frame for the whole app: brand, balance, settings. No pipeline rail. */
function Frame({ children, crumb, actions }) {
  return (
    <div className="shell" style={{ gridTemplateColumns: "1fr" }}>
      <div className="topbar">
        <Link to="/" className="brand" style={{ color: "inherit" }}><span className="dot" />Venice Studio</Link>
        {crumb ? <><span className="crumb">/</span><span>{crumb}</span></> : null}
        {actions}
        <span className="grow" />
        <BalanceChip />
        <Link to="/settings" className="btn ghost sm">Settings</Link>
      </div>
      <div className="main">{children}</div>
    </div>
  );
}

function BatchPage() {
  const { id } = useParams();
  const { toast } = useStudio();
  const WHY = {
    clips: "it is created when the first clip renders",
    sections: "it is created in stage 2, when sections are assembled",
  };
  const open = (sub) => api.post(`/api/projects/${id}/open-folder`, { sub })
    .then((r) => { if (r.missing) toast(`No ${sub}/ folder yet — ${WHY[sub] || "nothing has written to it"}. Opened the project folder instead.`, "info", 7000); })
    .catch((e) => toast(e.message, "error"));
  return (
    <Frame
      crumb={id}
      actions={
        <span className="row" style={{ gap: 4 }}>
          <Button className="sm" onClick={() => open()}>📁 Folder</Button>
          <Button className="ghost sm" onClick={() => open("clips")}>clips/</Button>
          <Button className="ghost sm" onClick={() => open("sections")}>sections/</Button>
        </span>
      }
    >
      <Batch id={id} />
    </Frame>
  );
}
