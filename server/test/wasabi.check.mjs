// Wasabi connectivity probe. Free: round-trips a 1 KB object and deletes it.
// Run: node --env-file=.env server/test/wasabi.check.mjs
import { check } from "../lib/wasabi.js";

const r = await check({ prefix: process.env.WASABI_PREFIX || "lesson1" });
console.log(JSON.stringify(r, null, 2));
console.log(r.ok ? "\nWASABI OK" : "\nWASABI FAILED");
process.exit(r.ok ? 0 : 1);
