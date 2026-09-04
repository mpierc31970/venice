// Google Sheets read/write via a service account. No dependencies.
//
// Auth is the JWT-bearer flow: sign a short-lived assertion with the service
// account's private key, exchange it for an access token, cache until expiry.
// The sheet must be shared with the service account's client_email as Editor —
// sharing "anyone with the link" does NOT grant API access.
import fs from "node:fs/promises";
import crypto from "node:crypto";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const API = "https://sheets.googleapis.com/v4/spreadsheets";

let cachedKey = null;
let cachedToken = null; // { token, expiresAt }

/** Read the service account JSON named by GOOGLE_SERVICE_ACCOUNT_KEY. */
export async function loadKey(keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
  if (!keyPath) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not set (path to the service account JSON)");
  if (cachedKey?.path === keyPath) return cachedKey.key;
  let raw;
  try {
    raw = await fs.readFile(keyPath, "utf8");
  } catch {
    throw new Error(`Cannot read service account key at ${keyPath}`);
  }
  const key = JSON.parse(raw);
  if (key.type !== "service_account" || !key.private_key || !key.client_email) {
    throw new Error(`${keyPath} is not a service account key (expected type "service_account" with private_key and client_email)`);
  }
  cachedKey = { path: keyPath, key };
  return key;
}

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Exchange a signed JWT for an access token, cached until ~1 minute before expiry. */
export async function accessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;

  const key = await loadKey();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: SCOPE,
    aud: key.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signature = b64url(
    crypto.sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), key.private_key)
  );

  const res = await fetch(key.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`Google token exchange failed: ${detail}`);
  }
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.token;
}

/** Spreadsheet id out of any Google Sheets URL. */
export const sheetId = (url) => {
  const id = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(String(url || ""))?.[1];
  if (!id) throw new Error("Not a Google Sheets URL — expected .../spreadsheets/d/<id>/...");
  return id;
};

async function call(path, { method = "GET", body, query } = {}) {
  const token = await accessToken();
  const qs = query ? "?" + new URLSearchParams(query) : "";
  const res = await fetch(`${API}${path}${qs}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    if (res.status === 403 && /permission|caller does not have/i.test(msg)) {
      const key = await loadKey().catch(() => null);
      throw new Error(
        `Google Sheets denied access. Share the sheet with ${key?.client_email || "the service account"} as Editor. (${msg})`
      );
    }
    if (res.status === 403 && /has not been used|disabled/i.test(msg)) {
      throw new Error(`The Google Sheets API is not enabled for this project. Enable it, then retry. (${msg})`);
    }
    throw new Error(`Google Sheets: ${msg}`);
  }
  return data;
}

/** Tab names and grid sizes. */
export async function describe(url) {
  const data = await call(`/${sheetId(url)}`, { query: { fields: "properties.title,sheets.properties" } });
  return {
    title: data.properties?.title || "",
    tabs: (data.sheets || []).map((s) => ({
      title: s.properties.title,
      sheetId: s.properties.sheetId,
      rows: s.properties.gridProperties?.rowCount ?? 0,
      cols: s.properties.gridProperties?.columnCount ?? 0,
    })),
  };
}

/** Read a range, e.g. "Lesson 1!A1:F200". Returns a rectangular array of strings. */
export async function getValues(url, range) {
  const data = await call(`/${sheetId(url)}/values/${encodeURIComponent(range)}`, {
    query: { majorDimension: "ROWS", valueRenderOption: "UNFORMATTED_VALUE" },
  });
  return (data.values || []).map((row) => row.map((c) => (c == null ? "" : String(c))));
}

/** Write a range. `values` is an array of rows. */
export async function setValues(url, range, values) {
  return call(`/${sheetId(url)}/values/${encodeURIComponent(range)}`, {
    method: "PUT",
    query: { valueInputOption: "RAW" },
    body: { range, majorDimension: "ROWS", values },
  });
}

/**
 * Write single cells in one round trip.
 * `updates` is [{ range: "Lesson 1!F5", value: "x" }, …].
 */
export async function setCells(url, updates) {
  if (!updates.length) return { totalUpdatedCells: 0 };
  return call(`/${sheetId(url)}/values:batchUpdate`, {
    method: "POST",
    body: {
      valueInputOption: "RAW",
      data: updates.map((u) => ({ range: u.range, majorDimension: "ROWS", values: [[u.value]] })),
    },
  });
}

/** A1 column letter from a 0-based index: 0 -> A, 5 -> F, 26 -> AA. */
export function colLetter(index) {
  let n = index + 1, s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Quote a tab name for A1 notation when it contains spaces or quotes. */
export const quoteTab = (tab) =>
  /^[A-Za-z0-9_]+$/.test(tab) ? tab : `'${String(tab).replace(/'/g, "''")}'`;

/** Is write-back configured at all? Cheap check for status endpoints. */
export async function status() {
  try {
    const key = await loadKey();
    return { configured: true, clientEmail: key.client_email, projectId: key.project_id };
  } catch (e) {
    return { configured: false, error: e.message };
  }
}
