import { listModels } from "../venice.js";

const TTL = 10 * 60 * 1000;
const cache = new Map(); // type -> { at, data }

export async function models(type = "all", force = false) {
  const hit = cache.get(type);
  if (!force && hit && Date.now() - hit.at < TTL) return hit.data;
  const data = await listModels(type);
  cache.set(type, { at: Date.now(), data });
  return data;
}

export async function model(id) {
  const all = await models("all");
  return all.find((m) => m.id === id) || null;
}

/** Normalised model summary for the UI. */
export function summarize(m) {
  const s = m.model_spec || {};
  return {
    id: m.id,
    name: s.name || m.id,
    type: m.type,
    privacy: s.privacy,
    traits: s.traits || [],
    sets: s.model_sets || [],
    pricing: s.pricing || null,
    constraints: s.constraints || {},
    capabilities: s.capabilities || null,
    voices: s.voices || null,
    supportsCustomVoiceId: s.supports_custom_voice_id || false,
    voiceCloning: s.voice_cloning || null,
    formats: s.supported_formats || null,
    defaultFormat: s.default_format || null,
  };
}

export function durationsFor(m) {
  const d = m?.model_spec?.constraints?.durations;
  return Array.isArray(d) ? d : [];
}
