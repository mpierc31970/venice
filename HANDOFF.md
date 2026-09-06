# Handoff — 2026-09-06

Written at the end of a long session. `RESUME.md` still describes the project's shape and
the fixed decisions; this file describes where the work actually stands, and supersedes
`RESUME.md` wherever the two disagree.

## The change of approach

Wan drifts her position and zooms the room over a 30s generation. Three commits tried to
fix that by argument — framing stated geometrically, every camera move negated — and
section 1.0 still drifted. So the room is no longer generated at all.

**Wan now renders her against a flat chroma-key green, 1:1, and Remotion composites the
room back in afterwards.** The background fault cannot happen because there is no
background to go wrong, and once she is keyed her position is measurable rather than
inferred, so it can be corrected.

## Proven, with numbers

A single $1.36 probe clip settled everything that could not be reasoned about:

- **The green keys cleanly.** `chromakey` at similarity 0.06, mid-plateau — 0.01–0.08 all
  keep her intact and remove the screen; 0.10 starts eating her. No fringe in her hair.
- **1:1 480p returns 624×624**, not 480×480 — near-identical pixel count to 832×480, and
  Venice bills total pixels. A square gives her 624 lines instead of 480, ~30% more
  resolution on the subject, for the same $1.36.
- **Normalisation works**: her drift 24px → 6.7px, her width variation 40px → 18.8px.
  Not to zero on purpose — the track is smoothed over half a second first, because
  correcting from the raw measurement trades a slow drift for visible jitter.
- **The whole pipeline renders**, verified end to end with two segments (one full-frame,
  one pip) through the real `buildTimeline` and `render.mjs`.

Artefacts are in `<project>/greentest/` — `raw.mp4` (the green original), `composited.mp4`,
`proof-fullframe.mp4`, `proof-pip.mp4`, `e2e-section.mp4`. That folder is disposable.

## Traps already paid for — do not rediscover these

- **`format=yuva420p` must precede `chromakey`.** Without it there is no alpha plane to
  write into, every filter downstream sees an opaque frame, and masks come back empty with
  no error anywhere.
- **ffmpeg's default vp9 decoder discards alpha.** A keyed WebM written and read back is
  opaque unless you pass `-c:v libvpx-vp9` on the *input*.
- **`<OffthreadVideo>` ignores alpha unless `transparent` is set.** She renders inside an
  opaque rectangle and the console says nothing.
- **The pip circle needs its own background.** A keyed plate is transparent everywhere she
  is not, so masking it to a circle shows what is behind through the gaps and reads as her
  silhouette floating. Fill the disc with the room first, then her, then cut the circle.
- **The ffmpeg bundled in `@remotion/compositor` is a 42-filter build** with no chromakey,
  despill or overlay. `ffmpeg-static` (503 filters) is now a devDependency of `remotion/`.

## What is committed

```
8179ea9  composite the room behind a keyed presenter, and ask Wan for green
862583a  key the presenter off a green screen, and name files so they say what they are
b6463c0  assemble the section video from the page, and survive a flaky compositor
780f6df  a restart mid-upload no longer strands a paid clip, or freezes the page
```

`862583a` and `8179ea9` are **unpushed**. Working tree is clean except
`server/test/sheetstate.check.mjs`, which is Pierce's and has been left untracked all along.

## The immediate next step

**Re-render section 1.0 against green — $10.88, already agreed.** Its eight clips are the
old room takes and are now the only thing standing between here and a real section.

Reset the section first (`POST /section/1.0/reset`, which also clears the sheet's Complete
column), then run it. Use `npm run dev:batch`, not `npm run dev` — the latter runs
`node --watch` and any edit kills a live run.

Balance was **$67.82** at the end of the session.

## The one open question

`plates.mjs` anchors on her **silhouette** — bounding box centre, width, and top. A
silhouette includes hair, and hair moves independently of her face, so this cannot promise
what Pierce actually asked for: *her eyes in the same position consistently*.

The proposed fix is a 68-point face-landmark detector (face-api.js + tfjs, no native build)
sampling every 15th frame, anchoring on **eye midpoint** for position and **inter-ocular
distance** for scale — IOD being rigid where silhouette width is not. About 20–30 minutes
over the whole lesson, cached like the plates, no per-clip money. Everything already built
survives; only the anchor's input changes.

**It is deliberately not built yet.** Silhouette-versus-eyes is a cross-clip problem and we
have one clip. Render section 1.0, measure how far her eyes actually move across eight real
clips, and decide with evidence instead of a guess.

## Also still open

- The eight Wasabi objects and `clips/` files use the old naming and the old room takes;
  re-rendering replaces them.
- `sections/1.0.mp4` (140 MB, room takes) is stale once section 1.0 is re-rendered.
- Remotion's frame extractor intermittently fails with "No frame found at position N" on
  footage that is provably intact — seen once in three attempts. `assemble.js` retries once,
  which is what rescues it; `retried` in the assembly state records when that happens.
