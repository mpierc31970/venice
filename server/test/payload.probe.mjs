// Free: builds the exact /video/queue payload for one row and measures it. Sends nothing.
// Run: node --env-file=.env server/test/payload.probe.mjs <projectDir> <rowId>
import { readSettings, listRows, buildRequest } from "../lib/batch.js";

const dir = process.argv[2];
const rowId = process.argv[3] || "1.17";
const settings = await readSettings(dir);
const row = (await listRows(dir)).find((r) => r.id === rowId);
if (!row) { console.error("no such row", rowId); process.exit(1); }

const body = await buildRequest(dir, settings, row);
const json = JSON.stringify(body);
const kb = (n) => (n / 1024).toFixed(0) + " KB";

console.log("segment", row.id, "|", row.wantSeconds + "s ->", row.duration);
console.log("payload total:", kb(Buffer.byteLength(json)), `(${(Buffer.byteLength(json) / 1024 / 1024).toFixed(2)} MB)`);
for (const [i, u] of body.reference_image_urls.entries()) {
  console.log(`  reference_image_urls[${i}] = ${u.slice(0, 32)}…  ${kb(u.length)}`);
}
console.log("fields sent:", Object.keys(body).join(", "));
console.log("image_url present:", "image_url" in body);
console.log("\nnon-image fields:");
console.log(JSON.stringify({ ...body, reference_image_urls: body.reference_image_urls.map((u) => `<${u.slice(5, 14)} ${u.length} chars>`) }, null, 2).slice(0, 900));
