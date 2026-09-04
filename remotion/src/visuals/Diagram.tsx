import React from "react";
import { theme } from "../theme";
import type { Diagram as DiagramData, Side } from "../timeline";

/**
 * The 11 graphics in the lesson. Every word in one of these comes from the script that
 * segment narrates — diagramFor() in server/lib/diagrams.js lifts them whole. Nothing
 * here paraphrases, completes or reorders them; this file only decides how they sit on
 * the screen. If a diagram reads wrongly, the fix is in the extraction, not here.
 */

/** The content is what it is — 3 sentences of 148 characters, or 11 labels of 12. */
function fontFor(texts: string[]) {
  const total = texts.join(" ").length;
  if (total > 520 || texts.length > 8) return 30;
  if (total > 340) return 34;
  if (total > 180) return 38;
  return 44;
}

/** Many short labels read as a grid; sentences read as rows. */
const isChips = (items: string[]) =>
  items.length >= 5 && items.every((i) => i.length <= 28);

const Bullet: React.FC = () => (
  <div
    style={{
      width: 12,
      height: 12,
      marginTop: 16,
      borderRadius: 3,
      backgroundColor: theme.accent,
      flexShrink: 0,
    }}
  />
);

const Rows: React.FC<{ items: string[]; ordered?: boolean }> = ({ items, ordered }) => {
  const size = fontFor(items);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: size * 0.62 }}>
      {items.map((item, i) => (
        <div key={i} style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
          {ordered ? (
            <div
              style={{
                width: size * 1.15,
                height: size * 1.15,
                borderRadius: "50%",
                border: `2px solid ${theme.accent}`,
                color: theme.accent,
                fontSize: size * 0.62,
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {i + 1}
            </div>
          ) : (
            <Bullet />
          )}
          <div style={{ color: theme.text, fontSize: size, lineHeight: 1.3 }}>{item}</div>
        </div>
      ))}
    </div>
  );
};

const Chips: React.FC<{ items: string[] }> = ({ items }) => {
  const size = fontFor(items);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
      {items.map((item, i) => (
        <div
          key={i}
          style={{
            padding: "14px 26px",
            borderRadius: 12,
            border: `1px solid ${theme.line}`,
            backgroundColor: theme.card,
            color: theme.text,
            fontSize: size,
            lineHeight: 1.2,
          }}
        >
          {item}
        </div>
      ))}
    </div>
  );
};

const Column: React.FC<{ side: Side }> = ({ side }) => {
  const size = fontFor(side.points);
  return (
    <div
      style={{
        flex: 1,
        padding: 30,
        borderRadius: 16,
        border: `1px solid ${theme.line}`,
        backgroundColor: theme.card,
      }}
    >
      <div
        style={{
          color: theme.accent,
          fontSize: size * 1.05,
          fontWeight: 700,
          marginBottom: 20,
          textTransform: "capitalize",
        }}
      >
        {side.term}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {side.points.map((p, i) => (
          <div key={i} style={{ color: theme.text, fontSize: size * 0.92, lineHeight: 1.3 }}>
            {p}
          </div>
        ))}
      </div>
    </div>
  );
};

const Body: React.FC<{ diagram: DiagramData }> = ({ diagram }) => {
  switch (diagram.kind) {
    case "sequence":
      return <Rows items={diagram.steps} ordered />;
    case "comparison":
      return (
        <div style={{ display: "flex", gap: 28, alignItems: "stretch" }}>
          <Column side={diagram.left} />
          <Column side={diagram.right} />
        </div>
      );
    case "list":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
          <div style={{ color: theme.dim, fontSize: 34, lineHeight: 1.3 }}>{diagram.lead}</div>
          {isChips(diagram.items) ? <Chips items={diagram.items} /> : <Rows items={diagram.items} />}
        </div>
      );
    default:
      return <Rows items={diagram.items} />;
  }
};

/**
 * `bodyRight` is the room the PiP circle needs. The title runs the full width above it;
 * the body stops short of the corner the avatar occupies, so nothing ever sits under it.
 */
export const Diagram: React.FC<{ diagram: DiagramData; bodyRight: number }> = ({
  diagram,
  bodyRight,
}) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 40, height: "100%" }}>
    <div>
      <div
        style={{
          color: theme.accent,
          fontSize: 26,
          letterSpacing: 3,
          fontWeight: 700,
          textTransform: "uppercase",
          marginBottom: 14,
        }}
      >
        {diagram.kind === "sequence" ? "Workflow" : diagram.kind === "comparison" ? "Compared" : "Key points"}
      </div>
      <div style={{ color: theme.text, fontSize: 56, fontWeight: 600, lineHeight: 1.15 }}>
        {diagram.title}
      </div>
      <div style={{ height: 3, width: 120, marginTop: 26, backgroundColor: theme.accent }} />
    </div>
    <div style={{ paddingRight: bodyRight }}>
      <Body diagram={diagram} />
    </div>
  </div>
);
