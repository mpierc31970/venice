import { venice } from "../venice.js";

/** Non-streaming completion. Returns the text. */
export async function complete({ model, system, user, messages, json = false, temperature = 0.7, maxTokens = 8000 }) {
  const msgs = messages || [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: user },
  ];
  const res = await venice.chat.completions.create({
    model,
    messages: msgs,
    temperature,
    max_tokens: maxTokens,
    ...(json ? { response_format: { type: "json_object" } } : {}),
    venice_parameters: { include_venice_system_prompt: false },
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
 * Events: {delta} chunks, then {done, text}. Resolves with the full text.
 */
export async function streamToSse(res, { model, system, user, messages, temperature = 0.7, maxTokens = 12000 }) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const msgs = messages || [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: user },
  ];
  let text = "";
  try {
    const stream = await venice.chat.completions.create({
      model, messages: msgs, temperature, max_tokens: maxTokens, stream: true,
      venice_parameters: { include_venice_system_prompt: false },
    });
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
