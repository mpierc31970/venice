// Wasabi (S3-compatible) uploads for the talking-head batch.
//
// Two things about Wasabi that are easy to get wrong, and both fail as a silent 403
// rather than as an error that says what is wrong:
//
//  1. **us-east-1 has no region segment in its endpoint** — it is `s3.wasabisys.com`,
//     while every other region is `s3.<region>.wasabisys.com`. Getting this wrong
//     authenticates against the wrong host and reads as "access denied".
//  2. **The bucket's region is part of the signature.** Signing for us-east-1 against a
//     bucket that lives in us-central-1 is a 403, not a redirect. So the region is
//     discovered from the bucket rather than guessed, and cached.
//
// Which is why a 403 is never retried: it is a configuration answer, not a transient
// one, and retrying it 109 times just takes longer to tell you the same thing.
import fs from "node:fs/promises";
import {
  S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand, HeadBucketCommand,
} from "@aws-sdk/client-s3";

/** us-east-1 is the special case: no region segment. */
export const endpointFor = (region) =>
  region === "us-east-1" ? "https://s3.wasabisys.com" : `https://s3.${region}.wasabisys.com`;

export function credentials() {
  const accessKeyId = process.env.WASABI_ACCESS_KEY;
  const secretAccessKey = process.env.WASABI_SECRET_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("WASABI_ACCESS_KEY and WASABI_SECRET_KEY are not set in .env");
  }
  return { accessKeyId, secretAccessKey };
}

/** Merge the per-batch settings with the environment. Settings win. */
export function resolve(cfg = {}) {
  const bucket = cfg.bucket || process.env.WASABI_BUCKET || "";
  if (!bucket) throw new Error("No Wasabi bucket configured");
  return {
    bucket,
    region: cfg.region || process.env.WASABI_REGION || "",
    prefix: String(cfg.prefix ?? process.env.WASABI_PREFIX ?? "").replace(/^\/+|\/+$/g, ""),
  };
}

const clients = new Map(); // "bucket|region" -> S3Client
function client(region) {
  if (!clients.has(region)) {
    clients.set(region, new S3Client({
      region,
      endpoint: endpointFor(region),
      credentials: credentials(),
      forcePathStyle: true, // bucket-in-path — Wasabi's virtual-host style needs DNS that new buckets may lack
    }));
  }
  return clients.get(region);
}

/**
 * The bucket's real region.
 * Wasabi answers a HeadBucket against the wrong region with `x-amz-bucket-region` in the
 * error, which is how the right one is found without the user looking it up. Cached per
 * bucket, since it cannot change.
 */
const regionCache = new Map(); // bucket -> region
export async function discoverRegion(bucket, hint = "us-east-1") {
  if (regionCache.has(bucket)) return regionCache.get(bucket);
  try {
    await client(hint).send(new HeadBucketCommand({ Bucket: bucket }));
    regionCache.set(bucket, hint);
    return hint;
  } catch (e) {
    const found =
      e?.$response?.headers?.["x-amz-bucket-region"] ||
      e?.$metadata?.bucketRegion ||
      e?.BucketRegion ||
      e?.Region;
    if (found && found !== hint) {
      // Prove the discovered region actually works before handing it back.
      await client(found).send(new HeadBucketCommand({ Bucket: bucket }));
      regionCache.set(bucket, found);
      return found;
    }
    throw e;
  }
}

/** Settings + a confirmed region, ready to use. Throws with a usable message if not. */
export async function ready(cfg) {
  const s = resolve(cfg);
  const region = s.region || (await discoverRegion(s.bucket));
  return { ...s, region, endpoint: endpointFor(region) };
}

const key = (prefix, rest) => (prefix ? `${prefix}/${rest}` : rest);
export const clipKey = (prefix, section, id) => key(prefix, `clips/${section}/${id}.mp4`);
export const sectionKey = (prefix, id) => key(prefix, `sections/${id}.mp4`);

/** A 403 is a configuration answer. Retrying it is pointless, so it is marked fatal. */
function wrap(e, where) {
  const status = e?.$metadata?.httpStatusCode;
  const err = new Error(`Wasabi ${where} failed (${status || e.name || "error"}): ${e.message}`);
  err.status = status;
  err.fatal = status === 403 || status === 401;
  return err;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry 5xx and network errors with backoff. Never retry 403/401 — that never gets better. */
async function send(region, command, where, attempts = 3) {
  for (let i = 1; ; i++) {
    try { return await client(region).send(command); }
    catch (e) {
      const err = wrap(e, where);
      if (err.fatal || (err.status && err.status < 500 && err.status !== 429) || i >= attempts) throw err;
      await sleep(500 * 2 ** (i - 1));
    }
  }
}

async function put(cfg, k, body, contentType) {
  const s = await ready(cfg);
  await send(s.region, new PutObjectCommand({
    Bucket: s.bucket, Key: k, Body: body, ContentType: contentType,
  }), `PUT ${k}`);
  return k;
}

/** Upload one segment clip. Returns the key it landed at. */
export async function putClip(cfg, { section, id, file }) {
  const s = await ready(cfg);
  return put(cfg, clipKey(s.prefix, section, id), await fs.readFile(file), "video/mp4");
}

/** Upload one assembled section video — the actual deliverable. */
export async function putSection(cfg, { id, file }) {
  const s = await ready(cfg);
  return put(cfg, sectionKey(s.prefix, id), await fs.readFile(file), "video/mp4");
}

/**
 * Prove credentials, bucket, region and the endpoint quirk before any video exists, by
 * round-tripping a 1 KB object. Discovering a misconfigured bucket at segment 109
 * instead of segment 1 is a $147 mistake.
 */
export async function check(cfg) {
  try {
    const s = await ready(cfg);
    const k = key(s.prefix, ".healthcheck.txt");
    const body = Buffer.alloc(1024, `venice-studio healthcheck ${new Date().toISOString()}\n`);
    await send(s.region, new PutObjectCommand({ Bucket: s.bucket, Key: k, Body: body, ContentType: "text/plain" }), `PUT ${k}`);
    const head = await send(s.region, new HeadObjectCommand({ Bucket: s.bucket, Key: k }), `HEAD ${k}`);
    await send(s.region, new DeleteObjectCommand({ Bucket: s.bucket, Key: k }), `DELETE ${k}`);
    return {
      configured: true, ok: true,
      bucket: s.bucket, region: s.region, endpoint: s.endpoint, prefix: s.prefix,
      wrote: k, bytes: head.ContentLength,
      sampleKeys: { clip: clipKey(s.prefix, "1.0", "1.1"), section: sectionKey(s.prefix, "1.0") },
    };
  } catch (e) {
    return { configured: true, ok: false, error: e.message, status: e.status ?? null, fatal: !!e.fatal };
  }
}
