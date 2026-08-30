import { venice, VENICE_MODEL } from "./venice.js";

const stream = await venice.chat.completions.create({
  model: VENICE_MODEL,
  messages: [{ role: "user", content: "Write a haiku about the sea." }],
  stream: true,
});

for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta?.content;
  if (delta) process.stdout.write(delta);
}
process.stdout.write("\n");
