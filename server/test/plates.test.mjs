// The geometry behind the green-screen plates.
// Run: node server/test/plates.test.mjs
//
// No ffmpeg, no video, no files — the measuring is arithmetic and this is where the
// arithmetic is checked. What matters is that a section normalises to ONE framing rather
// than each clip to its own, that a jittery measurement does not become a jittery
// picture, and that a clip which came out badly wrong is clamped instead of blown up.
import { bboxFromMask, smooth, targetFrom, transformsFor, keyFilter } from "../../remotion/plates.mjs";

let failures = 0;
const eq = (a, b, label) => {
  if (JSON.stringify(a) === JSON.stringify(b)) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n         expected ${JSON.stringify(b)}\n         actual   ${JSON.stringify(a)}`);
};
const near = (a, b, tol, label) => {
  if (Math.abs(a - b) <= tol) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n         expected ${b} ±${tol}\n         actual   ${a}`);
};

console.log("the mask");
{
  // A 10x10 frame with an opaque 4x3 block at (3,2).
  const w = 10, h = 10;
  const m = new Uint8Array(w * h);
  for (let y = 2; y < 5; y++) for (let x = 3; x < 7; x++) m[y * w + x] = 255;
  const b = bboxFromMask(m, w, h);
  eq([b.x0, b.y0, b.x1, b.y1], [3, 2, 6, 4], "finds the block's bounds");
  eq([b.w, b.h], [4, 3], "and its size");
  eq([b.cx, b.top], [4.5, 2], "centre x and head top");
  near(b.cover, 12 / 100, 1e-9, "coverage is the opaque fraction");
}
eq(bboxFromMask(new Uint8Array(100), 10, 10), null, "an empty frame has no box, rather than a wrong one");
{
  const m = new Uint8Array(100).fill(127);
  eq(bboxFromMask(m, 10, 10), null, "and semi-transparent pixels below the threshold do not count");
}

console.log("\nsmoothing");
{
  // A steady value with a one-frame spike — exactly what a flickering mask edge looks like.
  const noisy = [100, 100, 100, 140, 100, 100, 100];
  const s = smooth(noisy, 5);
  near(s[3], 108, 0.001, "a spike is flattened towards its neighbours");
  eq(s.length, noisy.length, "and every frame still has a value");
  const ramp = [0, 10, 20, 30, 40, 50, 60, 70, 80];
  const rs = smooth(ramp, 5);
  near(rs[4], 40, 0.001, "a genuine move is followed, not flattened");
  near(rs[0], 10, 0.001, "the window shrinks at the start instead of padding with zeros");
  near(rs[8], 70, 0.001, "and at the end");
}

console.log("\nthe target framing");
{
  // Two clips: one where she sits left and small, one right and large.
  const left = [{ w: 500, cx: 280, top: 40 }, { w: 500, cx: 280, top: 40 }, { w: 500, cx: 280, top: 40 }];
  const right = [{ w: 560, cx: 320, top: 50 }, { w: 560, cx: 320, top: 50 }, { w: 560, cx: 320, top: 50 }];
  const t = targetFrom([left, right]);
  near(t.w, 530, 0.001, "the target width is the median across the whole section");
  near(t.cx, 300, 0.001, "and so is the centre");
  near(t.top, 45, 0.001, "and the head top");
}
{
  let threw = null;
  try { targetFrom([[], []]); } catch (e) { threw = e.message; }
  eq(/cannot choose a target/i.test(threw || ""), true, "a section with nothing measured refuses rather than guessing");
}

console.log("\nthe per-frame transform");
const frame = { width: 624, height: 624 };
{
  const target = { w: 550, cx: 312, top: 40 };
  const track = new Array(31).fill({ w: 550, cx: 312, top: 40 });
  const tf = transformsFor(track, target, frame);
  near(tf[15].s, 1, 1e-4, "a clip already at the target is left alone: scale 1");
  near(tf[15].dx, 0, 1e-4, "no horizontal shift");
  near(tf[15].dy, 0, 1e-4, "no vertical shift");
}
{
  // She is 10% too small and sitting 30px left of where the section wants her.
  const target = { w: 550, cx: 312, top: 40 };
  const track = new Array(31).fill({ w: 500, cx: 282, top: 44 });
  const tf = transformsFor(track, target, frame);
  near(tf[15].s, 1.1, 1e-3, "scaled up to the target width");
  // After scaling about the top-left, her centre lands at 282 * 1.1 = 310.2; the shift
  // must carry it the remaining 1.8px to 312.
  near(tf[15].dx * frame.width, 1.8, 0.05, "and shifted so her centre lands on the target");
  near(tf[15].dy * frame.height, 40 - 44 * 1.1, 0.05, "with the head top corrected too");
}
{
  // Two clips normalised against one shared target must end up at the same place —
  // this is the whole point, and normalising each clip to its own median would not.
  const a = new Array(21).fill({ w: 500, cx: 280, top: 40 });
  const b = new Array(21).fill({ w: 560, cx: 330, top: 55 });
  const target = targetFrom([a, b]);
  const ta = transformsFor(a, target, frame)[10];
  const tb = transformsFor(b, target, frame)[10];
  const landedA = (280 * ta.s + ta.dx * frame.width);
  const landedB = (330 * tb.s + tb.dx * frame.width);
  near(landedA, landedB, 0.1, "two clips that started apart land on the same centre");
  near(500 * ta.s, 560 * tb.s, 0.5, "and at the same width");
}
{
  // A clip that came back at half size: blowing it up 2x would be soft and crop her.
  const target = { w: 550, cx: 312, top: 40 };
  const track = new Array(11).fill({ w: 250, cx: 312, top: 40 });
  const tf = transformsFor(track, target, frame, { maxScale: 1.35 });
  near(tf[5].s, 1.35, 1e-4, "an extreme mismatch is clamped rather than blown up");
}
{
  // The jitter test: a mask that flickers must not produce a picture that flickers.
  const target = { w: 550, cx: 312, top: 40 };
  const jittery = Array.from({ length: 41 }, (_, i) => ({ w: 550, cx: 312 + (i % 2 ? 3 : -3), top: 40 }));
  const tf = transformsFor(jittery, target, frame, { window: 15 });
  const swing = Math.max(...tf.map((t) => t.dx)) - Math.min(...tf.map((t) => t.dx));
  eq(swing * frame.width < 1, true, `frame-to-frame swing stays under a pixel (was ${(swing * frame.width).toFixed(2)}px)`);
}

console.log("\nthe key filter");
{
  const f = keyFilter("0x468f5e");
  eq(f.startsWith("format=yuva420p,"), true, "the alpha format comes first, or chromakey has nowhere to write");
  eq(/chromakey=color=0x468f5e/.test(f), true, "keys on the measured screen colour, not a guess at pure green");
  eq(/despill=type=green/.test(f), true, "and despills");
  eq(f.indexOf("chromakey") < f.indexOf("despill"), true, "despill runs after the key, not before");
}

console.log(failures ? `\nFAIL ${failures} assertion(s)` : "\nPASS all assertions");
process.exit(failures ? 1 : 0);
