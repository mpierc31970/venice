// "Claude Code" provider: runs the locally installed `claude` CLI in headless print mode (-p), so calls are
// covered by the user's Claude subscription instead of API credits. Exposes an OpenAI-SDK-shaped client
// ({ chat.completions.create }) so llm.js can use it interchangeably.
import { spawn, spawnSync } from "node:child_process";

let exe = null; // resolved absolute path, or "" when unavailable
export function cliPath() {
  if (exe !== null) return exe;
  try {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf8", timeout: 15000 });
    const first = (r.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).find((l) => !/\.cmd$/i.test(l) || process.platform !== "win32") || "";
    exe = r.status === 0 ? first : "";
  } catch { exe = ""; }
  return exe;
}
export const cliAvailable = () => !!cliPath();

export const MODELS = [
  { id: "sonnet", name: "Claude Sonnet (current)" },
  { id: "opus", name: "Claude Opus (current)" },
  { id: "haiku", name: "Claude Haiku (current)" },
];

async function run({ model, system, user, maxTokens }) {
  const args = ["-p", "--bare", "--no-session-persistence", "--output-format", "json", "--tools", "", "--model", model || "sonnet", "--system-prompt", system || "You are a helpful assistant."];
  const env = { ...process.env }; delete env.CLAUDECODE; // allow nesting when the server itself was launched from Claude Code
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath(), args, { windowsHide: true, env });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", async (code) => {
      if (code !== 0) return reject(new Error(`claude CLI exited ${code}: ${(err || out).slice(0, 400)}`));
      try {
        const j = JSON.parse(out);
        if (j.is_error) return reject(new Error(`claude CLI: ${j.result || "error"}`));
        resolve({ text: j.result ?? "", usage: j.usage, cost: j.total_cost_usd });
      } catch { resolve({ text: out.trim() }); }
    });
    child.stdin.end(user);
  });
}

/** OpenAI-shaped client. Streaming yields the whole answer as a single chunk (the CLI returns at once in json mode). */
export const client = {
  chat: {
    completions: {
      async create({ model, messages, stream, max_tokens, response_format }) {
        const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n") + (response_format?.type === "json_object" ? "\n\nReturn ONLY valid JSON, no prose, no code fences." : "");
        const user = messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n\n");
        const { text } = await run({ model, system, user, maxTokens: max_tokens });
        if (!stream) return { choices: [{ message: { role: "assistant", content: text } }], model };
        return (async function* () { yield { choices: [{ delta: { content: text } }] }; })();
      },
    },
  },
};
