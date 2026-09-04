// On-screen text derived from the narration: subtitles for every segment, and the
// occasional emphasis slide.
//
// Everything here is **lifted verbatim** from the Script column. Nothing is paraphrased,
// summarised or completed, and that is a compliance property rather than a style choice:
// this is a Texas Chapter 83 CEU lesson that students are examined on, text on screen
// reads as more authoritative than narration, and the scripts deliberately withhold
// specifics — segment 1.18 names the three bleach-solution categories and then says
// "each has a specific concentration and exposure time in the rule" without stating them.
// A helpful paraphrase that filled those in would put a regulatory claim on screen that
// the script's author chose not to make.

/** Sentence split that keeps the terminator, so text can be reassembled unchanged. */
export const sentences = (text) =>
  String(text ?? "").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

/* ---------------------------------------------------------------- slides ---- */

// A slide earns its place by stating a rule. These are the words that do that.
const NORMATIVE = /\b(must|required|requires|has to|have to|never|may not|cannot|should not)\b/i;

// A slide is read without the sentence before it, so anything pointing backwards reads
// as a fragment on screen. Sentence-initial first...
const DANGLING = /^(that|this|these|those|they|it|each|both|neither|there|then|so|because|if|when|once|after)\b/i;

// ...then demonstratives anywhere. "that" as a conjunction is deliberately allowed:
// "Texas rules state that a practitioner should never touch an open sore" is exactly the
// kind of line worth showing, and rejecting every "that" loses it.
const ANAPHORIC = /\b(this|these|those|the same|such)\b|\bthat (way|difference|logic|principle|process|item|step|kind|point)\b/i;

// Short enough to read at a glance, long enough to be a statement rather than a fragment.
export const SLIDE_MIN = 30;
export const SLIDE_MAX = 95;

/**
 * The one sentence worth putting on screen for this row, or null.
 * A row carrying a Visual note gets nothing: the diagram is the visual, and a text slide
 * competing with it would bury the thing that matters.
 */
export function slideFor(row) {
  if (!row || row.visual) return null;
  const pick = sentences(row.scriptText).find(
    (s) => s.length >= SLIDE_MIN && s.length <= SLIDE_MAX && NORMATIVE.test(s) && !DANGLING.test(s) && !ANAPHORIC.test(s)
  );
  return pick || null;
}

/**
 * Apply slideFor across a section's rows, then drop any slide immediately following
 * another: consecutive slides read as a slideshow rather than as emphasis.
 * Returns a Map of row id -> slide text.
 */
export function slidesForSection(rows = []) {
  const out = new Map();
  let lastN = -Infinity;
  for (const row of rows) {
    const text = slideFor(row);
    if (!text) continue;
    if (row.n - lastN === 1) continue; // never two in a row
    out.set(row.id, text);
    lastN = row.n;
  }
  return out;
}

/* -------------------------------------------------------------- captions ---- */

// Roughly one comfortable line of subtitle. Two of these is the usual maximum on screen.
const CAPTION_CHARS = 42;

/** Split a sentence at commas/clauses when it is too long for one caption. */
function chunkSentence(sentence) {
  if (sentence.length <= CAPTION_CHARS * 2) return [sentence];
  const parts = sentence.split(/(?<=,|;|:)\s+/);
  const out = [];
  let buf = "";
  for (const part of parts) {
    if (!buf) { buf = part; continue; }
    if ((buf + " " + part).length <= CAPTION_CHARS * 2) buf += " " + part;
    else { out.push(buf); buf = part; }
  }
  if (buf) out.push(buf);
  // Still too long (no commas to split on): break on the nearest space.
  return out.flatMap((s) => {
    if (s.length <= CAPTION_CHARS * 2) return [s];
    const words = s.split(/\s+/);
    const lines = [];
    let line = "";
    for (const w of words) {
      if (line && (line + " " + w).length > CAPTION_CHARS * 2) { lines.push(line); line = w; }
      else line = line ? line + " " + w : w;
    }
    if (line) lines.push(line);
    return lines;
  });
}

/**
 * Subtitles for one segment, verbatim from its script.
 *
 * Timing is proportional to character count across the *scripted* seconds, not the whole
 * clip: duration snaps up to the model's ladder, so the tail is silence and captions
 * spread over it would drift later and later against the speech. This is an estimate —
 * the model has no speech-rate control and the sheet's seconds are themselves an
 * estimate — so it is deliberately a plain, inspectable number per caption that can be
 * nudged in timeline.json, not something that pretends to be measured.
 *
 * For frame-accurate timing, transcribe the rendered clip (Remotion ships
 * @remotion/install-whisper-cpp) and replace `fromFrame`/`toFrame`. The *words* still
 * come from here — the script is what she was asked to say, and a transcript of a
 * mispronunciation should not become the on-screen text of a compliance course.
 */
export function captionsFor(row, fps = 30) {
  if (!row?.scriptText) return [];
  const chunks = sentences(row.scriptText).flatMap(chunkSentence);
  if (!chunks.length) return [];

  const speechFrames = Math.round((row.wantSeconds || 0) * fps);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  let frame = 0;
  return chunks.map((text, i) => {
    const share = Math.round((text.length / total) * speechFrames);
    const fromFrame = frame;
    // The last caption absorbs any rounding drift so the run ends exactly on speechFrames.
    const toFrame = i === chunks.length - 1 ? speechFrames : Math.min(speechFrames, frame + share);
    frame = toFrame;
    return { text, fromFrame, toFrame };
  }).filter((c) => c.toFrame > c.fromFrame);
}
