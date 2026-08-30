// "Claude Code" provider: runs the locally installed `claude` CLI in headless print mode (-p), so calls are
// covered by the user's Claude subscription instead of API credits. Exposes an OpenAI-SDK-shaped client
// ({ chat.completions.create }) so llm.js can use it interchangeably.
import { spawn, spawnSync } from "node:child_process";

let exe = null; // resolved absolute path, or "" when unavailable
export function cliPath() {
  if (exe !== null) return exe;
  try {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf8", timeout: 15000 });
    const lines = (r.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    exe = r.status === 0 ? lines.find((l) => process.platform !== "win32" || !/\.cmd$/i.test(l)) || lines[0] || "" : "";
  } catch { exe = ""; }
  return exe;
}
export const cliAvailable = () => !!cliPath();

export const MODELS = [
  { id: "sonnet", name: "Claude Sonnet (current)" },
  { id: "opus", name: "Claude Opus (current)" },
  { id: "haiku", name: "Claude Haiku (current)" },
];

/** Clean environment: drop every CLAUDE* var so the child never thinks it's a nested Claude Code session. */
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDE/i.test(k)) env[k] = v;
  return env;
}

async function run({ model, system, user }) {
  const args = [
    "-p", "--no-session-persistence",
    "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }), // no MCP servers → lean context
    "--tools", "",                                                             // no tools → plain completion
    "--output-format", "json",
    "--model", model || "sonnet",
    "--system-prompt", system || "You are a helpful assistant.",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath(), args, { windowsHide: true, env: cleanEnv() });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      let j = null;
      try { j = JSON.parse(out); } catch {}
      if (j?.is_error || code !== 0) {
        const msg = j?.result || err.trim() || out.trim().slice(0, 300) || `exit ${code}`;
        return reject(Object.assign(new Error(`Claude Code CLI: ${msg}`), { status: 502 }));
      }
      resolve({ text: j ? j.result ?? "" : out.trim(), usage: j?.usage });
    });
    child.stdin.end(user);
  });
}

/** OpenAI-shaped client. Streaming yields the whole answer as a single chunk (json mode returns at once). */
export const client = {
  chat: {
    completions: {
      async create({ model, messages, stream, response_format }) {
        const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n")
          + (response_format?.type === "json_object" ? "\n\nReturn ONLY valid JSON, no prose, no code fences." : "")
          + "\n\nAnswer directly with the requested content only — no greetings, no offers of help.";
        const user = messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n\n");
        const { text } = await run({ model, system, user });
        if (!stream) return { choices: [{ message: { role: "assistant", content: text } }], model };
        return (async function* () { yield { choices: [{ delta: { content: text } }] }; })();
      },
    },
  },
};
