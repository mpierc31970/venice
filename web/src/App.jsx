import React from "react";
import { Routes, Route, NavLink, useParams, Link, Navigate } from "react-router-dom";
import { StudioProvider, ProjectProvider, useProject, useStudio, STEPS } from "./lib/store.jsx";
import { BalanceChip, Toasts, Spinner } from "./components/ui.jsx";
import { api } from "./lib/api.js";
import Projects from "./views/Projects.jsx";
import Setup from "./views/Setup.jsx";
import Bible from "./views/Bible.jsx";
import Elements from "./views/Elements.jsx";
import Assets from "./views/Assets.jsx";
import Script from "./views/Script.jsx";
import Shots from "./views/Shots.jsx";
import Library from "./views/Library.jsx";
import Settings from "./views/Settings.jsx";

export default function App() {
  return (
    <StudioProvider>
      <Routes>
        <Route path="/" element={<Home><Projects /></Home>} />
        <Route path="/settings" element={<Home><Settings /></Home>} />
        <Route path="/p/:id/*" element={<ProjectShell />} />
      </Routes>
      <Toasts />
    </StudioProvider>
  );
}

function TopBar({ children }) {
  return (
    <div className="topbar">
      <Link to="/" className="brand" style={{ color: "inherit" }}><span className="dot" />Venice Studio</Link>
      {children}
      <span className="grow" />
      <BalanceChip />
      <Link to="/settings" className="btn ghost sm">Settings</Link>
    </div>
  );
}

function Home({ children }) {
  return (
    <div className="shell" style={{ gridTemplateColumns: "1fr" }}>
      <TopBar />
      <div className="main"><div className="page">{children}</div></div>
    </div>
  );
}

function ProjectShell() {
  const { id } = useParams();
  return (
    <ProjectProvider id={id}>
      <ProjectFrame />
    </ProjectProvider>
  );
}

function ProjectFrame() {
  const p = useProject();
  if (p.loading) return <div className="shell" style={{ gridTemplateColumns: "1fr" }}><TopBar /><div className="main"><Spinner /></div></div>;
  if (p.error) return <div className="shell" style={{ gridTemplateColumns: "1fr" }}><TopBar /><div className="main"><div className="page"><div className="card">Couldn't open project: {p.error}. <Link to="/">Back to projects</Link></div></div></div></div>;
  return (
    <div className="shell">
      <TopBar>
        <span className="crumb">/</span><span>{p.project.title}</span>
        <OpenFolder id={p.id} dir={p.dir} />
      </TopBar>
      <Rail />
      <div className="main">
        <Routes>
          <Route index element={<Navigate to="setup" replace />} />
          <Route path="setup" element={<Setup />} />
          <Route path="bible" element={<Bible />} />
          <Route path="elements/*" element={<Elements />} />
          <Route path="assets" element={<Assets />} />
          <Route path="script" element={<Script />} />
          <Route path="shots/:mode" element={<Shots />} />
          <Route path="library" element={<Library />} />
        </Routes>
      </div>
    </div>
  );
}

function OpenFolder({ id, dir }) {
  const { toast } = useStudio();
  const open = (sub) => api.post(`/api/projects/${id}/open-folder`, { sub }).catch((e) => toast(e.message, "error"));
  return (
    <span className="row" style={{ gap: 4 }}>
      <button className="btn sm" onClick={() => open()} title={dir}>📁 Open project folder</button>
      <button className="btn ghost sm" onClick={() => open("assets")} title="Drop scene assets here">assets/</button>
      <button className="btn ghost sm" onClick={() => open("shots")} title="Rendered clips and audio">shots/</button>
    </span>
  );
}

function Rail() {
  const { steps, id, jobs } = useProject();
  const activeJobs = (jobs || []).filter((j) => j.status === "PENDING" || j.status === "PROCESSING");
  return (
    <nav className="rail">
      <h4 style={{ padding: "4px 10px 10px" }}>Pipeline</h4>
      <div className="steps">
        {steps.map((s) => (
          <NavLink key={s.key} to={`/p/${id}/${s.path}`} className={({ isActive }) => `step ${s.status} ${isActive ? "active" : ""}`}>
            <span className="num">{s.status === "done" ? "✓" : s.n}</span>
            <span>
              <div className="t">{s.title}{s.optional ? <span className="opt">optional</span> : null}</div>
              <div className="b">{s.blurb}</div>
            </span>
          </NavLink>
        ))}
      </div>
      <div className="jobs">
        <h4 style={{ padding: "0 10px 8px" }}>Renders {activeJobs.length ? `· ${activeJobs.length} active` : ""}</h4>
        <div className="stack" style={{ padding: "0 4px" }}>
          {(jobs || []).slice(0, 5).map((j) => <JobRow key={j.id} job={j} />)}
          {!jobs?.length ? <div className="dim small" style={{ padding: "0 6px" }}>No renders yet.</div> : null}
        </div>
      </div>
    </nav>
  );
}

export function JobRow({ job }) {
  const pct = job.eta && job.elapsed ? Math.min(95, Math.round((job.elapsed / job.eta) * 100)) : job.status === "PROCESSING" ? 10 : 0;
  const color = { COMPLETED: "var(--ok)", FAILED: "var(--danger)", CANCELLED: "var(--ink-3)" }[job.status] || "var(--accent)";
  return (
    <div className="job" title={job.error || ""}>
      <div className="t"><span className="mono">{job.meta?.shotId || job.id}</span><span style={{ color }}>{job.status.toLowerCase()}</span></div>
      {job.status === "PROCESSING" || job.status === "PENDING" ? <div className="bar"><i style={{ width: `${pct}%` }} /></div> : null}
      {job.error ? <div className="dim" style={{ fontSize: 11, whiteSpace: "normal" }}>{job.error.slice(0, 140)}{/content policy/i.test(job.error) ? <><br /><span style={{ color: "var(--warn)" }}>Provider moderation, not Venice — this shot's prompt is fine. Re-render with another family (Wan, Kling, LTX, Veo).</span></> : null}</div> : null}
    </div>
  );
}
