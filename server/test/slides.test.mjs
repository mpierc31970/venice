// On-screen text tests: emphasis slides and subtitles.
// Run: node server/test/slides.test.mjs
//
// The property under test is not "does it look nice" but "is every word on screen a word
// the script actually said". Everything here is verbatim by construction, and these
// assertions are what keep it that way.
import { slideFor, slidesForSection, captionsFor, sentences, SLIDE_MAX } from "../lib/slides.js";

let failures = 0;
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
};
const ok = (cond, label) => eq(!!cond, true, label);

const row = (over = {}) => ({ id: "1.19", n: 11, visual: "", wantSeconds: 25, scriptText: "", ...over });

/* --------------------------------------------------------------- slides ---- */
console.log("slides");
{
  // Real script text, taken from the lesson.
  const bleach = row({ scriptText:
    "Bleach solutions must be mixed daily. They also need to be kept in a closed, covered container and protected from sunlight." });
  eq(slideFor(bleach), "Bleach solutions must be mixed daily.", "picks the sentence that states a rule");

  eq(slideFor(row({ scriptText: "Cleaning and disinfection work as a sequence, and the order matters." })), null,
     "a sentence with no rule in it is not a slide");

  eq(slideFor(row({ visual: "A chart", scriptText: "Bleach solutions must be mixed daily." })), null,
     "a row with a diagram gets no text slide — the diagram is the visual");

  eq(slideFor(row({ scriptText: "That same logic applies and items must be replaced." })), null,
     "a sentence opening with a back-reference is not self-contained");

  eq(slideFor(row({ scriptText: "Items handled this way must be replaced for each client." })), null,
     "a back-reference in the middle is caught too");

  eq(slideFor(row({ scriptText: "Texas rules state that a practitioner should never touch a client's open sore." })),
     "Texas rules state that a practitioner should never touch a client's open sore.",
     "\"that\" as a conjunction is kept — rejecting every \"that\" loses the best lines");

  const long = "The establishment must ensure " + "x".repeat(SLIDE_MAX) + ".";
  eq(slideFor(row({ scriptText: long })), null, "a sentence too long to read at a glance is not a slide");

  // Verbatim, always.
  const src = "Wax may not be reused under any circumstances.";
  ok(String(slideFor(row({ scriptText: src }))) === src, "the slide is the script's own words, character for character");
}

console.log("\nspacing");
{
  const rows = [
    row({ id: "1.1", n: 1, scriptText: "Bleach solutions must be mixed daily." }),
    row({ id: "1.2", n: 2, scriptText: "A clean towel must be used for each client." }),
    row({ id: "1.3", n: 3, scriptText: "Nothing notable happens here at all." }),
    row({ id: "1.4", n: 4, scriptText: "Floors must be thoroughly cleaned each day." }),
  ];
  const picked = slidesForSection(rows);
  eq([...picked.keys()], ["1.1", "1.4"], "never two slides in a row — consecutive slides read as a slideshow");
}

/* ------------------------------------------------------------- captions ---- */
console.log("\ncaptions");
{
  const r = row({ wantSeconds: 25, scriptText:
    "Bleach solutions must be mixed daily. They also need to be kept in a closed, covered container and protected from sunlight." });
  const caps = captionsFor(r, 30);

  ok(caps.length >= 2, "a two-sentence script yields at least two captions");
  eq(caps[0].fromFrame, 0, "captions start at the first frame of the segment");
  eq(caps[caps.length - 1].toFrame, 750, "and end exactly on the scripted 25s, not the 30s clip");

  // The silence after the last word is padding from snapping duration up. Captions
  // spread across it would drift later and later against the speech.
  ok(caps[caps.length - 1].toFrame === r.wantSeconds * 30, "captions cover the speech, not the padding");

  let cursor = 0, gapless = true;
  for (const c of caps) { if (c.fromFrame !== cursor) gapless = false; cursor = c.toFrame; }
  ok(gapless, "captions run end to end with no gaps or overlaps");
  ok(caps.every((c) => c.toFrame > c.fromFrame), "no caption has zero or negative duration");

  const rebuilt = caps.map((c) => c.text).join(" ");
  const original = r.scriptText.replace(/\s+/g, " ").trim();
  eq(rebuilt, original, "the captions reassemble into the script exactly — nothing added, dropped or reworded");

  const longest = Math.max(...caps.map((c) => c.text.length));
  ok(longest <= 84, `no caption exceeds two comfortable lines (longest ${longest})`);
}

console.log("\nedges");
eq(captionsFor(row({ scriptText: "" }), 30), [], "an empty script yields no captions");
eq(captionsFor(null, 30), [], "a missing row yields no captions, not a crash");
eq(sentences("One. Two! Three?"), ["One.", "Two!", "Three?"], "sentence split keeps terminators");
{
  const one = captionsFor(row({ wantSeconds: 5, scriptText: "Short line here." }), 30);
  eq(one.length, 1, "a single short sentence is one caption");
  eq([one[0].fromFrame, one[0].toFrame], [0, 150], "spanning the whole scripted duration");
}

console.log(failures ? `\nFAIL ${failures} assertion(s)` : "\nPASS all assertions");
process.exit(failures ? 1 : 0);
