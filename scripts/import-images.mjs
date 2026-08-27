#!/usr/bin/env node
/**
 * Bulk-import existing images into the vault.
 *
 * Written for the one-time move off a site's own `public/uploads` folder, but it
 * works for any directory of images. Each file is re-encoded with the same
 * settings the app uses on upload, stored through the same driver (R2 when
 * configured, local disk otherwise), and appended to vault.json.
 *
 *   node scripts/import-images.mjs --from ../bubble-shop/public/uploads
 *   node scripts/import-images.mjs --from <dir> --collection "รูปเดิมจากร้าน"
 *   node scripts/import-images.mjs --from <dir> --rewrite ../bubble-shop/data/store.json
 *   node scripts/import-images.mjs --from <dir> --dry
 *
 * Flags
 *   --from <dir>          Source directory. Required.
 *   --collection <name>   Put everything in this collection (created if new).
 *   --rewrite <file>      After importing, swap every `/uploads/<name>` in this
 *                         file for its new URL. Repeatable. Writes a .bak first.
 *   --dry                 Report what would happen; touch nothing.
 *
 * The encode settings below mirror lib/actions.ts. If you change them there,
 * change them here too — otherwise imported images will not match uploaded ones.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { AwsClient } from "aws4fetch";

const MAX_DIMENSION = 2400;
const WEBP_QUALITY = 85;
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

// ── Args ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { from: null, collection: null, rewrite: [], dry: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--from") out.from = argv[++i];
    else if (arg === "--collection") out.collection = argv[++i];
    else if (arg === "--rewrite") out.rewrite.push(argv[++i]);
    else if (arg === "--dry") out.dry = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`ไม่รู้จัก flag: ${arg}`);
  }
  return out;
}

// ── Env ───────────────────────────────────────────────────────────────────────
// Next loads .env.local automatically; a bare node process does not.

async function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    let text;
    try {
      text = await fs.readFile(path.join(process.cwd(), file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, key, raw] = match;
      if (process.env[key] !== undefined) continue; // real env wins
      process.env[key] = raw.trim().replace(/^["']|["']$/g, "");
    }
  }
}

// ── Storage (mirrors lib/storage.ts) ──────────────────────────────────────────

function readR2Config() {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  const publicBase = process.env.R2_PUBLIC_BASE?.trim().replace(/\/+$/, "");
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !publicBase) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket, publicBase };
}

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "public", "uploads");

let client = null;
async function putObject(key, body, contentType) {
  const cfg = readR2Config();

  if (!cfg) {
    const filename = "vault-" + key.replace(/[^A-Za-z0-9._-]+/g, "-");
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    await fs.writeFile(path.join(UPLOAD_DIR, filename), body);
    return { key: filename, url: `/uploads/${filename}` };
  }

  client ??= new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: "auto",
  });

  const encoded = key.split("/").map(encodeURIComponent).join("/");
  const res = await client.fetch(
    `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${encoded}`,
    {
      method: "PUT",
      body,
      headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=31536000, immutable" },
    },
  );
  if (!res.ok) throw new Error(`R2 PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);

  return { key, url: `${cfg.publicBase}/${key}` };
}

// ── Encode (mirrors lib/actions.ts) ───────────────────────────────────────────

async function encode(input, ext) {
  const animated = ext === ".gif";
  try {
    const { data, info } = await sharp(input, { animated })
      .rotate()
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY, effort: 4 })
      .toBuffer({ resolveWithObject: true });

    const height = animated && info.pages > 1 ? Math.round(info.height / info.pages) : info.height;

    // Small flat-colour PNGs can re-encode larger as WebP. Never make a file
    // worse than the one we were handed.
    if (data.length < input.length) {
      return { body: data, ext: "webp", mime: "image/webp", width: info.width, height };
    }
    const meta = await sharp(input).metadata();
    const mime = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" }[ext];
    return { body: input, ext: ext.slice(1), mime, width: meta.width ?? 0, height: meta.height ?? 0 };
  } catch (e) {
    throw new Error(`อ่านไฟล์ภาพไม่ได้: ${e.message}`);
  }
}

async function blurPlaceholder(input) {
  try {
    const tiny = await sharp(input, { animated: false }).resize(16, 16, { fit: "inside" }).webp({ quality: 40 }).toBuffer();
    return `data:image/webp;base64,${tiny.toString("base64")}`;
  } catch {
    return undefined;
  }
}

// ── Vault file ────────────────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const VAULT_PATH = path.join(DATA_DIR, "vault.json");

async function readVault() {
  try {
    const parsed = JSON.parse(await fs.readFile(VAULT_PATH, "utf8"));
    return {
      version: 1,
      albums: Array.isArray(parsed.albums) ? parsed.albums : [],
      images: Array.isArray(parsed.images) ? parsed.images : [],
    };
  } catch {
    return { version: 1, albums: [], images: [] };
  }
}

async function writeVault(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${VAULT_PATH}.import.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, VAULT_PATH);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.from) {
    console.log(`
ใช้งาน:
  node scripts/import-images.mjs --from <โฟลเดอร์รูป> [ตัวเลือก]

ตัวเลือก:
  --collection <ชื่อ>   ใส่รูปทั้งหมดลงคอลเลกชันนี้ (สร้างให้ถ้ายังไม่มี)
  --rewrite <ไฟล์>      แก้ /uploads/<ชื่อไฟล์> ในไฟล์นี้ให้เป็น URL ใหม่ (ใส่ซ้ำได้)
  --dry                 ลองดูเฉย ๆ ไม่เขียนอะไรเลย
`);
    process.exit(args.help ? 0 : 1);
  }

  await loadEnv();

  const cfg = readR2Config();
  console.log(cfg ? `→ ปลายทาง: Cloudflare R2 (${cfg.bucket}) → ${cfg.publicBase}` : "→ ปลายทาง: ดิสก์ (ยังไม่ได้ตั้งค่า R2)");
  if (args.dry) console.log("→ โหมด --dry: จะไม่เขียนอะไรทั้งสิ้น\n");

  const sourceDir = path.resolve(args.from);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort();

  if (files.length === 0) {
    console.log(`ไม่พบไฟล์รูปใน ${sourceDir}`);
    return;
  }
  console.log(`พบ ${files.length} ไฟล์ใน ${sourceDir}\n`);

  const vault = await readVault();

  // Re-running the script should not duplicate what is already in the vault.
  const alreadyImported = new Set(vault.images.map((i) => i.importedFrom).filter(Boolean));

  let album = null;
  if (args.collection) {
    album = vault.albums.find((a) => a.name === args.collection) ?? null;
    if (!album) {
      album = { id: randomUUID(), name: args.collection, emoji: "📦", createdAt: Date.now() };
      if (!args.dry) vault.albums.push(album);
      console.log(`สร้างคอลเลกชัน "${album.name}"\n`);
    }
  }

  const now = Date.now();
  const mapping = {};
  let imported = 0, skipped = 0, failed = 0, bytesIn = 0, bytesOut = 0;

  for (const [index, name] of files.entries()) {
    const label = `[${String(index + 1).padStart(String(files.length).length)}/${files.length}] ${name}`;

    if (alreadyImported.has(name)) {
      console.log(`${label} — ข้าม (นำเข้าแล้ว)`);
      skipped++;
      continue;
    }

    try {
      const input = await fs.readFile(path.join(sourceDir, name));
      const out = await encode(input, path.extname(name).toLowerCase());
      bytesIn += input.length;
      bytesOut += out.body.length;

      const monthFolder = new Date().toISOString().slice(0, 7);
      const key = `img/${monthFolder}/${randomUUID()}.${out.ext}`;

      if (args.dry) {
        console.log(`${label} — ${(input.length / 1024).toFixed(0)}KB → ${(out.body.length / 1024).toFixed(0)}KB (dry)`);
        mapping[`/uploads/${name}`] = "(dry-run)";
        imported++;
        continue;
      }

      const stored = await putObject(key, out.body, out.mime);

      vault.images.push({
        id: randomUUID(),
        key: stored.key,
        url: stored.url,
        name: name.replace(/\.[A-Za-z0-9]{1,5}$/, "").slice(0, 120),
        albumId: album?.id ?? null,
        width: out.width,
        height: out.height,
        bytes: out.body.length,
        mime: out.mime,
        // Newest-first ordering in the UI is by createdAt; keep the source order
        // stable rather than giving every image the same timestamp.
        createdAt: now - (files.length - index) * 1000,
        blur: await blurPlaceholder(input),
        // Lets a re-run skip what it already did.
        importedFrom: name,
      });

      mapping[`/uploads/${name}`] = stored.url;
      imported++;
      console.log(`${label} — ${(input.length / 1024).toFixed(0)}KB → ${(out.body.length / 1024).toFixed(0)}KB ✓`);
    } catch (e) {
      failed++;
      console.error(`${label} — ล้มเหลว: ${e.message}`);
    }
  }

  if (!args.dry && imported > 0) {
    await writeVault(vault);
    const mapPath = path.join(DATA_DIR, "import-map.json");
    await fs.writeFile(mapPath, JSON.stringify(mapping, null, 2), "utf8");
    console.log(`\nบันทึกลง ${VAULT_PATH}`);
    console.log(`ตารางลิงก์เก่า→ใหม่: ${mapPath}`);
  }

  const saved = bytesIn ? Math.round((1 - bytesOut / bytesIn) * 100) : 0;
  console.log(`\nสรุป: นำเข้า ${imported} · ข้าม ${skipped} · ล้มเหลว ${failed}`);
  if (bytesIn) {
    console.log(`ขนาด: ${(bytesIn / 1048576).toFixed(1)}MB → ${(bytesOut / 1048576).toFixed(1)}MB (เล็กลง ${saved}%)`);
  }

  // ── Rewrite ────────────────────────────────────────────────────────────────
  for (const target of args.rewrite) {
    const file = path.resolve(target);
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (e) {
      console.error(`\nแก้ไฟล์ ${file} ไม่ได้: ${e.message}`);
      continue;
    }

    let replaced = 0;
    let next = text;
    for (const [oldPath, newUrl] of Object.entries(mapping)) {
      const parts = next.split(oldPath);
      if (parts.length === 1) continue;
      replaced += parts.length - 1;
      // A dry run still reports the count, so you can see the blast radius
      // before letting the script near someone else's data file.
      if (!args.dry) next = parts.join(newUrl);
    }

    if (replaced === 0) {
      console.log(`\n${file}: ไม่พบลิงก์ที่ต้องแก้`);
      continue;
    }

    if (args.dry) {
      console.log(`\n${file}: จะแก้ ${replaced} จุด (dry)`);
      continue;
    }

    // Backup before overwriting someone else's data file, always.
    const backup = `${file}.bak-${now}`;
    await fs.copyFile(file, backup);
    await fs.writeFile(file, next, "utf8");
    console.log(`\n${file}: แก้ ${replaced} จุด (สำรองไว้ที่ ${path.basename(backup)})`);
  }
}

main().catch((e) => {
  console.error(`\nผิดพลาด: ${e.message}`);
  process.exit(1);
});
