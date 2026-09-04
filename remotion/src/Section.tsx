import React from "react";
import { AbsoluteFill } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { Segment } from "./Segment";
import { theme } from "./theme";
import type { Timeline } from "./timeline";

export type SectionProps = { src: string; timeline: Timeline | null };

/**
 * A section is one continuous piece of narration that Wan could only make 30 seconds at
 * a time, so every join here is mid-sentence. Each segment plays to its own trimAfter —
 * the snapped-up padding is cut here rather than reaching the viewer — and the joins
 * cross-dissolve over the silence that trim leaves behind.
 *
 * The arithmetic matches buildTimeline(): n segments overlap at n-1 joins, so the series
 * is shorter than the sum of its parts by exactly transition.frames per join.
 */
export const Section: React.FC<SectionProps> = ({ timeline }) => {
  if (!timeline) return null;
  const { segments, transition, avatar } = timeline;

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg, fontFamily: theme.font }}>
      <TransitionSeries>
        {segments.map((segment, i) => (
          <React.Fragment key={segment.id}>
            {i > 0 ? (
              <TransitionSeries.Transition
                presentation={fade()}
                timing={linearTiming({ durationInFrames: transition.frames })}
              />
            ) : null}
            <TransitionSeries.Sequence durationInFrames={segment.trimAfter}>
              <Segment segment={segment} avatar={avatar} />
            </TransitionSeries.Sequence>
          </React.Fragment>
        ))}
      </TransitionSeries>
    </AbsoluteFill>
  );
};
