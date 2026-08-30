// Text-model providers. Model ids are namespaced: "venice:claude-sonnet-5", "gemini:gemini-2.5-flash", "openai:gpt-5".
// Un-prefixed ids are treated as Venice for backward compatibility.
import OpenAI from "openai";
import { venice } from "../venice.js";

const PROVIDERS = {
  venice: {
    label: "Venice",
    note: "Billed per token from your Venice credits.",
    paid: true,
    client: () => venice,
    listModels: async () => {
      const { models } = await import("./modelcache.js");
      return (await models("text")).map((m) => ({ id: m.id, name: m.model_spec?.name || m.id }));
    },
  },
  gemini: {
    label: "Gemini (Google AI Studio)",
    note: "Free tier: no charge within Google's rate limits; Google may use free-tier data for training.",
    paid: false,
    key: () => process.env.GEMINI_API_KEY,
    client: () => new OpenAI({ apiKey: process.env.GEMINI_API_KEY, baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" }),
    listModels: async () => {
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": process.env.GEMINI_API_KEY } });
      if (!res.ok) throw new Error(`Gemini models: ${res.status}`);
      const j = await res.json();
      return (j.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent") && /gemini/.test(m.name) && !/embedding|tts|image|audio|vision-latest|exp|computer-use|robotics|live|customtools|deep-research|transcribe/i.test(m.name))
        .map((m) => ({ id: m.name.replace(/^models\//, ""), name: m.displayName || m.name }));
    },
  },
  openai: {
    label: "OpenAI",
    note: "OpenAI API is pay-as-you-go — NOT covered by ChatGPT Plus.",
    paid: true,
    key: () => process.env.OPENAI_API_KEY,
    client: () => new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
    listModels: async () => {
      const c = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const l = await c.models.list();
      return l.data.filter((m) => /^(gpt|o\d)/.test(m.id) && !/audio|realtime|tts|transcribe|image|embedding|moderation|search/.test(m.id)).map((m) => ({ id: m.id, name: m.id }));
    },
  },
};

export function parseModel(id) {
  const [p, ...rest] = String(id || "").split(":");
  if (rest.length && PROVIDERS[p]) return { provider: p, model: rest.join(":") };
  return { provider: "venice", model: id };
}

export function resolve(id) {
  const { provider, model } = parseModel(id);
  const def = PROVIDERS[provider];
  if (def.key && !def.key()) throw Object.assign(new Error(`${def.label} is not configured — add ${provider.toUpperCase()}_API_KEY to .env`), { status: 400 });
  return { provider, model, client: def.client(), paid: def.paid };
}

export function providerStatus() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, note: p.note, paid: p.paid, configured: p.key ? !!p.key() : true }));
}

/** All text models across configured providers, namespaced. */
export async function listAllTextModels() {
  const out = [];
  for (const [id, p] of Object.entries(PROVIDERS)) {
    if (p.key && !p.key()) continue;
    try {
      for (const m of await p.listModels()) out.push({ id: `${id}:${m.id}`, name: m.name, provider: id, providerLabel: p.label, paid: p.paid, type: "text" });
    } catch (e) { console.warn(`[providers] ${id}:`, e.message); }
  }
  return out;
}
