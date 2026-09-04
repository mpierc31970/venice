// Free probe: what does /video/quote actually return? Run: node --env-file=.env server/test/quote.probe.mjs
import { videoQuote } from "../venice.js";
const q = await videoQuote({
  model: "wan-3-0-reference-to-video", duration: "30s",
  resolution: "480p", aspect_ratio: "16:9", audio: true,
});
console.log(JSON.stringify(q, null, 2));
