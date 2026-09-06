import React from "react";
import { Composition, getStaticFiles, staticFile } from "remotion";
import { Section } from "./Section";
import { bySection, compositionId, type Focus, type Plates, type Timeline } from "./timeline";

/**
 * One composition per timeline on disk — no list to maintain. A section appears here the
 * moment writeTimeline() fires, which is the moment its last segment finishes rendering.
 */
const sections = getStaticFiles()
  .map((f) => /^timeline\/(.+)\.json$/.exec(f.name)?.[1])
  .filter((s): s is string => Boolean(s))
  .sort(bySection);

export const RemotionRoot: React.FC = () => (
  <>
    {sections.map((section) => (
      <Composition
        key={section}
        id={compositionId(section)}
        component={Section}
        // Placeholders. calculateMetadata replaces all four from the timeline itself,
        // so the section's real length is never restated in two places.
        durationInFrames={1}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{ src: `timeline/${section}.json`, timeline: null, focus: {}, plates: null }}
        calculateMetadata={async ({ props }) => {
          const timeline: Timeline = await fetch(staticFile(props.src)).then((r) => r.json());
          // Measured by focus.mjs, which render.mjs runs before it bundles. Absent is
          // fine and means centred — it is only ever a correction to the crop.
          const focus: Focus = await fetch(staticFile(`focus/${section}.json`))
            .then((r) => (r.ok ? r.json() : {}))
            .catch(() => ({}));
          // Written by plates.mjs, which render.mjs also runs before it bundles. Null
          // means this section was generated against a room rather than a green screen,
          // and every clip plays whole, exactly as it did before the key existed.
          const plates: Plates | null = await fetch(staticFile(`plates/${section}.json`))
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null);
          return {
            durationInFrames: timeline.durationInFrames,
            fps: timeline.fps,
            width: timeline.width,
            height: timeline.height,
            props: { ...props, timeline, focus, plates },
          };
        }}
      />
    ))}
  </>
);
