# Resume point — talking-head batch renderer

Written 2026-09-03. Approved plan: `C:\Users\guypa\.claude\plans\so-i-have-found-linear-hippo.md`

## What this is

Venice Studio has been repurposed. The nine-step "story bible" film pipeline's UI is
deleted (its server routes remain; git has the views). The actual job: render a narrated
CEU course lesson as talking-head clips, stitch them into section videos, push to Wasabi.

## Ground truth

**Source of truth is a Google Sheet**, not the xlsx. Read via its CSV export; written
via the Sheets API with a service account.

- Sheet: `https://docs.google.com/spreadsheets/d/1MtNI8HK22aQnKGtARFBs9sFZWFKMSRUEtKRSm_4ZuU8/edit`
  (title `Lesson1-Scripts`, one tab `Lesson 1`)
- Columns: `Lesson - Section | Production Segment | Timing - Words | Visual | Script | Complete`
- 109 segments, ids `1.1`–`1.109`, unique. 11 rows carry a Visual. Nothing marked Complete yet.
- Assets: `avatar.png` (single headshot, 849x849, square to match the 1:1 aspect),
  `videoBackground.png` (spa room, 1672x941). Both go in whole, unmodified. The avatar was
  a 4-panel contact sheet (1672x941) until 2026-09-09; the sheet is kept beside it as
  `avatar.4panel-sheet.backup.png`.

**Structure is Lesson → Section → Segment.** Column A is the grouping key: walking rows in
sheet order, a change in column A starts the next video. 9 sections, sizes
`[8,15,12,17,13,12,10,13,9]`. Sections are contiguous — asserted on import.

⚠️ **Section ids and segment ids collide.** `"1.1"` is Section 1.1 *and* Production Segment 1.1.
Segment 1.1 is in section **1.0**; section 1.1 spans segments **1.9–1.23**. Never build one flat
id→row index. Keep route namespaces separate (`/section/:sectionId` vs `/row/:rowId`).

**Segments exist only because Wan caps at 30s.** A section is one continuous piece of narration
chopped to fit, so every join is mid-sentence. Continuity across cuts is the biggest content risk.

## Fixed decisions

| | |
|---|---|
| model | `wan-3-0-reference-to-video` ("Wan 3.0 Reference") |
| aspect / resolution / audio | `16:9` / `480p` / `true` |
| framing | talking head, medium close-up, head and shoulders, centered, fixed camera |
| duration | from the sheet, **snapped UP** to `[2,5,10,15,20,25,30]s`; never down |
| images | `reference_image_urls: [avatar, background]` — flat, so they are `@image1`/`@image2` |
| concurrency | 1, strictly sequential |
| order | section at a time, in sheet order; stop *between* sections |
| credit floor | stop when `balance < quote + $10` |
| local mp4 | kept as well as uploaded |
| Complete column | a marked row never enters production, whatever our state says |

**Verified prices** (live `/video/quote`, free): 30s = **$1.36**, 25s = $1.14, 20s = $0.91.
Full lesson = **$147.14** / 54:05. Per section:
`[10.88, 20.18, 16.32, 23.12, 17.68, 16.32, 12.72, 17.68, 12.24]`.
Balance was **$92.30** → completes sections 1.0–1.4 ($88.18), 5 of 9 videos. Needs ~$59 more.

**Wan has no selectable voice** (`voices: null`, `supportsCustomVoiceId: false`,
`audio_input: false`). Voice consistency across 109 clips is unproven — check an early and a
late clip before the full run.

## Done so far

- `server/lib/sheet.js` — Google Sheet CSV → rows. `fetchSheet`, `parseCsv`, `rowsFromSheet`,
  `groupSections`, `snapUp`, `isComplete`, `mapColumns`, `sectionSeconds`.
- `server/lib/gsheets.js` — Sheets API via service account (JWT bearer, no deps).
  `getValues`, `setValues`, `setCells`, `describe`, `colLetter`, `quoteTab`, `status`.
- `server/test/sheet.test.mjs` — 38 assertions against the live sheet. `npm run test:sheet`.
- `server/test/gsheets.check.mjs` — read+write connectivity probe.
  `node --env-file=.env server/test/gsheets.check.mjs`.
- `server/lib/batch.js` — settings, the rows.json manifest (with the same per-dir lock
  `jobs.js` takes), sheet import/merge, prompt building, the section-ordered run loop and
  `buildTimeline`. `start()` is the only door in; nothing runs on import or server boot.
- `server/routes/batch.js` — mounted at `/api/projects/:id/batch/*`. Only `POST /run`
  (without `dryRun`) and `POST /row/:id/render` cost money.
- `web/src/views/Batch.jsx` — the whole interface, one page.
- `remotion/` — stage 2, the assembler. See **Stage 2 — Remotion is the master** below.
- `server/test/batch.test.mjs` — 43 assertions. `npm run test:batch`.
- `.env` gained `GOOGLE_SERVICE_ACCOUNT_KEY` and `SHEET_URL`, then `WASABI_ACCESS_KEY`
  and `WASABI_BUCKET` (`acelerace-bucket`). **`WASABI_SECRET_KEY` and `WASABI_REGION` are
  still blank** — that is what blocks step 2.
- `@aws-sdk/client-s3` installed. **`exceljs` was installed then removed** — it cannot read the
  original xlsx (that file uses `x:`-prefixed OOXML tags; ExcelJS only parses the unprefixed
  dialect and returns `undefined` for the sheet list). Moot now the Sheet is the source.

**All green as of this writing:**
```
npm run test:sheet                                   PASS (38 assertions)
npm run test:batch                                   PASS (43 assertions)
npm run test:jobs                                    PASS (no jobs lost)
node --env-file=.env server/test/gsheets.check.mjs   READ OK / WRITE OK
```

**Verification gate 1 passed live, $0, nothing committed to disk** — `POST /batch/import`
returned 109 rows, 9 sections sized `[8,15,12,17,13,12,10,13,9]`, durations
`{30s: 104, 25s: 5}`, section `1.1` spanning segments `1.9`–`1.23` while segment `1.1`
sits in section `1.0`, ids unique, 0 warnings.

Google write-back is **confirmed working** — service account
`matthewapierce@mpierce1970.iam.gserviceaccount.com`, project `mpierce1970`, sheet shared as
Editor, Sheets API enabled. So the runner can tick `Complete` itself as each segment lands.

## Next steps, in order

1. ~~`server/lib/batch.js`~~ — **done.**
2. ~~`server/lib/wasabi.js`~~ — **done and proven live.** Bucket `acelerace-bucket`,
   prefix `lesson1`, region **`us-central-1`** (discovered from the bucket, not guessed —
   so the endpoint is `s3.us-central-1.wasabisys.com`, *not* the `us-east-1` special case).
   `npm run check:wasabi` round-trips a 1 KB object and deletes it. A 403 is never retried
   and halts the run on the spot.
3. ~~`server/routes/batch.js`~~ — **done**, mounted in the `ROUTERS` map.
4. ~~`web/src/views/Batch.jsx`~~ — **done.** The nine-step pipeline UI was deleted, not
   hidden: seven views, the rail, `ProjectProvider`, `StepHead`, `ImproveField`,
   `ModelPicker` and manual mode are gone. The server routes stay — `jobs.js` is what the
   runner enqueues through. Projects now land on `/b/:id`.
5. **Verification gates** — gates 1–3 **passed, $0 spent**:
   - *parser* — 109 rows, sections `[8,15,12,17,13,12,10,13,9]`, the id collision handled.
   - *prompt* — 0 placeholders left, script verbatim in all 109, stop instruction in all 109,
     677–838 chars against a 20,000 limit. Measured tail: `{0s:21, 1s:26, 2s:34, 3s:24, 4s:4}`
     — **88 of 109 clips carry 1–4s of tail**, confirming the estimate from real data.
   - *Wasabi* — 1 KB object written, headed and deleted at `lesson1/.healthcheck.txt`.

   Gate 4 — **section 1.0 was run once, ~$10.88, and has been reset to run again.** The
   first take is still on disk at `clips/1.0/1.1.mp4` … `1.8.mp4`, and `sections/1.0.mp4`
   is the assembly of it. Watching it found the real problem, and it was not the assembly:
   **Wan's framing drifts between clips.** The camera pushes in on some, the background
   sits at a different scale on others, and she is a different size in the frame from one
   clip to the next — so a cut that should read as one continuous take reads as a mistake.
   See **The prompt, rewritten** below. All 8 rows are `pending` again and the sheet's
   Complete marks are cleared; re-running costs the section a second time (~$10.88).

⚠️ **The $10 credit floor costs a section.** Live budget: $147.14 outstanding, and $92.30
reaches sections **1.0–1.3 ($70.50)**, not 1.0–1.4. The plan's "$88.18, five sections"
ignored the floor — $88.18 + $10 is $98.18, over the balance. Dropping the floor to $4 or
less would fit section 1.4; leaving it at $10 stops a section earlier, on purpose.

Live per-section cost, confirmed against `/video/quote`, matches the plan exactly:
`[10.88, 20.18, 16.32, 23.12, 17.68, 16.32, 12.72, 17.68, 12.24]`.

## The prompt, rewritten (2026-09-04)

Watching section 1.0 found the thing that actually breaks the illusion, and it is not in
the assembly. **Wan reframes the shot between clips.** The camera pushes in on some, the
background sits at a different scale on others, and she is a different size in frame from
one clip to the next. A section is 8–17 independent generations that have to read as one
take, and the only thing carrying framing across them is the prompt text.

The old prompt said "medium close-up … head and shoulders … fixed camera, no camera
movement". That is an *interpretation*, and Wan interpreted it differently every time. The
new one states the composition geometrically instead — where the top of her head sits, where
her chin sits, what fills the lower corners — plus absolute lines for the camera ("no zoom
in, no zoom out, no push in, no pull back…") and for the background ("exactly as given,
filling the frame edge to edge at its own scale and its own framing; nothing in it moves").
The negative prompt names each camera move individually rather than relying on the category
"camera movement". `PROMPT_TEMPLATE` and `NEGATIVE_PROMPT` in `server/lib/batch.js`, and
**also written into `batch.json`** — a saved setting outranks the default, so changing the
code alone would have left the old prompt in production.

⚠️ **Untested. It has not rendered a single clip yet.** Render *one* row before the section
— 1.17 is still the right one (a 27s script in a 30s clip, so it exercises the tail) — and
put its first and last frame side by side.

**The avatar lever has since been pulled, and it worked.** Section 1.1 rendered against
the four-panel sheet and drifted exactly as predicted: x held to ±0.6% of frame width,
but shot size ranged 0.90x to 1.14x across fifteen clips, because the model was choosing
among four framings before it started. `avatar.png` is now a single 849x849 headshot, and
fifteen fresh generations against it spread **1.036x** — a 26% variation reduced to 3.6%.
The prompt rewrite that was queued behind this turned out not to be needed; only the
headroom line changed, and only to match the new reference.

Expect roughly **one bad draw in fifteen** rather than continuous drift. 1.21 came back a
much closer shot and was re-rendered for $1.56. Check a new section the same way: per-clip
`track` against the section `target` in `plates/<section>.json`.

## Before rendering a section that has never been rendered

Only 1.1 has been through the fixed pipeline. Sections 1.2 onward were scripted to the
same optimistic timings and have not been checked.

**Do not pre-emptively rewrite by word count.** Wan's delivery varies **1.94–2.32 words a
second** between generations of the same length, measured across section 1.1, so the count
does not predict an overrun. Ten rows of 60–66 words all finished inside 30s, worst ending
29.45s; the one row that overran was 63 words, shorter than most that fitted. 56 words is
what fits even at the slowest rate ever seen — a guarantee, not a threshold, and treating
it as one means rewriting nearly every script, since 1.2's twelve rows are all 60–66 words
exactly like 1.1's.

**Detect instead.** `server/lib/speech.js` measures every clip, so an overrun shows up as
speech reaching the clip's own end — where no trim helps, because 30s is the top of Wan's
duration ladder. Render the section as written, then compare each row's `endsAt` in
`speech/<section>.json` against its clip length and cut only the rows that actually hit it.
Expect roughly one in fifteen, at $1.56 each, against rewriting a dozen pieces of regulated
teaching content by hand.

Everything else rides along on its own — the avatar and prompt live in `batch.json`
settings rather than per-section state, and each trim is placed by the measurement. Sanity
check afterwards: measured speech end against `trimAfter` in `timeline/<section>.json`
should differ by `SPEECH_PAD_S` and nothing more, and the captions should span
`startsAt`–`endsAt` rather than starting at frame zero.

**Resetting a section** is `POST /api/projects/:id/batch/section/:id/reset`, or the *Reset*
button in the section footer. It puts every row back to `pending`, clears the sheet's
Complete marks (they outrank local state, so a row left marked could never run again) and
**deletes nothing** — `preserveExisting` moves each old clip aside as its replacement
lands, so the take you paid for survives the take that replaces it.

## Stage 2 — Remotion is the master

**Decided 2026-09-03.** Remotion does the work: it reads `timeline/<section>.json`, stitches
the segments at their trim points, carries the transitions and the generated graphics, and
renders `sections/<section>.mp4`. Remotion Studio *is* the timeline — do not build one.
Licensing is free: the licence only charges above three people, and this is one.

**The handoff to Premiere is the finished flat file.** `sections/<section>.mp4` is dragged
straight in — no XML involved, graphics baked in. Chosen over a layered handoff (clips on
V1, graphics as alpha overlays on V2) with that trade understood: once it is a flat file
the graphics cannot be moved or retimed in Premiere, and a change means re-rendering from
Remotion. That is fine, because re-rendering from Remotion is free and repeatable.

So **do not build**: alpha-channel overlay renders, a second video track in the XML, an XML
importer, or any sync between the two tools. Remotion is where graphics get changed.

`timeline/<section>.xml` (FCP7 xmeml, `server/lib/premiere.js`) still exists, unchanged, as
a separate escape hatch: it points at the **raw** trimmed clips, with no graphics and no
PiP, for the case where a section wants cutting from scratch. It is deliberately not kept
in step with what Remotion produces, and there is no round-trip — an edit made in Premiere
stays in Premiere. That is the whole reason the design is simple: nothing has to reconcile.

**Built 2026-09-04.** It is a standalone npm project, not a workspace — Remotion wants
React 19 and `web/` is on 18, so keeping its own `node_modules` avoids a hoist fight.

```
remotion/
  project-dir.mjs         resolves the project dir (VENICE_PROJECT_DIR, else the registry)
  remotion.config.ts      publicDir = the project dir; Studio serves it directly
  focus.mjs               measures where the presenter is -> focus/<s>.json
  render.mjs              timeline/<s>.json -> sections/<s>.mp4, bundling once for all
  src/Root.tsx            one <Composition> per timeline found on disk
  src/Section.tsx         <TransitionSeries> of segments, cut at trimAfter
  src/Segment.tsx         one segment: talking head, full-frame or PiP
  src/Captions.tsx        the subtitle band
  src/Slide.tsx           the emphasis card
  src/visuals/Diagram.tsx list / sequence / comparison / points
  src/timeline.ts         the shape of timeline/<s>.json — the only place that knows it
  src/theme.ts            one palette, one font stack
```

The project directory **is** the public dir, so nothing is imported or kept in step:
`staticFile("clips/1.0/1.4.mp4")` reads the clip the runner wrote. Two consequences —
`remotion studio` lists every section that has a timeline, with no configuration; and
`bundle()` copies the public dir on each invocation of `render.mjs` (106 MB at section
1.0, ~1.4 GB once all 109 clips exist). That is one copy per invocation, not per section,
which is why `render.mjs` bundles once and loops.

`focus/<section>.json` is the second seam, and the only thing Remotion writes: segment id
→ where the presenter actually is in that clip, as a fraction of the frame. It is measured
from the clip itself — the centroid of what moves against a still background is, on a
fixed camera, her — using the ffmpeg that ships inside Remotion's compositor package. No
model, no face detection. Only pip segments are measured, results are cached, and a
missing entry means centred, so nothing breaks if the file is deleted. `render.mjs` fills
in anything missing before it bundles; `node remotion/focus.mjs` does it on its own if you
want Studio to be right before rendering.

Run it:

```
npm run remotion             # Studio — the timeline, and where graphics get changed
node remotion/render.mjs     # every section that has a timeline
node remotion/render.mjs 1.0 # just that one
node remotion/focus.mjs      # re-measure the PiP framing, without rendering
```

`POST /api/projects/:id/batch/section/:id/timeline` rewrites a `timeline/<s>.json` in
place — free and repeatable, and how a rule change like the one above reaches a section
that has already finished.

`timeline/<section>.json` is the seam and already exists — `writeTimeline` fires the moment
every row in a section is rendered. It carries `trimAfter` per segment so the snap-up
padding is cut at assembly rather than reaching the viewer.

### Fixed rules for Remotion (from the user, 2026-09-03)

1. **PiP avatar: a circle in the lower right.** Stated twice by the user, so treat it as
   hard: **no animation of any kind.** No zoom, no scale-up, no spring, no fade, no slide,
   no drift, no breathing. It is absent, and on the next frame it is present — the same
   size in the same place, every time. The idiomatic Remotion component springs it in;
   that is exactly what must not happen here. Carried as data on every timeline:
   `avatar.motion: "none"`, `avatar.transition: "cut"`, and asserted in the tests.
2. **Not PiP means full screen.** There is no third layout.
3. **Subtitles on every segment**, verbatim from the Script column.
4. **Straight cut at every join. No dissolve** (user, 2026-09-04). This replaced a 6-frame
   cross-dissolve that had been argued for as a way to soften the position jump between
   two independent generations of the same person. The answer was no dissolve, so there
   is none — `timeline.transition` is `{ kind: "cut", frames: 0 }`, `durationInFrames` is
   the plain sum of the trimmed segments, and both are asserted in the tests. Do not
   reintroduce one as a "fix" for a jumpy join; the jump is a content problem.
5. **The PiP avatar is centred on the presenter, not on the frame** (user, 2026-09-04).
   Wan frames each clip independently and it drifts: across section 1.0 she sits at
   x = 0.49 in seven clips and **x = 0.41 in 1.4**, which is invisible full frame and
   reads as a badly placed avatar once cropped to a circle a quarter of the screen wide.
   The circle's own position — lower right, fixed size — was right and did not change.

### What is on screen, and where it comes from

- **Layout** — `r.visual ? "pip" : "full"`. The sheet's Visual column already chose: 11 of
  109 rows, one or two per section, none in 1.8. `pip` means the *graphic* takes the frame
  and the avatar shrinks to its circle — the notes describe comparisons, workflows and
  decision guides, which are unreadable in a corner at this resolution.
- **Subtitles** — `captionsFor()` in `server/lib/slides.js`, chunked to ~42 characters and
  timed proportionally across the **scripted** seconds, not the clip: the tail is silence,
  and captions spread over it drift later and later against the speech. Frame-accurate
  timing later via `@remotion/install-whisper-cpp`, but **the words stay from the script** —
  a transcript of a mispronunciation must not become the on-screen text of a CEU course.
- **Emphasis slides** — `slideFor()`, 14 across the lesson, 1–3 per section, none where a
  diagram already sits. Picks a normative sentence (`must`/`required`/`never`), 30–95
  characters, self-contained (no back-references), and never two segments in a row.

⚠️ **Everything on screen is lifted verbatim. Nothing is paraphrased or completed.** This
is a Chapter 83 CEU lesson students are examined on; text on screen reads as more
authoritative than narration, and the scripts deliberately withhold specifics — 1.18 names
the three bleach-solution categories then says "each has a specific concentration and
exposure time in the rule" without stating them. A helpful paraphrase filling those in
would put a regulatory claim on screen that the script's author chose not to make.

**Still open:** what the 11 diagrams actually *look like*. The sheet gives prose only
("Chapter 83 bleach-solution categories by purpose"); nothing says the categories, layout
or styling, and inventing them is exactly the risk above. Wan is never told about any of it.

**Section 1.0 is rendered and stitched** — `sections/1.0.mp4`, 1920x1080, 7164 frames /
238.8s, h264 + aac, from the 8 clips at `clips/1.0/`. The arithmetic is asserted before
every render rather than eyeballed: composition length, `timeline.durationInFrames` and
(sum of `trimAfter`) − `transition.frames` × joins must all agree, and `render.mjs`
refuses the render if they do not. 8 × 30.02s of raw clip comes out as 238.8s, so the
trims are really happening.

Watched: the full-frame layout and the PiP layout both read correctly, and the circle cuts
in with no motion. **Not yet watched end to end by a human** — that is the next thing, and
it is the point of gate 4: whether the voice holds across eight independent generations,
and whether the mid-sentence joins survive a 6-frame dissolve.

## Environment notes

- `npm run dev` runs `node --watch`; every server edit restarts it. For a real multi-hour run use
  `npm start -w server`.
- Dev servers are running and responding: API `http://localhost:3939`, UI `http://localhost:5173`
  (both verified HTTP 200 after the session restart). They are **detached** — they outlived the
  session that started them, so no agent task tracks them any more. To stop them, kill by PID
  (`Get-NetTCPConnection -LocalPort 3939 -State Listen` gives the owning process) rather than
  expecting a task-stop to work.
- Ports 3939/5173/5174 had stale processes from Aug 29–30 that were killed; one of them
  (`5173`) belonged to a different project, `~/spiritual-empowerments`.
- Nothing here is committed yet — `git status` shows the new files untracked.
