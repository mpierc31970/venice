import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";

const Ctx = createContext(null);

export function StudioProvider({ children }) {
  const [billing, setBilling] = useState(null);
  const [models, setModels] = useState({});
  const [toasts, setToasts] = useState([]);

  const refreshBilling = useCallback(async () => {
    try { setBilling(await api.get("/api/billing")); } catch (e) { console.warn("billing", e.message); }
  }, []);
  useEffect(() => { refreshBilling(); const t = setInterval(refreshBilling, 60_000); return () => clearInterval(t); }, [refreshBilling]);

  const loadModels = useCallback(async (type) => {
    if (models[type]) return models[type];
    const list = await api.get(`/api/models?type=${type}`);
    setModels((m) => ({ ...m, [type]: list }));
    return list;
  }, [models]);
  useEffect(() => { ["text", "image", "video", "tts"].forEach((t) => loadModels(t).catch(() => {})); }, []); // eslint-disable-line

  const idRef = useRef(0);
  const toast = useCallback((msg, kind = "info", ms = 5000) => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);

  const value = useMemo(() => ({ billing, refreshBilling, models, loadModels, toast, toasts }), [billing, refreshBilling, models, loadModels, toast, toasts]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useStudio = () => useContext(Ctx);

/** Per-project context: project data + pipeline status derived from server state. */
const PCtx = createContext(null);

export function ProjectProvider({ id, children }) {
  const [state, setState] = useState({ loading: true });
  const { toast } = useStudio();

  const reload = useCallback(async () => {
    try {
      const [p, bible, elements, script, shots, assets, jobs] = await Promise.all([
        api.get(`/api/projects/${id}`), api.get(`/api/projects/${id}/bible`), api.get(`/api/projects/${id}/elements`),
        api.get(`/api/projects/${id}/script`), api.get(`/api/projects/${id}/shots`), api.get(`/api/projects/${id}/assets`), api.get(`/api/projects/${id}/jobs`),
      ]);
      setState({ loading: false, id, dir: p.dir, project: p.project, bible, elements, script, shots, assets, jobs });
    } catch (e) { setState({ loading: false, error: e.message }); toast(e.message, "error"); }
  }, [id, toast]);
  useEffect(() => { reload(); }, [reload]);

  // Poll jobs while any are active.
  useEffect(() => {
    if (!state.jobs?.some((j) => j.status === "PENDING" || j.status === "PROCESSING")) return;
    const t = setInterval(async () => {
      try {
        const jobs = await api.get(`/api/projects/${id}/jobs`);
        setState((s) => ({ ...s, jobs }));
        if (!jobs.some((j) => j.status === "PENDING" || j.status === "PROCESSING")) reload();
      } catch {}
    }, 6000);
    return () => clearInterval(t);
  }, [state.jobs, id, reload]);

  const patchProject = useCallback(async (patch) => {
    const project = await api.patch(`/api/projects/${id}`, patch);
    setState((s) => ({ ...s, project }));
    return project;
  }, [id]);

  const steps = useMemo(() => computeSteps(state), [state]);
  const value = useMemo(() => ({ ...state, reload, patchProject, steps, setState }), [state, reload, patchProject, steps]);
  return <PCtx.Provider value={value}>{children}</PCtx.Provider>;
}

export const useProject = () => useContext(PCtx);

export const STEPS = [
  { key: "setup", n: 1, title: "Project setup", blurb: "Title, logline and default models.", path: "setup" },
  { key: "bible", n: 2, title: "Story bible", blurb: "World, cast, aesthetic, prohibitions, world seed.", path: "bible" },
  { key: "elements", n: 3, title: "Characters & references", blurb: "Verbatim descriptions, identity board, 4 locked angles, voice.", path: "elements" },
  { key: "assets", n: 4, title: "Scene assets", blurb: "Plates, props and style references from your folder.", path: "assets", optional: true },
  { key: "script", n: 5, title: "Script & shot list", blurb: "Screenplay → scenes → AI-optimized shots.", path: "script" },
  { key: "keyframes", n: 6, title: "Keyframes", blurb: "A locked still for every shot.", path: "shots/keyframes" },
  { key: "render", n: 7, title: "Render clips", blurb: "Quote, queue and collect each shot's video.", path: "shots/render" },
  { key: "dialogue", n: 8, title: "Dialogue audio", blurb: "Every line in its character's voice.", path: "shots/dialogue" },
  { key: "library", n: 9, title: "Library", blurb: "Everything generated, ready for your editor.", path: "library" },
];

function computeSteps(s) {
  if (s.loading || s.error) return STEPS.map((st) => ({ ...st, status: "todo" }));
  const chars = (s.elements || []).filter((e) => e.type === "character");
  const shots = s.shots || [];
  const scenes = s.script?.scenes || [];
  const linesNeeded = shots.flatMap((sh) => (sh.dialogueLines || []).map((i) => `${sh.id}:${i}`));
  const linesDone = shots.flatMap((sh) => (sh.lines || []).map((l) => `${sh.id}:${l.lineIndex}`));
  const status = {
    setup: s.project?.logline ? "done" : "partial",
    bible: s.bible?.bible && s.bible?.worldSeed ? "done" : s.bible?.bible ? "partial" : "todo",
    elements: chars.length && chars.every((c) => c.locked) ? "done" : chars.length ? "partial" : "todo",
    assets: (s.assets?.files || []).some((f) => f.kind) ? "done" : (s.assets?.files || []).length ? "partial" : "todo",
    script: scenes.length && scenes.every((sc) => sc.shots?.length) ? "done" : scenes.length || s.script?.screenplay ? "partial" : "todo",
    keyframes: shots.length && shots.every((sh) => sh.keyframe) ? "done" : shots.some((sh) => sh.keyframe) ? "partial" : "todo",
    render: shots.length && shots.every((sh) => sh.clip) ? "done" : shots.some((sh) => sh.clip) ? "partial" : "todo",
    dialogue: linesNeeded.length && linesNeeded.every((k) => linesDone.includes(k)) ? "done" : linesDone.length ? "partial" : linesNeeded.length ? "todo" : "n/a",
    library: shots.some((sh) => sh.clip) ? "done" : "todo",
  };
  return STEPS.map((st) => ({ ...st, status: status[st.key] }));
}
