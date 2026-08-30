import OpenAI from "openai";

const apiKey = process.env.VENICE_API_KEY;
if (!apiKey) {
  throw new Error("VENICE_API_KEY is not set. Add it to .env (see .env.example).");
}

export const BASE_URL = "https://api.venice.ai/api/v1";
export const VENICE_MODEL = "zai-org-glm-5-2";

export const venice = new OpenAI({ apiKey, baseURL: BASE_URL });

/** Low-level fetch against the Venice REST API. Returns the Response. */
export async function veniceFetch(path, { method = "GET", body, headers = {}, form } = {}) {
  const init = { method, headers: { Authorization: `Bearer ${apiKey}`, ...headers } };
  if (form) {
    init.body = form;
  } else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return fetch(BASE_URL + path, init);
}

export class VeniceError extends Error {
  constructor(status, detail, path) {
    super(`Venice ${path} -> ${status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    this.status = status;
    this.detail = detail;
  }
}

async function parseBody(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

/** JSON helper: throws VeniceError on non-2xx. */
export async function veniceJson(path, opts) {
  const res = await veniceFetch(path, opts);
  const data = await parseBody(res);
  if (!res.ok) throw new VeniceError(res.status, data, path);
  return { data, headers: res.headers };
}

/** Binary helper: returns { buffer, contentType, headers } or { json } when the API answers JSON. */
export async function veniceBinary(path, opts) {
  const res = await veniceFetch(path, opts);
  const contentType = res.headers.get("content-type") || "";
  if (!res.ok) throw new VeniceError(res.status, await parseBody(res), path);
  if (contentType.includes("application/json")) {
    return { json: await res.json(), contentType, headers: res.headers };
  }
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType, headers: res.headers };
}

// ---- Typed helpers ---------------------------------------------------------

export const listModels = (type = "all") =>
  veniceJson(`/models?type=${encodeURIComponent(type)}`).then((r) => r.data.data);
export const getBalance = () => veniceJson("/billing/balance").then((r) => r.data);

export const imageGenerate = (body) => veniceJson("/image/generate", { method: "POST", body }).then((r) => r.data);
export const imageEdit = (body) => veniceBinary("/image/edit", { method: "POST", body });
export const imageUpscale = (body) => veniceBinary("/image/upscale", { method: "POST", body });

export const videoQuote = (body) => veniceJson("/video/quote", { method: "POST", body }).then((r) => r.data);
export const videoQueue = (body) => veniceJson("/video/queue", { method: "POST", body }).then((r) => r.data);
export const videoRetrieve = (body) => veniceBinary("/video/retrieve", { method: "POST", body });
export const videoComplete = (body) =>
  veniceJson("/video/complete", { method: "POST", body }).then((r) => r.data).catch(() => null);

export const tts = (body) => veniceBinary("/audio/speech", { method: "POST", body });
export const cloneVoice = (form) => veniceJson("/audio/voices", { method: "POST", form }).then((r) => r.data);
