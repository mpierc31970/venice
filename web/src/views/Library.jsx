import React from "react";
import { media } from "../lib/api.js";
import { useProject } from "../lib/store.jsx";
import { StepHead, Thumb } from "../components/ui.jsx";

export default function Library() {
  const { id, dir, shots, elements, script } = useProject();
  const clips = shots.filter((s) => s.clip);
  const lines = shots.flatMap((s) => (s.lines || []).map((l) => ({ ...l, shotId: s.id })));
  return (
    <div className="page wide">
      <StepHead stepKey="library" checklist={[{ done: clips.length > 0, label: `${clips.length}/${shots.length} shots have a clip` }, { done: lines.length > 0, label: `${lines.length} dialogue lines rendered` }]} />
      <div className="card" style={{ padding: "10px 16px" }}><span className="dim small">Everything is on disk at</span> <code>{dir}</code> <span className="dim small">— shots/&lt;id&gt;/clip-*.mp4 and shots/&lt;id&gt;/lines/*.mp3. Import the folder into DaVinci / Premiere / CapCut.</span></div>
      {(script?.scenes || []).map((sc) => (
        <div className="card" key={sc.id}>
          <header><span className="mono dim">{sc.id}</span><h2>{sc.title}</h2><span className="chip">{sc.mood}</span></header>
          <div className="thumbs" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
            {shots.filter((s) => s.sceneId === sc.id).map((s) => s.clip
              ? <Thumb key={s.id} wide video src={media(id, s.clip)} caption={`${s.id} · ${s.durationS} · ${s.models?.video || ""}`} />
              : s.keyframe ? <Thumb key={s.id} wide src={media(id, s.keyframe)} caption={`${s.id} · keyframe only`} /> : <div key={s.id} className="empty wide">{s.id}<br />nothing yet</div>)}
          </div>
          {lines.filter((l) => l.shotId.startsWith(sc.id + "-")).length ? (
            <table><thead><tr><th>Shot</th><th>Character</th><th>Line</th><th>Audio</th></tr></thead><tbody>
              {lines.filter((l) => l.shotId.startsWith(sc.id + "-")).map((l) => <tr key={l.file}><td className="mono dim">{l.shotId}</td><td>{l.character}</td><td>{l.text}</td><td><audio controls src={media(id, l.file)} style={{ height: 30 }} /></td></tr>)}
            </tbody></table>
          ) : null}
        </div>
      ))}
      <div className="card">
        <h2>Reference sheets</h2>
        <div className="thumbs">
          {elements.flatMap((e) => ["frontal", "q45", "profile", "rear"].filter((a) => e.angles?.[a]).map((a) => <Thumb key={e.slug + a} src={media(id, e.angles[a].file)} caption={`${e.name} · ${a}`} wide={e.type === "location"} />))}
        </div>
      </div>
    </div>
  );
}
