// Premiere Pro (FCP7 xmeml) export tests.
// Run: node server/test/premiere.test.mjs
//
// No network, no cost. Frame arithmetic is the thing under test: a wrong `out` cuts a
// word off the end of a segment, and a wrong `start` overlaps the previous one — both
// look like a bad render rather than a bad export.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildFcpXml, pathUrl, pixelsFor } from "../lib/premiere.js";

let failures = 0;
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
};
const ok = (cond, label) => eq(!!cond, true, label);

const DIR = "D:\\Business\\Mona\\CEU_Teaching\\VeniceVideos";
const timeline = {
  section: "1.0", label: "Lesson 1 - Section 1.0", fps: 30, width: 1920, height: 1080,
  segments: [
    { id: "1.1", clip: "clips/1.0/1.1.mp4", clipFrames: 900, trimAfter: 900, layout: "full", visual: null },
    { id: "1.2", clip: "clips/1.0/1.2.mp4", clipFrames: 900, trimAfter: 822, layout: "full", visual: null },
    { id: "1.3", clip: "clips/1.0/1.3.mp4", clipFrames: 750, trimAfter: 672, layout: "full", visual: "A chart" },
    { id: "1.4", clip: null, clipFrames: 900, trimAfter: 900, layout: "full", visual: null },
  ],
};

const built = buildFcpXml(timeline, DIR, { width: 854, height: 480 });
const { xml } = built;

/* --------------------------------------------------------------- units ---- */
console.log("units");
eq(pixelsFor("480p", "16:9"), { width: 854, height: 480 }, "480p 16:9 -> 854x480");
eq(pixelsFor("1080p", "16:9"), { width: 1920, height: 1080 }, "1080p 16:9 -> 1920x1080");
eq(pixelsFor("480p", "9:16"), { width: 270, height: 480 }, "vertical keeps the short side as height");
ok(pixelsFor("1080p", "16:9").width % 2 === 0, "width is even — odd dimensions break codecs on export");
eq(pathUrl("D:\\a b\\c.mp4"), "file://localhost/D:/a%20b/c.mp4", "Windows path -> file URL, spaces encoded, colon kept");

/* ---------------------------------------------------------- frame math ---- */
console.log("\nframe math");
const starts = [...xml.matchAll(/<start>(\d+)<\/start>/g)].map((m) => +m[1]);
const ends = [...xml.matchAll(/<end>(\d+)<\/end>/g)].map((m) => +m[1]);
const outs = [...xml.matchAll(/<out>(\d+)<\/out>/g)].map((m) => +m[1]);
// Each segment appears twice — once on the video track, once on audio.
eq(starts.slice(0, 3), [0, 900, 1722], "clips butt together with no gap or overlap");
eq(ends.slice(0, 3), [900, 1722, 2394], "each ends exactly where the next begins");
eq(outs.slice(0, 3), [900, 822, 672], "out is the trim frame, not the clip length");
eq(built.frames, 2394, "sequence duration is the sum of the trims");
eq(built.seconds, 79.8, "2394 frames at 30fps is 79.8s");
eq(built.segments, 3, "a segment with no clip yet is skipped, not exported as a gap");
ok(!xml.includes("1.4"), "the unrendered segment does not appear at all");
eq(starts.length, 6, "every segment is on both a video and an audio track");

/* ---------------------------------------------------------- structure ---- */
console.log("\nstructure");
eq((xml.match(/<file id="file-\d+">/g) || []).length, 3, "each file is declared once");
eq((xml.match(/<file id="file-\d+"\/>/g) || []).length, 3, "and referenced by id thereafter");
ok(/<sourcetrack><mediatype>audio<\/mediatype>/.test(xml), "audio clipitems name their source track");
eq((xml.match(/<linkclipref>/g) || []).length, 12, "video and audio are linked so they move together");
ok(xml.includes("<width>854</width>") && xml.includes("<height>480</height>"), "sequence matches the clip resolution, so clips fill the frame");
ok(xml.includes("file://localhost/D:/Business/Mona/CEU_Teaching/VeniceVideos/clips/1.0/1.1.mp4"), "clip paths resolve against the project folder");
ok(/<ntsc>FALSE<\/ntsc>/.test(xml), "non-drop-frame — 30fps exactly, not 29.97");

/* ---------------------------------------------------------- escaping ---- */
console.log("\nescaping");
{
  // The route passes the sheet's section label through as the sequence name, so that is
  // the path a hostile-looking label actually takes.
  const nasty = buildFcpXml(timeline, DIR, { name: `Lesson & "1" <tag>` }).xml;
  ok(nasty.includes("Lesson &amp; &quot;1&quot; &lt;tag&gt;"), "a label from the sheet is escaped, not injected");
  ok(!/<name>[^<]*<tag>/.test(nasty), "no raw markup survives into the document");
}

/* ------------------------------------------------- well-formed XML ---- */
// A malformed document fails silently on import, so this parses it for real with .NET
// rather than trusting that the string looks about right.
console.log("\nwell-formedness");
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "venice-fcpxml-"));
  const file = path.join(dir, "1.0.xml");
  await fs.writeFile(file, xml, "utf8");
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("powershell", ["-NoProfile", "-Command",
    `try { $x = [xml](Get-Content -Raw '${file}'); ` +
    `"$($x.xmeml.version)|$($x.xmeml.sequence.name)|$($x.xmeml.sequence.duration)|" + ` +
    `"$($x.xmeml.sequence.media.video.track.clipitem.Count)|$($x.xmeml.sequence.media.audio.track.clipitem.Count)" } ` +
    `catch { "PARSE-ERROR: $_" }`], { encoding: "utf8" });
  const out = (r.stdout || "").trim();
  if (/PARSE-ERROR/.test(out)) { failures++; console.error("  FAIL document does not parse\n         " + out); }
  else {
    const [version, name, duration, vClips, aClips] = out.split("|");
    eq(version, "4", ".NET parses it as xmeml version 4");
    eq(name, "Section 1.0", "sequence name survives the round trip");
    eq(duration, "2394", "sequence duration survives the round trip");
    eq([vClips, aClips], ["3", "3"], "three video clipitems and three audio clipitems");
  }
  await fs.rm(dir, { recursive: true, force: true });
}

console.log(failures ? `\nFAIL ${failures} assertion(s)` : "\nPASS all assertions");
process.exit(failures ? 1 : 0);
