// Free probe: what rate-limit headers does Venice return? Run: node --env-file=.env server/test/limits.probe.mjs
import { veniceFetch } from "../venice.js";
const res = await veniceFetch("/models?type=video");
console.log("status", res.status);
for (const [k, v] of res.headers.entries()) {
  if (/limit|remaining|reset|retry|concurren|quota|balance|tier/i.test(k)) console.log(`${k}: ${v}`);
}
