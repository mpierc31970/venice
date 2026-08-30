# Venice Studio

A local, step-by-step studio for making AI films with the [Venice.ai](https://venice.ai) API, following the
"story bible" method from Venice's filmmaking tutorials: lock the canon first, generate identity references
before anything else, and derive every script, keyframe, clip and line of dialogue from that one locked source.

Image generation/editing, 120+ video models, and 11 TTS engines run through `VENICE_API_KEY`. Writing can use
**Claude Code on your existing subscription** (the local `claude` CLI, $0 API cost — the default), Claude via Venice,
Gemini's free tier, or OpenAI — or *manual mode*: copy the prompt into ChatGPT/Gemini and paste the answer back.

## Run it

```bash
npm install
cp .env.example .env         # put your VENICE_API_KEY in .env
npm run dev                  # API on :3939, UI on http://localhost:5173
```

Production-style (single port): `npm run build && npm start` → http://localhost:3939

## The nine steps

1. **Project setup** — title, logline, default text/image/edit/video/TTS models (lists come live from `/models`).
2. **Story bible** — Claude writes the bible (pitch, world, locations, cast with identity fingerprints and
   *verbatim descriptions*, aesthetic + palette + prohibitions, hard negatives, official world seed). Extract turns
   it into `world-seed.md` and element records.
3. **Characters & references** — per element: identity board → pick one face → derive 45° / profile / ¾ rear with
   `/image/edit` using the identical description → QA checklist → lock. Assign a voice (or clone one).
   Includes an image-model bake-off (one prompt across models, pick by taste).
4. **Scene assets** (optional) — drop plates/props/style refs into `<project>/assets/`, tag them.
5. **Script & shot list** — screenplay → scenes (mood, dialogue) → AI-optimized shot lists whose durations match
   the chosen video model's ladder.
6. **Keyframes** — Claude composes the still prompt from world seed + verbatim descriptions; generate, pick, lock.
7. **Render clips** — Claude composes the `@Element` video prompt; `/video/quote` before every `/video/queue`;
   background poller collects the mp4 (with a tiny-file guard). Re-roll with identical provenance.
8. **Dialogue audio** — every line rendered in its character's voice.
9. **Library** — everything on disk, ready for your editor.

Every prompt/description field has **✦ Improve with Claude**, which rewrites using the project's canon.
The top-bar balance chip turns amber/red under thresholds you set in Settings.

## Layout

- `server/` — Express API. `venice.js` (client), `lib/` (prompts, canon, jobs, media, model cache), `routes/`.
- `web/` — React + Vite UI.
- `server/scripts/smoke-pipeline.mjs <projectId>` — runs screenplay → shot list → keyframe → quote on a project.
- Projects live in any folder you choose; the registry is at `~/.venice-studio/registry.json`.
