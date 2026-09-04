# Resume point — talking-head batch renderer

Written 2026-09-03. Approved plan: `C:\Users\guypa\.claude\plans\so-i-have-found-linear-hippo.md`

## What this is

Venice Studio is being repurposed. The nine-step "story bible" film pipeline is not
being used (and not deleted). The actual job: render a narrated CEU course lesson as
talking-head clips, stitch them into section videos, push to Wasabi.

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
- `.env` gained `GOOGLE_SERVICE_ACCOUNT_KEY` and `SHEET_URL`.
- `@aws-sdk/client-s3` installed. **`exceljs` was installed then removed** — it cannot read the
  original xlsx (that file uses `x:`-prefixed OOXML tags; ExcelJS only parses the unprefixed
  dialect and returns `undefined` for the sheet list). Moot now the Sheet is the source.

**All green as of this writing:**
```
npm run test:sheet                                   PASS (38 assertions)
npm run test:jobs                                    PASS (no jobs lost)
node --env-file=.env server/test/gsheets.check.mjs   READ OK / WRITE OK
```

Google write-back is **confirmed working** — service account
`matthewapierce@mpierce1970.iam.gserviceaccount.com`, project `mpierce1970`, sheet shared as
Editor, Sheets API enabled. So the runner can tick `Complete` itself as each segment lands.

## Next steps, in order

1. **`server/lib/batch.js`** — state + section-ordered run loop + prompt building.
   - `withBatch(dir, fn)` / `patchRow(dir, id, mutate)`: copy the promise-chain lock from
     `server/lib/jobs.js:21-40`. The batch file is rewritten whole, same hazard `jobs.json` had.
   - Loop: for each section → whole-section budget check → per row: quote → balance →
     `enqueue` ONE job → await terminal → upload → mark Complete in the sheet.
   - `onJobDone` (`jobs.js:110`) is **global across all projects** — early-return unless
     `job.meta?.batchId`, mirroring `shots.js:250`.
   - Reuse: `enqueue` (`jobs.js:48`, `outFile` must be absolute), `videoQuote`/`getBalance`
     (`venice.js:66,61`), `toDataUrl`/`saveBuffer`/`stamp` (`media.js`).
   - Cache the two image data URLs in memory — 3.8 MB of base64, do not rebuild it 109 times.
2. **`server/lib/wasabi.js`** — `@aws-sdk/client-s3`. Keys `<prefix>/clips/<section>/<id>.mp4`
   and `<prefix>/sections/<id>.mp4`. **Special-case `us-east-1` → `https://s3.wasabisys.com`**
   (no region segment; getting it wrong is a silent 403). Never retry a 403; halt if the first
   upload of a run 403s. `.env` still needs `WASABI_ACCESS_KEY`, `WASABI_SECRET_KEY`,
   `WASABI_BUCKET`, `WASABI_REGION` — **not yet supplied**.
3. **`server/routes/batch.js`** — one line into the `ROUTERS` map at
   `server/routes/project-routes.js:13` mounts it with `req.proj` supplied.
4. **`web/src/views/Batch.jsx`** — avatar + background upload areas at the top, sheet summary,
   settings (prompt collapsed under Advanced), sections list. New route beside `/p/:id/*` in
   `web/src/App.jsx:19`. Do **not** use `StepHead` (hard-depends on the global `STEPS`).
5. **Verification gates** — parser ($0, done) → prompt ($0) → Wasabi probe ($0) →
   **one 27s row (~$1.36)** → **one whole section 1.0 (~$10.88)** → the rest.
   Never start 109 rows before a human has watched a stitched section.

## Stage 2 (later, not started)

Remotion project for stitching, generated graphics, PiP, and the timeline (Remotion Studio *is*
the timeline — don't build one). `timeline/<section>.json` is the seam; it carries `trimAfter`
per segment so the snap-up padding is cut at assembly. **Open question:** what says a segment is
full-frame vs PiP and which graphic shows — the sheet has prose Visual text on 11 of 109 rows.
Remotion licensing: free ≤3 people, else $100/mo minimum.

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
