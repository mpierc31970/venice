// Connectivity check for Google Sheets write-back.
// Run: node --env-file=.env server/test/gsheets.check.mjs
//
// Proves, in order: the key loads, a token is issued, the Sheets API is enabled,
// the sheet is shared with the service account, and a write actually lands.
// The write goes to a scratch cell far outside the data and is cleaned up.
import * as g from "../lib/gsheets.js";

const url = process.env.SHEET_URL;
if (!url) { console.error("SHEET_URL is not set in .env"); process.exit(1); }

const st = await g.status();
console.log("key:", st.configured ? `${st.clientEmail} (project ${st.projectId})` : `NOT CONFIGURED — ${st.error}`);
if (!st.configured) process.exit(1);

try {
  const d = await g.describe(url);
  console.log("title:", d.title);
  console.log("tabs: ", d.tabs.map((t) => `${t.title} (${t.rows}x${t.cols})`).join(", "));

  const tab = g.quoteTab(d.tabs[0].title);
  const head = await g.getValues(url, `${tab}!A1:H1`);
  console.log("header:", JSON.stringify(head[0]));

  const rows = await g.getValues(url, `${tab}!A2:F4`);
  console.log("first ids:", rows.map((r) => r[1]).join(", "));
  console.log("complete col:", JSON.stringify(rows.map((r) => r[5] ?? "")));
  console.log("READ  OK");

  // Write to a scratch cell well below the data, then clear it.
  const probe = `${tab}!H200`;
  const stamp = `check ${new Date().toISOString()}`;
  await g.setCells(url, [{ range: probe, value: stamp }]);
  const back = await g.getValues(url, probe);
  const wrote = back?.[0]?.[0] === stamp;
  await g.setCells(url, [{ range: probe, value: "" }]);
  console.log(wrote ? "WRITE OK (probe cell cleared)" : "WRITE FAILED — value did not read back");
  process.exit(wrote ? 0 : 1);
} catch (e) {
  console.error("FAILED:", e.message);
  process.exit(1);
}
