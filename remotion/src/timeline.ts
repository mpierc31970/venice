/**
 * The shape of timeline/<section>.json, written by buildTimeline() in
 * server/lib/batch.js. This file is the only place that knows it — change one, change
 * both. Frame numbers are all relative to the segment that carries them.
 */

export type Caption = { text: string; fromFrame: number; toFrame: number };

export type Side = { term: string; points: string[] };

export type Diagram =
  | { kind: "points"; title: string; items: string[] }
  | { kind: "list"; title: string; lead: string; items: string[] }
  | { kind: "sequence"; title: string; steps: string[] }
  | { kind: "comparison"; title: string; left: Side; right: Side };

export type Segment = {
  id: string;
  /** Relative to the project dir, e.g. "clips/1.0/1.4.mp4". */
  clip: string;
  /** What Wan generated: the snapped-up duration, padding and all. */
  clipFrames: number;
  /** Where the clip is cut — the scripted length plus a little silence. */
  trimAfter: number;
  layout: "pip" | "full";
  visual: string | null;
  slide: string | null;
  diagram: Diagram | null;
  captions: Caption[];
};

export type Avatar = {
  pip: { shape: "circle"; corner: "bottom-right"; size: number };
  /** Always "none". The circle does not zoom, scale, fade, slide, drift or breathe. */
  motion: "none";
  /** Always "cut". It is absent, and on the next frame it is present. */
  transition: "cut";
};

export type Timeline = {
  section: string;
  label: string;
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  transition: { kind: "cut" | "crossDissolve"; frames: number };
  avatar: Avatar;
  segments: Segment[];
};

/** Composition ids allow no dots: section 1.0 is "section-1-0". */
export const compositionId = (section: string) => `section-${section.replace(/\./g, "-")}`;
export const sectionOf = (id: string) => id.replace(/^section-/, "").replace(/-/g, ".");

/** "1.10" sorts after "1.9", which a plain string or float compare both get wrong. */
export const bySection = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
};

/**
 * focus/<section>.json — segment id -> where the presenter is in that clip, measured by
 * focus.mjs. Only pip segments appear; a missing entry means centred.
 */
export type Focus = Record<string, { x: number; y: number }>;
