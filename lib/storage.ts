// ── Vault object storage ──────────────────────────────────────────────────────
// Two drivers behind one interface:
//
//   "r2"    Cloudflare R2 over the S3 API. This is the production driver.
//           Uploads go Railway → R2 once; every *read* afterwards is served by
//           Cloudflare's CDN with zero egress cost and zero Railway involvement.
//           That is the whole point of the vault: a redeploy, a crash, or a
//           rate-limit on the storefront can never break an embedded image.
//
//   "local" Plain files under UPLOAD_DIR, served by /api/uploads/*. Used in dev
//           and as a graceful degrade when R2 env vars are absent, so the vault
//           is usable the moment you clone the repo — no cloud account needed.
//
// aws4fetch is used instead of @aws-sdk/client-s3: it is ~7 kB and does nothing
// but SigV4-sign a fetch(), which matters on a 256 MB Railway container.

import { AwsClient } from "aws4fetch";
import fs from "fs/promises";
import path from "path";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "public", "uploads");

export type StorageDriver = "r2" | "local";

type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Public base for direct links, no trailing slash. */
  publicBase: string;
};

function readR2Config(): R2Config | null {
  const accountId       = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId     = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket          = process.env.R2_BUCKET?.trim();
  const publicBase      = process.env.R2_PUBLIC_BASE?.trim().replace(/\/+$/, "");
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !publicBase) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket, publicBase };
}

export function getDriver(): StorageDriver {
  return readR2Config() ? "r2" : "local";
}

export type StorageStatus = {
  driver: StorageDriver;
  publicBase: string;
  missing: string[];
  /** True when links can go through Cloudflare's /cdn-cgi/image resizer. */
  canResize: boolean;
};

/** Human-readable status for the vault's storage card and copy menu. */
export function storageStatus(): StorageStatus {
  const required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE"];
  const missing  = required.filter((k) => !process.env[k]?.trim());
  const cfg      = readR2Config();
  // The free *.r2.dev hostname is served straight from R2 and never touches the
  // Cloudflare image pipeline, so offering resize links there would hand the
  // user URLs that 404.
  let canResize = false;
  if (cfg) {
    try {
      canResize = !/\.r2\.dev$/i.test(new URL(cfg.publicBase).hostname);
    } catch {
      canResize = false; // malformed R2_PUBLIC_BASE — assume no edge resizer
    }
  }
  return {
    driver: cfg ? "r2" : "local",
    publicBase: cfg?.publicBase ?? "/uploads",
    missing,
    canResize,
  };
}

let _client: AwsClient | null = null;
function awsClient(cfg: R2Config): AwsClient {
  if (!_client) {
    _client = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: "s3",
      region: "auto",
    });
  }
  return _client;
}

function objectUrl(cfg: R2Config, key: string): string {
  // Path-style addressing — R2 does not support virtual-host style on the
  // *.r2.cloudflarestorage.com endpoint.
  const safeKey = key.split("/").map(encodeURIComponent).join("/");
  return `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${safeKey}`;
}

/** Local-driver filename. Flattened because /api/uploads/* serves a flat dir. */
function localName(key: string): string {
  return "vault-" + key.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export type PutResult = { key: string; url: string };

/**
 * Store `body` under `key` and return the permanent public URL.
 * `key` should already be collision-free (a UUID stem) — this never overwrites
 * intentionally, but R2 PUT is last-write-wins if you hand it a duplicate.
 */
export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<PutResult> {
  const cfg = readR2Config();

  if (!cfg) {
    const filename = localName(key);
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    await fs.writeFile(path.join(UPLOAD_DIR, filename), body);
    return { key: filename, url: `/uploads/${filename}` };
  }

  // A fresh, exact-size copy. sharp returns Buffers that are views into a shared
  // pool, so handing the raw view to fetch risks sending the wrong byte range.
  const payload = new Uint8Array(body);

  const res = await awsClient(cfg).fetch(objectUrl(cfg, key), {
    method: "PUT",
    body: payload,
    headers: {
      "Content-Type": contentType,
      // R2 rejects a PUT with no Content-Length (411 MissingContentLength).
      // Whether fetch derives one from a typed-array body depends on the undici
      // version, so this worked on the Node release used locally and failed on
      // the one the deploy runs. Setting it explicitly removes the dependency.
      "Content-Length": String(payload.byteLength),
      // Keys embed a UUID and are never reused, so browsers and Cloudflare can
      // hold them forever. This is what makes a page with 300 vault images
      // essentially free after the first view.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });

  if (!res.ok) {
    throw new Error(`R2 PUT failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  return { key, url: `${cfg.publicBase}/${key}` };
}

// ── Catalog object ────────────────────────────────────────────────────────────
// The catalog (names, collections, dimensions) lives in the bucket alongside
// the images rather than on the server's disk. A container filesystem is
// ephemeral — a redeploy wipes it and the images become an unlisted pile of
// bytes — and requiring a mounted volume to avoid that made the app impossible
// to host anywhere else.
//
// A public bucket serves every key it holds but cannot be listed, so an
// unguessable path is genuinely unreachable — that is what keeps image names
// and collections private without a second bucket or extra rules.
//
// The path is derived from the R2 secret access key, NOT from HMAC_KEY. Every
// machine that can reach this bucket holds the same R2 credentials by
// definition, so they all agree on where the catalog lives; HMAC_KEY is per
// deployment, and deriving from it put the laptop and the deployed app on
// different paths, each seeing an empty library.
//
// Set VAULT_CATALOG_KEY to pin the location explicitly — needed if the R2 token
// is ever rotated, since the derived path would otherwise move with it.

const CATALOG_PREFIX = "_catalog";

async function catalogKey(cfg: R2Config): Promise<string> {
  const override = process.env.VAULT_CATALOG_KEY?.trim();
  if (override) return override.replace(/^\/+/, "");

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`bubble-vault-catalog:${cfg.secretAccessKey}`),
  );
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${CATALOG_PREFIX}/${hex}.json`;
}

/** Reads the catalog. `null` means "no catalog stored yet", not an error. */
export async function getCatalog(): Promise<string | null> {
  const cfg = readR2Config();
  if (!cfg) return null;

  const res = await awsClient(cfg).fetch(objectUrl(cfg, await catalogKey(cfg)));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 catalog GET failed (${res.status})`);
  return res.text();
}

export async function putCatalog(json: string): Promise<void> {
  const cfg = readR2Config();
  if (!cfg) throw new Error("R2 is not configured");

  const payload = new TextEncoder().encode(json);
  const res = await awsClient(cfg).fetch(objectUrl(cfg, await catalogKey(cfg)), {
    method: "PUT",
    body: payload,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(payload.byteLength),
      // Never cache: this object changes on every upload, rename, and move.
      "Cache-Control": "no-store",
    },
  });
  if (!res.ok) {
    throw new Error(`R2 catalog PUT failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

/** Lists every image object in the bucket — used to rebuild a lost catalog. */
export async function listImageObjects(): Promise<{ key: string; size: number }[]> {
  const cfg = readR2Config();
  if (!cfg) return [];

  const out: { key: string; size: number }[] = [];
  let token: string | undefined;

  do {
    const url = new URL(`https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}`);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", "img/");
    url.searchParams.set("max-keys", "1000");
    if (token) url.searchParams.set("continuation-token", token);

    const res = await awsClient(cfg).fetch(url.toString());
    if (!res.ok) throw new Error(`R2 list failed (${res.status})`);
    const xml = await res.text();

    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([^<]+)<\/Key>/.exec(m[1])?.[1];
      const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] ?? 0);
      if (key) out.push({ key, size });
    }

    token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
  } while (token);

  return out;
}

/** Best-effort delete. A missing object is treated as success. */
// turbopackIgnore below: UPLOAD_DIR comes from the environment, so the bundler
// cannot prove which directory is touched and would trace the whole project
// into the server output. `key` is always a name this module generated.
export async function deleteObject(key: string): Promise<void> {
  const cfg = readR2Config();

  if (!cfg) {
    await fs.unlink(path.join(/*turbopackIgnore: true*/ UPLOAD_DIR, path.basename(key))).catch(() => undefined);
    return;
  }

  const res = await awsClient(cfg).fetch(objectUrl(cfg, key), { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`R2 DELETE failed (${res.status})`);
  }
}

/** Round-trips a tiny object to prove the credentials and bucket really work. */
export async function testConnection(): Promise<{ ok: boolean; detail: string }> {
  const cfg = readR2Config();
  if (!cfg) return { ok: false, detail: "ยังไม่ได้ตั้งค่า R2 — ตอนนี้เก็บลงดิสก์ของ Railway" };
  const key = `_healthcheck/${Date.now()}.txt`;
  try {
    await putObject(key, Buffer.from("ok"), "text/plain");
    await deleteObject(key);
    return { ok: true, detail: `เชื่อมต่อ R2 สำเร็จ — bucket "${cfg.bucket}"` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message.slice(0, 300) };
  }
}
