// Stage 2, driven from the page: turn timeline/<section>.json into sections/<section>.mp4.
//
// This spawns `remotion/render.mjs` rather than importing Remotion, for three reasons and
// none of them is taste:
//
//  1. Remotion is a separate workspace with its own dependency tree. The API server does
//     not have those packages and should not grow them.
//  2. A render boots a headless Chromium. Carrying that inside the API process puts the
//     thing that answers requests and the thing that eats a gigabyte in the same memory
//     budget, and the loser is decided by the OS.
//  3. A render that dies takes only itself with it.
//
// Nothing here costs money — assembly reads clips that are already paid for — so failure
// handling is deliberately blunt: retry once, report, and let someone press the button
// again.
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { exists, P } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REMOTION_DIR = path.join(here, "..", "..", "remotion");

// One retry, not five. The fault this exists for is a transient miss inside Remotion's
// frame extractor — it copies each clip to a fresh temp directory per process, and a
// second process gets a clean extraction, which is why a straight re-run succeeds. A
// deterministic failure fails identically twice and costs four wasted minutes to prove
// it, which is the price of not making someone re-press a button for a coin flip.
const ATTEMPTS = 2;

const runs = new Map(); // dir -> state

/**
 * The most informative line the renderer said.
 *
 * Not simply the last one: a crashed node process signs off with its own version banner,
 * so "render exited 1 — Node.js v20.20.2" is what naively taking the tail produces, and it
 * tells you nothing at all. Prefer the first line that actually names an error, and fall
 * back to the last line that is not a stack frame, a backtrace index or that banner.
 */
const NOISE = /^(Node\.js v|at\s|\d+:\s|\^+$|\.\.\.)/;
function saidWhat(text) {
  const lines = String(text)
    .replace(/\[[0-9;]*m/g, "")
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const named = lines.find((l) => /error|cannot|failed|must agree|not found/i.test(l) && !NOISE.test(l));
  const last = [...lines].reverse().find((l) => !NOISE.test(l));
  return (named || last || "").slice(0, 300);
}

/** Run state without the child handle — this is what the API serialises. */
export function assembleState(dir) {
  const r = runs.get(dir);
  if (!r) return { running: false };
  const { child, ...rest } = r;
  return rest;
}

/** One spawn. Resolves with how it ended; never rejects. */
function spawnOnce(state, { dir, sectionId, script, node }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; delete state.child; resolve(result); } };

    // VENICE_PROJECT_DIR is pinned rather than left to the registry: render.mjs otherwise
    // falls back to the registry's *first* project, which is the wrong film rendered into
    // the wrong folder on a machine with more than one.
    const child = spawn(node, [script || path.join(REMOTION_DIR, "render.mjs"), sectionId], {
      cwd: REMOTION_DIR,
      windowsHide: true,
      env: { ...process.env, VENICE_PROJECT_DIR: dir },
    });
    state.child = child;

    // render.mjs draws its progress with \r and no newline, so this reads whatever chunk
    // arrives and keeps the last percentage in it.
    const take = (buf) => {
      const text = String(buf);
      state.output = (state.output + text).slice(-6000);
      const found = [...text.matchAll(/(\d{1,3})\s*%/g)];
      if (found.length) state.percent = Math.min(100, Number(found[found.length - 1][1]));
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);

    // Spawn itself failed — no node, no script, no permission.
    child.on("error", (e) => done({ ok: false, message: e.message }));
    child.on("close", (code) => {
      if (code === 0) return done({ ok: true });
      const said = saidWhat(state.output);
      done({ ok: false, message: `render exited ${code}${said ? ` — ${said}` : ""}` });
    });
  });
}

async function drive(state, cfg) {
  for (let attempt = 1; attempt <= cfg.attempts; attempt++) {
    state.attempt = attempt;
    state.percent = 0;
    const result = await spawnOnce(state, cfg);

    if (result.ok) {
      state.percent = 100;
      state.error = null;
      break;
    }
    if (attempt < cfg.attempts) {
      // Keep the failed attempt in the log. A retry that succeeds still happened, and the
      // first error is the evidence if this stops being an occasional flake.
      state.output += `\n[assemble] attempt ${attempt} failed: ${result.message} — retrying\n`;
      state.retried = true;
      continue;
    }
    // The last attempt's message, not the first: two different errors mean the second one
    // is the more recent truth, and every earlier one is still in the output.
    state.error = cfg.attempts > 1 ? `${result.message} (failed ${cfg.attempts} attempts)` : result.message;
    state.percent = 0;
  }

  state.running = false;
  state.finishedAt = new Date().toISOString();
}

/**
 * Start assembling one section. Returns immediately; poll `assembleState(dir)`.
 *
 * `script`, `node` and `attempts` exist so the tests can drive the whole state machine
 * against a stub that prints the same shape of output in a second, instead of running a
 * real render.
 */
export async function assemble(dir, sectionId, { script = null, node = process.execPath, attempts = ATTEMPTS } = {}) {
  const live = runs.get(dir);
  if (live?.running) throw new Error(`An assembly is already running for this folder (section ${live.section})`);
  if (!(await exists(P.timeline(dir, sectionId)))) {
    throw new Error(`No timeline for section ${sectionId} — build the timeline first`);
  }

  const state = {
    running: true, section: sectionId, percent: 0,
    attempt: 1, attempts, retried: false,
    startedAt: new Date().toISOString(), finishedAt: null, error: null, output: "",
  };
  runs.set(dir, state);

  // Deliberately not awaited: the caller gets the state back now and polls for the rest.
  drive(state, { dir, sectionId, script, node, attempts }).catch((e) => {
    state.error = e.message;
    state.running = false;
    state.finishedAt = new Date().toISOString();
  });

  return assembleState(dir);
}
