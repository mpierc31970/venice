// End-to-end smoke test of the text + keyframe pipeline (no video render). Run: node _pipeline-test.mjs <projectId>
const id = process.argv[2];
const B = `http://localhost:3939/api/projects/${id}`;
const j = async (method, path, body) => {
  const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${t.slice(0, 300)}`);
  return t;
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

log("screenplay…");
const sp = await j("POST", "/script/screenplay", { notes: "Very short: 2 scenes, 4 dialogue lines total." });
log("screenplay chars", sp.length);
log("scenes…");
const scenes = JSON.parse(await j("POST", "/script/scenes", {}));
log("scenes", scenes.map((s) => `${s.id}:${s.title} (${s.dialogue.length} lines)`));
const sid = scenes[0].id;
log("shotlist for", sid, "with cheap model…");
const sl = JSON.parse(await j("POST", `/script/scenes/${sid}/shotlist`, { videoModel: "seedance-2-0-fast-image-to-video-basic" }));
log("shots", sl.shots);
const shotId = sl.shots[0];
log("keyframe prompt…");
const s1 = JSON.parse(await j("POST", `/shots/${shotId}/keyframe-prompt`, {}));
log("kf prompt:", s1.keyframePrompt.slice(0, 200) + "…");
log("keyframe image…");
const s2 = JSON.parse(await j("POST", `/shots/${shotId}/keyframe`, { variants: 1 }));
log("keyframe:", s2.keyframe);
log("video prompt…");
const s3 = JSON.parse(await j("POST", `/shots/${shotId}/video-prompt`, {}));
log("video prompt:", s3.videoPrompt.slice(0, 300) + "…");
log("quote (480p)…");
const q = JSON.parse(await j("POST", `/shots/${shotId}/quote`, { resolution: "480p" }));
log("quote:", JSON.stringify(q.quote), "err:", q.error, "request:", JSON.stringify(q.request), "refs:", JSON.stringify(q.refs));
log("DONE. shot =", shotId);
