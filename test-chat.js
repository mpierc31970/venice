import { venice, VENICE_MODEL } from "./server/venice.js";

const res = await venice.chat.completions.create({
  model: VENICE_MODEL,
  messages: [{ role: "user", content: "Reply with one short sentence confirming you're working." }],
  max_tokens: 50,
});

console.log("model:", res.model);
console.log("reply:", res.choices[0].message.content);
console.log("usage:", res.usage);
