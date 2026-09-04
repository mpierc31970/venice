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
- Assets: `D:\Business\Mona\CEU_Teaching\avatar.png` (4-panel contact sheet, 1672x941),
  `videoBackground.png` (spa room, 1672x941). Both go in whole, unmodified.

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

   Next, and **not yet run**: **one 27s row (~$1.36) — segment 1.17**, a 27s script in a 30s
   clip with no Visual, i.e. a real 3-second tail. Not row 1.1: that is 30s in 30s, zero
   tail, so it cannot exercise the thing that actually goes wrong. Then **one whole section
   1.0 (~$10.88)**, stitched and watched, before anything else.

**Nothing has been rendered. Nothing has been spent.** The sheet *is* now imported to disk
(`rows.json`, 109 rows) and `avatar.png` / `background.png` are copied into the project dir.

⚠️ **The $10 credit floor costs a section.** Live budget: $147.14 outstanding, and $92.30
reaches sections **1.0–1.3 ($70.50)**, not 1.0–1.4. The plan's "$88.18, five sections"
ignored the floor — $88.18 + $10 is $98.18, over the balance. Dropping the floor to $4 or
less would fit section 1.4; leaving it at $10 stops a section earlier, on purpose.

Live per-section cost, confirmed against `/video/quote`, matches the plan exactly:
`[10.88, 20.18, 16.32, 23.12, 17.68, 16.32, 12.72, 17.68, 12.24]`.

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

```
remotion/
  src/Root.tsx            one <Composition> per section
  src/Section.tsx         <Series> of segments, cut at trimAfter
  src/Segment.tsx         one segment: talking head, full-frame or PiP
  src/visuals/            the graphic components
```

`timeline/<section>.json` is the seam and already exists — `writeTimeline` fires the moment
every row in a section is rendered. It carries `trimAfter` per segment so the snap-up
padding is cut at assembly rather than reaching the viewer.

**Still open:** what says a segment is full-frame vs PiP and which graphic shows. The sheet
has prose Visual text on 11 of 109 rows, and Wan is never told about it.

**Not yet started, and can be verified without spending anything** — Remotion can render
its own test clips (solid colours with a burned-in frame counter), so the stitching and the
trim points can be proven before a single Venice clip exists.

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
