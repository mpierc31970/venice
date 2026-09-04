import React from "react";
import { AbsoluteFill } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { Segment } from "./Segment";
import { theme } from "./theme";
import type { Focus, Timeline } from "./timeline";

export type SectionProps = { src: string; timeline: Timeline | null; focus: Focus };

/**
 * A section is one continuous piece of narration that Wan could only make 30 seconds at
 * a time, so every join here is mid-sentence. Each segment plays to its own trimAfter —
 * the snapped-up padding is cut here rather than reaching the viewer.
 *
 * Joins are straight cuts (`transition.frames === 0`), and a TransitionSeries with no
 * Transition elements between its sequences is exactly that: one frame ends a segment,
 * the next frame begins the following one. The overlapping branch stays because the
 * timeline says what the join is and this reads it rather than assuming.
 *
 * The arithmetic matches buildTimeline(): n segments overlap at n-1 joins, so the series
 * is shorter than the sum of its parts by exactly transition.frames per join — zero.
 */
export const Section: React.FC<SectionProps> = ({ timeline, focus }) => {
  if (!timeline) return null;
  const { segments, transition, avatar } = timeline;

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg, fontFamily: theme.font }}>
      <TransitionSeries>
        {segments.map((segment, i) => (
          <React.Fragment key={segment.id}>
            {i > 0 && transition.frames > 0 ? (
              <TransitionSeries.Transition
                presentation={fade()}
                timing={linearTiming({ durationInFrames: transition.frames })}
              />
            ) : null}
            <TransitionSeries.Sequence durationInFrames={segment.trimAfter}>
              <Segment segment={segment} avatar={avatar} focus={focus[segment.id]} />
            </TransitionSeries.Sequence>
          </React.Fragment>
        ))}
      </TransitionSeries>
    </AbsoluteFill>
  );
};
