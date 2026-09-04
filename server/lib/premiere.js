// Final Cut Pro XML (xmeml v4) — the interchange format Premiere Pro imports.
//
// The same timeline that feeds Remotion feeds this: clip order, source paths and one
// trim frame per segment. Premiere opens it as a cuts-only sequence with every clip
// already trimmed at the end of speech, which is the point — the padding from snapping
// duration up to the model's ladder never reaches the edit.
//
// Two things about xmeml that are easy to get wrong and fail silently on import:
//
//  1. **Audio needs its own clipitems.** A video-only clipitem imports as a silent
//     clip, which for a talking head is the whole content missing. Each segment
//     therefore appears on a video track and an audio track, joined by <link>.
//  2. **A file is declared once and referenced thereafter.** Repeating the full <file>
//     body for every clipitem makes Premiere treat each as a separate master clip;
//     later references must be the bare <file id="..."/>.
//
// Frames, not seconds, everywhere: `in`/`out` are source frames, `start`/`end` are
// timeline frames, and they are the same numbers buildTimeline already computed.

import path from "node:path";

/** XML text escape. Section labels come from the sheet, so they are not trusted markup. */
const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * Absolute path -> the file URL Premiere expects.
 * Windows wants `file://localhost/D:/dir/clip.mp4`, forward slashes, percent-encoded.
 */
export function pathUrl(absFile) {
  const p = String(absFile).replace(/\\/g, "/");
  const encoded = p.split("/").map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ":")).join("/");
  return "file://localhost/" + encoded.replace(/^\/+/, "");
}

/** "480p" at 16:9 -> 854x480. The sequence matches the clips so they fill the frame. */
export function pixelsFor(resolution = "1080p", aspect = "16:9") {
  const h = /4k|2160/i.test(resolution) ? 2160 : /2k|1440/i.test(resolution) ? 1440
    : /1080/.test(resolution) ? 1080 : /720/.test(resolution) ? 720 : /480/.test(resolution) ? 480
    : parseInt(resolution, 10) || 1080;
  const [aw, ah] = String(aspect).split(":").map(Number);
  const ratio = aw && ah ? aw / ah : 16 / 9;
  // Even widths only — odd dimensions break some codecs on export.
  return { width: Math.round((h * ratio) / 2) * 2, height: h };
}

const rate = (fps) => `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;

/**
 * Build the XML for one section.
 *
 * `timeline` is a timeline/<section>.json as written by buildTimeline; `dir` is the
 * project folder its clip paths are relative to. Segments with no clip are skipped —
 * a partly rendered section still produces a usable sequence of what exists.
 */
export function buildFcpXml(timeline, dir, { width, height, name } = {}) {
  const fps = timeline.fps || 30;
  const px = width && height ? { width, height } : { width: timeline.width || 1920, height: timeline.height || 1080 };
  const segments = (timeline.segments || []).filter((s) => s.clip);
  const seqName = name || `Section ${timeline.section}`;

  const video = [];
  const audio = [];
  const links = [];
  const seenFiles = new Map(); // clip path -> file id
  let playhead = 0;

  segments.forEach((seg, i) => {
    const n = i + 1;
    const out = Math.min(seg.trimAfter ?? seg.clipFrames, seg.clipFrames);
    const start = playhead;
    const end = start + out;
    playhead = end;

    const vId = `clipitem-v${n}`, aId = `clipitem-a${n}`;
    const clipName = `${timeline.section} · ${seg.id}`;

    // The file body once; every later clipitem refers to it by id.
    let fileEl;
    if (seenFiles.has(seg.clip)) {
      fileEl = `<file id="${seenFiles.get(seg.clip)}"/>`;
    } else {
      const fileId = `file-${n}`;
      seenFiles.set(seg.clip, fileId);
      fileEl =
        `<file id="${fileId}">` +
          `<name>${esc(path.basename(seg.clip))}</name>` +
          `<pathurl>${esc(pathUrl(path.resolve(dir, seg.clip)))}</pathurl>` +
          rate(fps) +
          `<duration>${seg.clipFrames}</duration>` +
          `<media>` +
            `<video><samplecharacteristics>${rate(fps)}<width>${px.width}</width><height>${px.height}</height></samplecharacteristics></video>` +
            `<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>` +
          `</media>` +
        `</file>`;
    }

    const common = (id, label) =>
      `<clipitem id="${id}">` +
        `<name>${esc(clipName)}</name>` +
        `<duration>${seg.clipFrames}</duration>` +
        rate(fps) +
        `<start>${start}</start><end>${end}</end>` +
        `<in>0</in><out>${out}</out>` +
        (label === "video" ? fileEl : `<file id="${seenFiles.get(seg.clip)}"/>`);

    video.push(common(vId, "video") + `<link><linkclipref>${vId}</linkclipref></link><link><linkclipref>${aId}</linkclipref></link></clipitem>`);
    audio.push(
      `<clipitem id="${aId}">` +
        `<name>${esc(clipName)}</name>` +
        `<duration>${seg.clipFrames}</duration>` +
        rate(fps) +
        `<start>${start}</start><end>${end}</end>` +
        `<in>0</in><out>${out}</out>` +
        `<file id="${seenFiles.get(seg.clip)}"/>` +
        `<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>` +
        `<link><linkclipref>${vId}</linkclipref></link><link><linkclipref>${aId}</linkclipref></link>` +
      `</clipitem>`
    );
  });

  const xml =
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-${esc(timeline.section)}">
    <name>${esc(seqName)}</name>
    <duration>${playhead}</duration>
    ${rate(fps)}
    <media>
      <video>
        <format><samplecharacteristics>${rate(fps)}<width>${px.width}</width><height>${px.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>
        <track>${video.join("")}</track>
      </video>
      <audio>
        <format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>
        <track>${audio.join("")}</track>
      </audio>
    </media>
  </sequence>
</xmeml>
`;

  return { xml, frames: playhead, seconds: playhead / fps, segments: segments.length, width: px.width, height: px.height };
}
