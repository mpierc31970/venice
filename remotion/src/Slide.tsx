import React from "react";
import { PAD, theme } from "./theme";

/**
 * An emphasis slide: one normative sentence lifted whole out of the script, held for
 * the segment it belongs to. Never paraphrased, never completed — the scripts withhold
 * specifics on purpose, and filling them in would put a regulatory claim on screen that
 * the author chose not to make.
 *
 * Static, like everything else here. It is absent, then present.
 */
export const Slide: React.FC<{ text: string }> = ({ text }) => (
  <div
    style={{
      position: "absolute",
      top: PAD + 16,
      left: PAD,
      right: PAD,
      display: "flex",
      justifyContent: "center",
    }}
  >
    <div
      style={{
        display: "flex",
        gap: 28,
        maxWidth: 1360,
        padding: "30px 40px",
        borderRadius: 18,
        backgroundColor: theme.scrim,
        border: `1px solid ${theme.line}`,
      }}
    >
      <div style={{ width: 6, borderRadius: 3, backgroundColor: theme.accent, flexShrink: 0 }} />
      <div
        style={{
          color: theme.text,
          fontSize: 52,
          lineHeight: 1.24,
          fontWeight: 600,
          textWrap: "balance",
        }}
      >
        {text}
      </div>
    </div>
  </div>
);
