import { resolve } from "./providers.js";

/**
 * Manual mode support:
 *  - opts.dry    → don't call any model; throw DryRun carrying {system,user} so the route responds with the prompt to copy.
 *  - opts.result → skip the model and use this pasted text as the completion.
 */
export class DryRun extends Error {
  constructor(payload) { super("dry-run"); this.dry = payload; }
}

function build({ model, system, user, messages }) {
  const msgs = messages || [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: user },
  ];
  const sys = msgs.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const usr = msgs.filter((m) => m.role !== "system").map((m) => m.content).join("\n\n");
  return { msgs, sys, usr, model };
}

function extra(provider) {
  return provider === "venice" ? { venice_parameters: { include_venice_system_prompt: false } } : {};
}

/** Non-streaming completion. Returns the text. */
export async function complete(opts) {
  const { model, json = false, temperature = 0.7, maxTokens = 8000, dry, result } = opts;
  const { msgs, sys, usr } = build(opts);
  if (dry) throw new DryRun({ model, system: sys, user: usr, json });
  if (typeof result === "string" && result.trim()) return result;
  const r = resolve(model);
  const res = await r.client.chat.completions.create({
    model: r.model, messages: msgs, temperature, max_tokens: maxTokens,
    ...(json ? { response_format: { type: "json_object" } } : {}),
    ...extra(r.provider),
  });
  return res.choices[0]?.message?.content ?? "";
}

/** Completion that must return JSON; tolerant of code fences. */
export async function completeJson(opts) {
  const text = await complete({ ...opts, json: true, temperature: opts.temperature ?? 0.4 });
  return parseJson(text);
}

export function parseJson(text) {
  const t = String(text).trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : t;
  const start = body.search(/[{[]/);
  return JSON.parse(start > 0 ? body.slice(start) : body);
}

/**
 * Stream a completion to an Express response as Server-Sent Events.
 * Events: {delta} chunks, then {done, text}. Resolves with the full text. Supports dry/result like complete().
 */
export async function streamToSse(res, opts) {
  const { model, temperature = 0.7, maxTokens = 12000, dry, result } = opts;
  const { msgs, sys, usr } = build(opts);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  let text = "";
  try {
    if (dry) { send({ dry: true, model, system: sys, user: usr }); send({ done: true, text: "" }); return ""; }
    if (typeof result === "string" && result.trim()) { text = result; send({ delta: result }); send({ done: true, text }); return text; }
    const r = resolve(model);
    const stream = await r.client.chat.completions.create({ model: r.model, messages: msgs, temperature, max_tokens: maxTokens, stream: true, ...extra(r.provider) });
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) { text += delta; send({ delta }); }
    }
    send({ done: true, text });
  } catch (e) {
    send({ error: e.message });
  } finally {
    res.end();
  }
  return text;
}
