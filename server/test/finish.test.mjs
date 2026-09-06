// Regression: a restart between the render and the sheet write must not strand a paid clip.
// Run: node server/test/finish.test.mjs
//
// orphan.test.mjs covers the first half of that story — a job that finishes with no run
// waiting on it still gets recorded as "rendered". This covers the half that was missing:
// "rendered" is not the end of a paid row. The clip still has to be uploaded and the
// sheet's Complete column still has to be ticked, and until it is, `isPending` excludes
// the row from every future run — so it is never finished and a re-render pays twice.
//
// The Wasabi leg is left unconfigured here on purpose: the AWS SDK does not go through
// global fetch, so it cannot be mocked the way the rest of the network is, and
// `npm run check:wasabi` already probes it for real. What is exercised is the ordering
// and the idempotence, which is where the bug was.
import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

process.env.VENICE_API_KEY = "test-key-not-used";

let failures = 0;
const eq = (a, b, label) => {
  if (JSON.stringify(a) === JSON.stringify(b)) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n         expected ${JSON.stringify(b)}\n         actual   ${JSON.stringify(a)}`);
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "venice-finish-"));

// A service account key good enough to sign a real assertion; the exchange is mocked.
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyFile = path.join(dir, "service-account.json");
await fs.writeFile(keyFile, JSON.stringify({
  type: "service_account",
  client_email: "test@example.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  token_uri: "https://oauth2.googleapis.com/token",
}));
process.env.GOOGLE_SERVICE_ACCOUNT_KEY = keyFile;

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const sheetWrites = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("oauth2.googleapis.com/token")) return json({ access_token: "tok", expires_in: 3600 });
  if (u.includes("values:batchUpdate")) {
    sheetWrites.push(JSON.parse(init.body).data);
    return json({ totalUpdatedCells: 1 });
  }
  throw new Error("unexpected fetch: " + u);
};

const batch = await import(new URL("../lib/batch.js", import.meta.url).href);

await batch.writeSettings(dir, {
  sheetUrl: "https://docs.google.com/spreadsheets/d/SHEET_ID_FOR_TEST/edit",
  markCompleteInSheet: true,
  wasabi: { bucket: "", prefix: "", region: "" }, // unconfigured: upload is skipped, not failed
});

// Exactly the state the restart left behind: paid for, downloaded, nothing after that.
await batch.withRows(dir, (s) => {
  s.sheetUrl = "https://docs.google.com/spreadsheets/d/SHEET_ID_FOR_TEST/edit";
  s.tab = "";
  s.columns = { section: 0, id: 1, timing: 2, visual: 3, script: 4, complete: 5 };
  s.rows = [
    { id: "1.1", section: "1.0", n: 1, sheetRow: 2, status: "rendered", jobId: "job_gone", clip: "clips/1.0/1.1.mp4", wasabiKey: null, sheetComplete: false, error: null, at: null },
    { id: "1.2", section: "1.0", n: 2, sheetRow: 3, status: "pending", jobId: null, clip: null, wasabiKey: null, sheetComplete: false, error: null, at: null },
  ];
});

const first = await batch.finishStranded(dir);

eq(first.map((r) => r.id), ["1.1"], "the stranded row is the one with a clip and no sheet tick");
eq(sheetWrites.length, 1, "the sheet is written exactly once");
eq(sheetWrites[0], [{ range: "F2", majorDimension: "ROWS", values: [["x"]] }], "column F of the row's own sheet line gets an x");

const after = (await batch.listRows(dir)).find((r) => r.id === "1.1");
eq(after.sheetComplete, true, "and the row records that the sheet now says so");
eq(after.error, null, "with no error recorded");

const untouched = (await batch.listRows(dir)).find((r) => r.id === "1.2");
eq(untouched.status, "pending", "a row that never rendered is left alone");
eq(untouched.sheetComplete, false, "and is not marked in the sheet");

// Idempotence is the whole point: this runs at the head of every run, and a second pass
// must not tick an already-ticked row or re-upload a clip that is already up.
const second = await batch.finishStranded(dir);
eq(second.length, 0, "a second pass finds nothing left stranded");
eq(sheetWrites.length, 1, "and writes to the sheet again zero times");

// A clip deleted by hand between the render and the upload. Running at the head of every
// run means this must not throw — an aborted run over a missing file would be a worse
// failure than the one being fixed — and it must never tick Complete for a clip nobody has.
await batch.writeSettings(dir, { wasabi: { bucket: "test-bucket", prefix: "p", region: "us-east-1" } });
await batch.withRows(dir, (s) => {
  // 1.1 is settled by now — it uploaded before the bucket question arises here.
  s.rows.find((r) => r.id === "1.1").wasabiKey = "p/clips/1.0/1.1.mp4";
  s.rows.push({ id: "1.3", section: "1.0", n: 3, sheetRow: 4, status: "rendered", jobId: "job_gone_too", clip: "clips/1.0/1.3.mp4", wasabiKey: null, sheetComplete: false, error: null, at: null });
});

const third = await batch.finishStranded(dir);
const gone = (await batch.listRows(dir)).find((r) => r.id === "1.3");
eq(third.map((r) => r.id), ["1.3"], "a row whose clip has vanished is still visited");
eq(gone.status, "failed", "and is recorded as failed rather than silently left rendered");
eq(/clip missing from disk/.test(gone.error || ""), true, "with an error that names the cause");
eq(gone.sheetComplete, false, "and is never marked Complete for a clip nobody has");
eq(gone.clip, null, "and stops claiming a clip that is not there");
eq(sheetWrites.length, 1, "so the sheet is not written for it");

const fourth = await batch.finishStranded(dir);
eq(fourth.length, 0, "so the next run does not walk back into the same dead end");

await fs.rm(dir, { recursive: true, force: true });
console.log(failures ? `\nFAIL ${failures} assertion(s)` : "\nPASS all assertions");
process.exit(failures ? 1 : 0);
