// Thin fetch wrapper + SSE reader for the Venice Studio API.

async function handle(res) {
  const ct = res.headers.get("content-type") || "";
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.error || msg; if (j.detail?.error) msg += ` — ${j.detail.error}`; else if (typeof j.detail === "string") msg += ` — ${j.detail}`; } catch {}
    throw new Error(msg);
  }
  if (ct.includes("application/json")) return res.json();
  return res.blob();
}

export const api = {
  get: (url) => fetch(url).then(handle),
  post: (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }).then(handle),
  put: (url, body) => fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }).then(handle),
  patch: (url, body) => fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }).then(handle),
  del: (url) => fetch(url, { method: "DELETE" }).then(handle),
};

/**
 * POST and read a Server-Sent-Events stream. onDelta(text) per chunk; resolves with full text.
 */
export async function stream(url, body, onDelta) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  if (!res.ok) { let msg = res.statusText; try { msg = (await res.json()).error || msg; } catch {} throw new Error(msg); }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const evt = JSON.parse(line.slice(6));
      if (evt.error) throw new Error(evt.error);
      if (evt.delta) { full += evt.delta; onDelta?.(evt.delta, full); }
      if (evt.done) return evt.text ?? full;
    }
  }
  return full;
}

export const media = (projectId, rel) => `/media/${projectId}/${rel.split("/").map(encodeURIComponent).join("/")}`;

export const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = reject;
  r.readAsDataURL(file);
});
