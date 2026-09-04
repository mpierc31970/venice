// Diagram content for the 11 segments carrying a Visual note.
//
// The hint is the one the user gave: a diagram belongs where the script has **multiple
// pieces of information that fit together**. Reading all 11 scripts, that resolves into
// exactly three shapes, and each announces itself in the words:
//
//   list        "three bleach-solution categories: low-level, high-level, and ..."
//               "Texas lists gloves, tissues, wipes, ... among the items"
//   sequence    "First, remove ... Next, disinfect ... After the process is complete ..."
//   comparison  two things defined against each other — sanitization vs sterilization,
//               multi-use vs single-use, the clean side vs the used side
//
// Items are lifted **verbatim**, for the reason set out in slides.js: this is a Chapter 83
// CEU lesson, and a diagram that tidies a phrase into something the script did not say is
// a regulatory claim nobody authored. Where the shape is not detectable, the fallback is
// the script's own sentences as bullets rather than a guess at structure.
//
// The title is always the sheet's Visual note, which a human wrote.

import { sentences } from "./slides.js";

// A step marker is a discourse marker, which in this prose always carries a comma:
// "First, remove any visible residue". Without one the word opens a subordinate clause
// instead — "After the process is complete, the tweezers can be placed in storage" — and
// belongs to the sentence rather than labelling it.
const ORDINAL = /^(first|next|then|after|once|finally|second|third|lastly)\b/i;
const STEP_MARKER = /^(first|next|then|finally|second|third|lastly)\s*[,:]\s*/i;

/** Spotting a step is looser than labelling one, so only a real marker is stripped. */
const looksOrdered = (s) => ORDINAL.test(s);

/**
 * Strip the marker so a step reads as an instruction. Stripping anything else left
 * "The process is complete, the tweezers can be placed in clean storage" — which states
 * something the script does not.
 */
const stripOrdinal = (s) =>
  STEP_MARKER.test(s) ? s.replace(STEP_MARKER, "").replace(/^./, (c) => c.toUpperCase()) : s;

/**
 * "a, b, and c" -> ["a", "b", "c"].
 *
 * Split on commas only, then strip a leading "and"/"or" from the last item. Splitting on
 * the conjunction itself tore compound items in half — "a stronger solution for blood and
 * body-fluid cleanup" became two bullets, inventing a fourth bleach category that Chapter
 * 83 does not have, and "the blood and body-fluid cleanup chlorine bleach solution" went
 * the same way. A list has commas; only fall back to the conjunction when it has none.
 */
function splitItems(text) {
  const clean = (s) => s.trim().replace(/^(and|or)\s+/i, "").replace(/[.;:]+$/, "");
  const raw = String(text);
  const parts = raw.includes(",") ? raw.split(/,\s*/) : raw.split(/\s+(?:and|or)\s+/i);
  return parts.map(clean).filter((s) => s.length > 1);
}

/* ------------------------------------------------------------- detectors ---- */

/** "…three categories: low-level disinfection, high-level disinfection, and …" */
function asColonList(list) {
  for (const s of list) {
    const m = /^(.*?):\s+(.+)$/.exec(s);
    if (!m) continue;
    const items = splitItems(m[2]);
    if (items.length >= 2) return { lead: m[1].trim(), items };
  }
  return null;
}

/** "Texas lists gloves, tissues, wipes, … among the items that must be discarded" */
function asVerbList(list) {
  for (const s of list) {
    const m = /\b(?:lists|includes|permits|identifies|recognizes)\s+(.+?)(?:\s+among\b|\s+that\b|\.|$)/i.exec(s);
    if (!m) continue;
    const items = splitItems(m[1]);
    if (items.length >= 3) return { lead: s.slice(0, m.index + m[0].indexOf(m[1])).trim().replace(/\s+$/, ""), items };
  }
  return null;
}

/** "First, … Next, … After …" — two or more ordered steps. */
function asSequence(list) {
  const steps = list.filter(looksOrdered);
  return steps.length >= 2 ? steps.map(stripOrdinal) : null;
}

/**
 * Two things set against each other. The pairing is asserted by the Visual note the
 * human wrote ("X and Y compared", "X and Y side by side"), and the sides are the
 * script's sentences that mention each term — never a synthesised definition.
 */
function asComparison(list, visual) {
  const m = /^(.*?)\s+(?:and|vs\.?|versus)\s+(.*?)(?:\s+(?:compared|side by side|kept separate).*)?$/i.exec(String(visual || ""));
  if (!m) return null;
  const term = (t) => t.replace(/^(the|a|an)\s+/i, "").trim();
  const left = term(m[1]), right = term(m[2]);
  // A comparison needs exactly two sides. "Cleaning, disinfection, sanitization, and
  // sterilization compared" names four, and splitting on the last "and" made the left
  // side the literal string "Cleaning, disinfection, sanitization," — a label for
  // nothing. A comma on either side means this is a list, not a pair.
  if (left.includes(",") || right.includes(",")) return null;
  const key = (t) => t.split(/[\s,]+/).filter((w) => w.length > 3)[0];
  const lk = key(left), rk = key(right);
  if (!lk || !rk) return null;
  const pick = (k) => list.filter((s) => new RegExp(`\\b${k}`, "i").test(s));
  const a = pick(lk), b = pick(rk);
  if (!a.length || !b.length) return null;
  return { left: { term: left, points: a.slice(0, 2) }, right: { term: right, points: b.slice(0, 2) } };
}

/* ---------------------------------------------------------------- build ---- */

// The opening sentence is usually an invitation, not content: "Think of reusable metal
// tweezers after a service." It sets up the diagram rather than belonging in it.
const SCENE_SETTING = /^(think (of|about)|you will also hear|another useful distinction|consider)\b/i;

/**
 * Diagram content for one row, or null when the row carries no Visual note.
 * Returns { kind, title, ... } where kind is "list" | "sequence" | "comparison" | "points".
 */
export function diagramFor(row) {
  if (!row?.visual) return null;
  const all = sentences(row.scriptText);
  const body = all.filter((s) => !SCENE_SETTING.test(s));
  const title = row.visual;

  const seq = asSequence(body);
  if (seq) return { kind: "sequence", title, steps: seq };

  const colon = asColonList(body);
  if (colon) return { kind: "list", title, lead: colon.lead, items: colon.items };

  const verb = asVerbList(body);
  if (verb) return { kind: "list", title, lead: verb.lead, items: verb.items };

  const cmp = asComparison(body, row.visual);
  if (cmp) return { kind: "comparison", title, ...cmp };

  // Nothing structural detected: the script's own sentences, unaltered.
  return { kind: "points", title, items: body.slice(0, 4) };
}
