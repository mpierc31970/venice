import React from "react";
import { useCurrentFrame } from "remotion";
import { PAD, theme } from "./theme";
import type { Caption } from "./timeline";

/**
 * Subtitles on every segment, verbatim from the Script column — never a transcript.
 * A CEU student is examined on these words, and text on screen reads as more
 * authoritative than narration, so a mispronunciation must not become the caption.
 *
 * Timing is proportional across the *scripted* seconds (captionsFor in slides.js): the
 * tail of a clip is silence, and captions spread across it drift later and later.
 */
export const Captions: React.FC<{ captions: Caption[]; right?: number }> = ({
  captions,
  right = PAD,
}) => {
  const frame = useCurrentFrame();
  const active = captions.find((c) => frame >= c.fromFrame && frame < c.toFrame);
  if (!active) return null;

  return (
    <div
      style={{
        position: "absolute",
        left: PAD,
        right,
        bottom: PAD,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          maxWidth: 1400,
          padding: "18px 34px",
          borderRadius: 14,
          backgroundColor: theme.caption,
          color: theme.text,
          fontSize: 44,
          lineHeight: 1.3,
          fontWeight: 500,
          textAlign: "center",
          textWrap: "balance",
        }}
      >
        {active.text}
      </div>
    </div>
  );
};
