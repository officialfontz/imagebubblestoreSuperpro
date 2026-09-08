#!/usr/bin/env node
// ── Rebuild the delivery-proof catalog from R2 ────────────────────────────────
//
// Every capture writes a sidecar JSON next to its image bytes, so the monthly
// catalog files are reconstructible rather than precious. If one is lost,
// truncated, or deleted by mistake, this walks cap/ in the bucket and rebuilds
// the affected months from the sidecars.
//
//   node scripts/rebuild-captures.mjs              # every month found
//   node scripts/rebuild-captures.mjs 2026-09      # one month
//   node scripts/rebuild-captures.mjs --dry-run
//
// Safe to re-run. Existing rows are kept and only missing ones are restored,
// so it can also be used to reconcile after a partial failure.

import { AwsClient } from "aws4fetch";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ── Env ───────────────────────────────────────────────────────────────────────
function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const value = m[2].trim().replace(/^["']|["']$/g, "");
      if (!(m[1] in process.env)) process.env[m[1]] = value;
    }
  }
}
loadEnv();

const cfg = {
  accountId: process.env.R2_ACCOUNT_ID?.trim(),
  accessKeyId: process.env.R2_ACCESS_KEY_ID?.trim(),
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim(),
  bucket: process.env.R2_BUCKET?.trim(),
};
if (!cfg.accountId || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucket) {
  console.error("ต้องตั้ง R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET ก่อน");
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONLY_MONTH = args.find((a) => /^\d{4}-\d{2}$/.test(a)) ?? null;

const client = new AwsClient({
  accessKeyId: cfg.accessKeyId,
  secretAccessKey: cfg.secretAccessKey,
  service: "s3",
  region: "auto",
});

const objectUrl = (key) =>
  `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/` +
  key.split("/").map(encodeURIComponent).join("/");

// Must match catalogKey() in lib/storage.ts.
const digest = createHash("sha256")
  .update(`bubble-vault-catalog:${cfg.secretAccessKey}`)
  .digest("hex");
const monthKey = (month) => {
  const override = process.env.VAULT_CATALOG_KEY?.trim();
  if (override) {
    const pinned = override.replace(/^\/+/, "");
    const dir = pinned.includes("/") ? pinned.slice(0, pinned.lastIndexOf("/")) : "";
    return `${dir ? `${dir}/` : ""}_captures/${month}.json`;
  }
  return `_captures/${digest}/${month}.json`;
};

async function listObjects(prefix) {
  const out = [];
  let token;
  do {
    const url = new URL(`https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}`);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("max-keys", "1000");
    if (token) url.searchParams.set("continuation-token", token);
    const res = await client.fetch(url.toString());
    if (!res.ok) throw new Error(`R2 list failed (${res.status})`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([^<]+)<\/Key>/.exec(m[1])?.[1];
      if (key) out.push(key);
    }
    token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
  } while (token);
  return out;
}

async function getJson(key) {
  const res = await client.fetch(objectUrl(key));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 GET ${key} failed (${res.status})`);
  return res.json();
}

async function putJson(key, value) {
  const body = new TextEncoder().encode(JSON.stringify(value, null, 2));
  const res = await client.fetch(objectUrl(key), {
    method: "PUT",
    body,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(body.byteLength),
      "Cache-Control": "no-store",
    },
  });
  if (!res.ok) throw new Error(`R2 PUT ${key} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

// ── Rebuild ───────────────────────────────────────────────────────────────────
console.log(`กำลังอ่านไฟล์ข้อมูลหลักฐานจาก bucket "${cfg.bucket}"…`);

const keys = await listObjects(ONLY_MONTH ? `cap/${ONLY_MONTH}/` : "cap/");
const sidecars = keys.filter((k) => k.endsWith(".json"));
console.log(`เจอไฟล์ข้อมูล ${sidecars.length} รายการ`);

const byMonth = new Map();
let unreadable = 0;

for (const key of sidecars) {
  const month = /^cap\/(\d{4}-\d{2})\//.exec(key)?.[1];
  if (!month) continue;
  let record;
  try {
    record = await getJson(key);
  } catch {
    unreadable++;
    continue;
  }
  if (!record?.id || !record?.key || !record?.url) { unreadable++; continue; }
  if (!byMonth.has(month)) byMonth.set(month, []);
  byMonth.get(month).push({ ...record, kind: "capture" });
}

if (unreadable > 0) console.log(`ข้ามไฟล์ที่อ่านไม่ได้ ${unreadable} รายการ`);

for (const [month, records] of [...byMonth].sort()) {
  const key = monthKey(month);
  const existing = (await getJson(key).catch(() => null)) ?? { version: 1, month, captures: [] };
  const known = new Set((existing.captures ?? []).map((c) => c.id));
  const restored = records.filter((r) => !known.has(r.id));

  if (restored.length === 0) {
    console.log(`${month}: ครบอยู่แล้ว (${known.size} รายการ)`);
    continue;
  }

  const next = {
    version: 1,
    month,
    captures: [...(existing.captures ?? []), ...restored]
      .sort((a, b) => (b.capturedAt ?? b.createdAt) - (a.capturedAt ?? a.createdAt)),
  };

  console.log(`${month}: กู้คืน ${restored.length} รายการ → รวม ${next.captures.length}`);
  if (!DRY_RUN) await putJson(key, next);
}

console.log(DRY_RUN ? "\n--dry-run: ยังไม่ได้เขียนอะไร" : "\nเสร็จแล้ว");
