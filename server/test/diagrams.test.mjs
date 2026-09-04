// Diagram extraction tests.
// Run: node server/test/diagrams.test.mjs
//
// Every case below is real text from the lesson. The three regressions at the top are the
// ones that matter: each produced a diagram that said something Chapter 83 does not, which
// is worse than producing no diagram at all.
import { diagramFor } from "../lib/diagrams.js";

let failures = 0;
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
};
const ok = (cond, label) => eq(!!cond, true, label);
const row = (visual, scriptText) => ({ id: "x", visual, scriptText });

/* ----------------------------------------------------------- regressions ---- */
console.log("regressions");
{
  // Splitting on "and" tore this into "a stronger solution for blood" plus
  // "body-fluid cleanup" — a fourth bleach category that does not exist in the rule.
  const d = diagramFor(row("Chapter 83 bleach-solution categories by purpose",
    "Chapter 83 identifies three bleach-solution categories: low-level disinfection, high-level disinfection, and a stronger solution for blood and body-fluid cleanup. Each has a specific concentration and exposure time in the rule."));
  eq(d.kind, "list", "a colon list is a list");
  eq(d.items, ["low-level disinfection", "high-level disinfection", "a stronger solution for blood and body-fluid cleanup"],
     "three categories, and the compound item survives — the script says three, not four");

  const blood = diagramFor(row("Blood exposure response",
    "Texas permits an EPA-registered hospital-grade disinfectant, a tuberculocidal disinfectant, or the blood and body-fluid cleanup chlorine bleach solution specified by the rule."));
  eq(blood.items.length, 3, "three permitted products, not four");
  ok(blood.items[2].startsWith("the blood and body-fluid cleanup"), "the compound product name stays whole");

  // Stripping "After" left "The process is complete, the tweezers can be placed in clean
  // storage" — asserting the process is complete rather than describing what follows it.
  const seq = diagramFor(row("Reusable metal tweezer cleaning and disinfection workflow",
    "Think of reusable metal tweezers after a service. First, remove any visible residue and clean the tweezers thoroughly. Next, disinfect them using the approved product. After the process is complete, the tweezers can be placed in clean storage."));
  eq(seq.kind, "sequence", "First/Next/After is a sequence");
  eq(seq.steps.length, 3, "three steps");
  eq(seq.steps[0], "Remove any visible residue and clean the tweezers thoroughly.", "a real marker is stripped");
  ok(seq.steps[2].startsWith("After the process is complete"), "a subordinate clause is left alone");

  // "Cleaning, disinfection, sanitization, and sterilization compared" names four things;
  // splitting on the last "and" made the left side "Cleaning, disinfection, sanitization,".
  const four = diagramFor(row("Cleaning, disinfection, sanitization, and sterilization compared",
    "Texas defines sanitization as reducing microorganisms to a safe level. Sterilization means eliminating all forms of bacteria through an autoclave."));
  ok(four.kind !== "comparison", "a four-term title is not forced into a two-sided comparison");
}

/* ---------------------------------------------------------------- shapes ---- */
console.log("\nshapes");
{
  eq(diagramFor(row("", "Anything at all.")), null, "a row with no Visual note has no diagram");

  const verb = diagramFor(row("Single-use eyelash supplies",
    "Texas lists disposable gloves, tissues, wipes, fabric strips, and extension pads among the items that must be discarded after use."));
  eq(verb.kind, "list", "\"Texas lists a, b, c\" is a list");
  eq(verb.items, ["disposable gloves", "tissues", "wipes", "fabric strips", "extension pads"], "items verbatim, trailing \"and\" dropped");

  const pts = diagramFor(row("Clean and used areas kept separate",
    "Once an implement has contacted the client, it should not return to the clean supply area. The separation prevents confusion."));
  eq(pts.kind, "points", "no detectable structure falls back to the script's own sentences");

  const setup = diagramFor(row("A workflow",
    "Think about a jar of facial cream. The spatula starts clean. Putting it back creates a pathway."));
  ok(!setup.items.some((s) => /^Think about/.test(s)), "a scene-setting opener is not part of the diagram");
}

/* --------------------------------------------------------------- verbatim ---- */
console.log("\nverbatim");
{
  const script = "Texas permits an EPA-registered hospital-grade disinfectant, a tuberculocidal disinfectant, or the blood and body-fluid cleanup chlorine bleach solution specified by the rule.";
  const d = diagramFor(row("Blood exposure response", script));
  for (const item of d.items) {
    ok(script.includes(item), `"${item.slice(0, 40)}…" appears in the script word for word`);
  }
  eq(d.title, "Blood exposure response", "the title is the human-written Visual note, unchanged");
}

console.log(failures ? `\nFAIL ${failures} assertion(s)` : "\nPASS all assertions");
process.exit(failures ? 1 : 0);
