import fs from "node:fs/promises";
import path from "node:path";

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac", ".m4a": "audio/mp4", ".opus": "audio/opus",
  ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json",
};
export const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
export const kindOf = (file) => {
  const m = mimeOf(file);
  return m.startsWith("image/") ? "image" : m.startsWith("video/") ? "video" : m.startsWith("audio/") ? "audio" : "other";
};

/** Read a file as a data: URL (Venice accepts these for all media inputs). */
export async function toDataUrl(absFile) {
  const buf = await fs.readFile(absFile);
  return `data:${mimeOf(absFile)};base64,${buf.toString("base64")}`;
}

/** Save a base64 string (with or without data: prefix) to disk. */
export async function saveBase64(absFile, b64) {
  const clean = b64.replace(/^data:[^;]+;base64,/, "");
  await fs.mkdir(path.dirname(absFile), { recursive: true });
  await fs.writeFile(absFile, Buffer.from(clean, "base64"));
  return absFile;
}

export async function saveBuffer(absFile, buffer) {
  await fs.mkdir(path.dirname(absFile), { recursive: true });
  await fs.writeFile(absFile, buffer);
  return absFile;
}

/** Recursively list files under dir, returning project-relative POSIX paths. */
export async function walk(root, dir = root, out = []) {
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(root, abs, out);
    else if (!e.name.startsWith(".") && e.name !== "assets.json") {
      const st = await fs.stat(abs);
      out.push({ path: path.relative(root, abs).split(path.sep).join("/"), size: st.size, mtime: st.mtimeMs, kind: kindOf(e.name) });
    }
  }
  return out;
}

/** Venice sometimes returns 200 with an empty/tiny video. Threshold by resolution. */
export function minVideoBytes(resolution = "") {
  const r = String(resolution).toLowerCase();
  if (r.includes("4k") || r.includes("2160")) return 400_000;
  if (r.includes("2k") || r.includes("1440")) return 150_000;
  if (r.includes("1080")) return 100_000;
  return 50_000;
}

export const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
