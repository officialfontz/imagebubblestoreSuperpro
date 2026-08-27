#!/usr/bin/env node
/**
 * Rebuilds the catalog from what is actually in the bucket.
 *
 * The images are the durable part: they carry no dependency on the catalog, so
 * a lost or corrupted catalog is recoverable — every object in the bucket gets
 * an entry again, and every link that was already handed out keeps working
 * because the keys never change.
 *
 * What cannot be recovered is the metadata that only ever lived in the catalog:
 * display names, collections, and trash state. Names fall back to the object's
 * UUID and everything lands unfiled. That is why this is a recovery tool, not a
 * routine one.
 *
 *   node scripts/rebuild-catalog.mjs --dry     # report, change nothing
 *   node scripts/rebuild-catalog.mjs           # merge missing entries in
 *   node scripts/rebuild-catalog.mjs --replace # discard the catalog, start over
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import { AwsClient } from "aws4fetch";

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const REPLACE = args.includes("--replace");

// ── Env (Next loads .env.local automatically; a bare node process does not) ───
for (const file of [".env.local", ".env"]) {
  let text;
  try { text = await fs.readFile(path.join(process.cwd(), file), "utf8"); } catch { continue; }
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const accountId = process.env.R2_ACCOUNT_ID?.trim();
const bucket = process.env.R2_BUCKET?.trim();
const publicBase = process.env.R2_PUBLIC_BASE?.trim().replace(/\/+$/, "");
if (!accountId || !bucket || !publicBase || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
  console.error("ต้องตั้งค่า R2 ให้ครบก่อน (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET / R2_PUBLIC_BASE)");
  process.exit(1);
}

const client = new AwsClient({
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  service: "s3",
  region: "auto",
});

const objectUrl = (key) =>
  `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

// Must match catalogKey() in lib/storage.ts.
const catalogKey = `_catalog/${createHash("sha256")
  .update(`catalog:${process.env.HMAC_KEY?.trim() || "bubble-vault-dev-key"}`)
  .digest("hex")}.json`;

// ── List every image object ──────────────────────────────────────────────────
async function listImages() {
  const out = [];
  let token;
  do {
    const url = new URL(`https://${accountId}.r2.cloudflarestorage.com/${bucket}`);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", "img/");
    url.searchParams.set("max-keys", "1000");
    if (token) url.searchParams.set("continuation-token", token);

    const res = await client.fetch(url.toString());
    if (!res.ok) throw new Error(`list failed (${res.status})`);
    const xml = await res.text();

    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([^<]+)<\/Key>/.exec(m[1])?.[1];
      const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] ?? 0);
      const modified = /<LastModified>([^<]+)<\/LastModified>/.exec(m[1])?.[1];
      if (key) out.push({ key, size, modified });
    }
    token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
  } while (token);
  return out;
}

const MIME = { webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif" };

async function main() {
  console.log(`bucket: ${bucket}  →  ${publicBase}`);
  if (DRY) console.log("โหมด --dry: จะไม่เขียนอะไรเลย\n");

  const objects = await listImages();
  console.log(`พบไฟล์รูปใน bucket: ${objects.length} ไฟล์\n`);
  if (objects.length === 0) return;

  // ── Existing catalog ───────────────────────────────────────────────────────
  let existing = { version: 1, albums: [], images: [] };
  const res = await client.fetch(objectUrl(catalogKey));
  if (res.ok) {
    existing = JSON.parse(await res.text());
    console.log(`แคตตาล็อกเดิม: ${existing.images.length} รูป · ${existing.albums.length} คอลเลกชัน`);
  } else if (res.status === 404) {
    console.log("ไม่พบแคตตาล็อกเดิม — จะสร้างใหม่ทั้งหมด");
  } else {
    throw new Error(`อ่านแคตตาล็อกไม่สำเร็จ (${res.status})`);
  }

  const base = REPLACE ? { version: 1, albums: existing.albums, images: [] } : existing;
  const known = new Set(base.images.map((i) => i.key));
  const added = [];

  for (const obj of objects) {
    if (known.has(obj.key)) continue;

    // Read the object back to recover its real dimensions — they are not in the
    // listing, and a card with no size reads as broken.
    let width = 0, height = 0;
    try {
      const get = await client.fetch(objectUrl(obj.key));
      if (get.ok) {
        const meta = await sharp(Buffer.from(await get.arrayBuffer())).metadata();
        width = meta.width ?? 0;
        height = meta.height ?? 0;
      }
    } catch { /* dimensions are nice to have, not worth failing the rebuild */ }

    const ext = obj.key.split(".").pop()?.toLowerCase() ?? "webp";
    const stem = obj.key.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "image";

    added.push({
      id: randomUUID(),
      key: obj.key,
      url: `${publicBase}/${obj.key}`,
      // The display name is gone with the old catalog; the UUID stem is at
      // least stable and unique, and every one of these is easy to rename.
      name: `กู้คืน-${stem.slice(0, 8)}`,
      albumId: null,
      width, height,
      bytes: obj.size,
      mime: MIME[ext] ?? "image/webp",
      createdAt: obj.modified ? Date.parse(obj.modified) : Date.now(),
    });
    console.log(`  + ${obj.key}  ${width}x${height}  ${(obj.size / 1024).toFixed(0)}KB`);
  }

  if (added.length === 0) {
    console.log("\nแคตตาล็อกครบอยู่แล้ว ไม่มีอะไรต้องกู้");
    return;
  }

  const next = {
    version: 1,
    albums: base.albums,
    images: [...added, ...base.images].sort((a, b) => b.createdAt - a.createdAt),
  };

  console.log(`\nจะเพิ่ม ${added.length} รูป → รวมเป็น ${next.images.length} รูป`);
  if (DRY) return;

  const payload = new TextEncoder().encode(JSON.stringify(next, null, 2));
  const put = await client.fetch(objectUrl(catalogKey), {
    method: "PUT",
    body: payload,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(payload.byteLength),
      "Cache-Control": "no-store",
    },
  });
  if (!put.ok) throw new Error(`เขียนแคตตาล็อกไม่สำเร็จ (${put.status})`);
  console.log("บันทึกแคตตาล็อกขึ้น R2 แล้ว — refresh หน้าเว็บได้เลย");
}

main().catch((e) => { console.error(`\nผิดพลาด: ${e.message}`); process.exit(1); });
