import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, staticFile, useVideoConfig } from "remotion";
import { Captions } from "./Captions";
import { Slide } from "./Slide";
import { Diagram } from "./visuals/Diagram";
import { CAPTION_BAND, PAD, theme } from "./theme";
import type { Avatar, Segment as SegmentData } from "./timeline";

/**
 * Two layouts, and there is no third. "full" is the talking head at full frame; "pip"
 * is a graphic with the head shrunk into a circle. The sheet's Visual column already
 * chose which — 11 rows of 109 — so nothing is decided at render time and a head never
 * shrinks mid-section for a reason the viewer cannot see.
 */
export const Segment: React.FC<{ segment: SegmentData; avatar: Avatar }> = ({
  segment,
  avatar,
}) => {
  const { width } = useVideoConfig();
  const src = staticFile(segment.clip);

  if (segment.layout === "pip" && segment.diagram) {
    // A quarter of the frame's width. Fixed: the same size in the same place in every
    // section, so the circle never reads as a different shot.
    const size = avatar.pip.size * width;

    return (
      <AbsoluteFill style={{ backgroundColor: theme.bg }}>
        {/* The room the talking head was generated in, scrimmed down until it is only a
            suggestion. It keeps the graphic frames in the same place as the clips. */}
        <Img
          src={staticFile("background.png")}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
        <AbsoluteFill style={{ backgroundColor: theme.scrim }} />

        <div
          style={{
            position: "absolute",
            left: PAD,
            right: PAD,
            top: PAD,
            bottom: CAPTION_BAND,
          }}
        >
          <Diagram diagram={segment.diagram} bodyRight={size + PAD} />
        </div>

        {/*
          No animation of any kind. The circle does not spring, scale, fade, slide or
          drift in — the idiomatic Remotion component does exactly that, and it is wrong
          here. It is absent, and on the next frame it is present, at the same size in
          the same place. avatar.motion === "none" and avatar.transition === "cut" say so
          in the data; this is where that is honoured.
        */}
        <div
          style={{
            position: "absolute",
            right: PAD,
            bottom: PAD,
            width: size,
            height: size,
            borderRadius: "50%",
            overflow: "hidden",
            border: `4px solid ${theme.line}`,
            boxShadow: "0 24px 70px rgba(0, 0, 0, 0.5)",
          }}
        >
          <OffthreadVideo
            src={src}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        </div>

        <Captions captions={segment.captions} right={size + PAD * 2} />
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <OffthreadVideo src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      {segment.slide ? <Slide text={segment.slide} /> : null}
      <Captions captions={segment.captions} />
    </AbsoluteFill>
  );
};
