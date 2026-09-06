import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Captions } from "./Captions";
import { Slide } from "./Slide";
import { Diagram } from "./visuals/Diagram";
import { CAPTION_BAND, PAD, theme } from "./theme";
import type { Avatar, Focus, Plate, Plates, Segment as SegmentData } from "./timeline";

/** How much of the plate's height the pip circle shows: crown to upper chest. */
const PIP_CROP = 0.74;
/** How far above her hairline that crop starts, as a fraction of the plate's height. */
const PIP_HEADROOM = 0.03;
/** The full-frame shot: her height as a fraction of the composition. */
const FULL_HEIGHT = 1040 / 1080;

/**
 * The per-frame correction, as a CSS transform.
 *
 * Applied with the origin at the top left so it composes exactly as the maths in
 * plates.mjs does: scale about (0,0), then translate. The translation is a percentage,
 * which CSS resolves against the element itself — so this works whatever size the plate
 * has been laid out at, and needs no knowledge of the source's pixel dimensions.
 */
function correction(plate: Plate | null, frame: number): React.CSSProperties {
  const t = plate?.transforms?.[Math.min(frame, plate.transforms.length - 1)];
  if (!t) return {};
  return {
    transform: `translate(${t.dx * 100}%, ${t.dy * 100}%) scale(${t.s})`,
    transformOrigin: "0 0",
  };
}

/**
 * Two layouts, and there is no third. "full" is the talking head at full frame; "pip"
 * is a graphic with the head shrunk into a circle. The sheet's Visual column already
 * chose which — 11 rows of 109 — so nothing is decided at render time and a head never
 * shrinks mid-section for a reason the viewer cannot see.
 *
 * Each layout has two paths. With a plate, the room is a still image and she is a keyed
 * cut-out placed on it by measurement. Without one — a section generated before the green
 * screen, whose clips carry their own room — the clip plays whole, as it always did.
 */
export const Segment: React.FC<{
  segment: SegmentData;
  avatar: Avatar;
  focus?: Focus[string];
  plate?: Plate | null;
  target?: Plates["target"] | null;
}> = ({ segment, avatar, focus, plate = null, target = null }) => {
  const { width } = useVideoConfig();
  const frame = useCurrentFrame();
  const src = staticFile(segment.clip);
  const keyed = Boolean(plate && target);

  if (segment.layout === "pip" && segment.diagram) {
    // A quarter of the frame's width. Fixed: the same size in the same place in every
    // section, so the circle never reads as a different shot.
    const size = avatar.pip.size * width;

    // The crop that puts her face in the circle. Derived from the section's target, so it
    // is one rectangle for every clip — the plate is already normalised, which is what
    // makes a constant possible where focus.mjs needed a per-clip measurement.
    const crop = plate ? plate.height * PIP_CROP : 0;
    const k = plate ? size / crop : 1;
    const cropX = target ? target.cx - crop / 2 : 0;
    const cropY = target ? Math.max(0, target.top - (plate?.height ?? 0) * PIP_HEADROOM) : 0;

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
          {keyed ? (
            <>
              {/*
                The circle needs something behind her. A keyed plate is transparent
                everywhere she is not, so cutting it straight to a circle shows the
                scrimmed room through the gaps and reads as her silhouette floating
                rather than as an inset shot. The room at full brightness goes in first.
              */}
              <Img
                src={staticFile("background.png")}
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
              />
              <OffthreadVideo
                src={staticFile(plate!.plate)}
                // Without this the alpha plane is ignored and every keyed-out pixel
                // renders as a flat colour — she arrives inside an opaque square.
                transparent
                style={{
                  position: "absolute",
                  left: -cropX * k,
                  top: -cropY * k,
                  width: plate!.width * k,
                  height: plate!.height * k,
                  maxWidth: "none",
                  ...correction(plate, frame),
                }}
              />
            </>
          ) : (
            /*
              The unkeyed path. Centred on the presenter, not on the frame: Wan generates
              every clip independently and the framing drifts — in section 1.0 she is at
              x = 0.49 in seven clips and x = 0.41 in the eighth — which is invisible full
              frame and reads as a badly placed avatar once cropped to a circle.
              focus.mjs measures where she actually is; this puts that point in the middle
              of the circle. The clamp keeps the frame covering the circle.
            */
            <OffthreadVideo
              src={src}
              style={{
                position: "absolute",
                top: 0,
                left: "50%",
                height: "100%",
                width: "auto",
                maxWidth: "none",
                transform: `translateX(${-100 * Math.min(0.68, Math.max(0.32, focus?.x ?? 0.5))}%)`,
              }}
            />
          )}
        </div>

        <Captions captions={segment.captions} right={size + PAD * 2} />
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      {keyed ? (
        <>
          <Img
            src={staticFile("background.png")}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
          <FullFramePlate plate={plate!} target={target!} frame={frame} />
        </>
      ) : (
        <OffthreadVideo src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      )}
      {segment.slide ? <Slide text={segment.slide} /> : null}
      <Captions captions={segment.captions} />
    </AbsoluteFill>
  );
};

/**
 * Her, cut out, standing in the room.
 *
 * The plate is laid out at a fixed height and then slid sideways so that the *measured*
 * centre of her — not the centre of the frame she happens to have been generated in —
 * lands on the middle of the composition. Everything about where she sits is arithmetic
 * from plates/<section>.json; nothing here is a guess about how Wan framed the shot.
 */
const FullFramePlate: React.FC<{ plate: Plate; target: Plates["target"]; frame: number }> = ({
  plate,
  target,
  frame,
}) => {
  const { width, height } = useVideoConfig();
  const h = height * FULL_HEIGHT;
  const k = h / plate.height;

  return (
    <OffthreadVideo
      src={staticFile(plate.plate)}
      transparent
      style={{
        position: "absolute",
        left: width / 2 - target.cx * k,
        top: height - h,
        width: plate.width * k,
        height: h,
        maxWidth: "none",
        ...correction(plate, frame),
      }}
    />
  );
};
