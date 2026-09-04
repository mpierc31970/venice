/**
 * One palette for everything drawn over the video. It is deliberately quiet: this is a
 * CEU lesson, and the graphics exist to be read, not noticed.
 *
 * The font stack stays on what Windows and the render Chrome both already have. A
 * webfont would mean a network fetch inside the renderer, and a font that fails to load
 * mid-run reflows every caption in the section.
 */
export const theme = {
  bg: "#0E1518",
  card: "rgba(18, 30, 34, 0.82)",
  line: "rgba(150, 190, 185, 0.22)",
  text: "#ECF3F1",
  dim: "#A6BDB8",
  accent: "#5FBFA8",
  scrim: "rgba(10, 17, 19, 0.86)",
  caption: "rgba(6, 12, 14, 0.66)",
  font: '"Segoe UI", "Inter", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
} as const;

/** 1920x1080 margins. Everything on screen lines up on these. */
export const PAD = 64;
/** The bottom band the captions own. Nothing else is drawn inside it. */
export const CAPTION_BAND = 208;
