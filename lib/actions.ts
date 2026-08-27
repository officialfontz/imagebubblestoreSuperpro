"use server";

// ── Vault server actions ──────────────────────────────────────────────────────
// Every action re-verifies the password (requireAuth also enforces the
// same-origin guard), so replaying a Next-Action POST without credentials gets
// nowhere even if the edge proxy is somehow bypassed.

import sharp from "sharp";
import { randomUUID } from "crypto";
import { headers } from "next/headers";
import { requireAuth } from "./auth";
import { checkMagicBytes, getTrustedClientIp } from "./security";
import { loadVault, updateVault } from "./store";
import { putObject, deleteObject, testConnection, storageStatus } from "./storage";
import type { VaultData, VaultImage, VaultAlbum } from "./types";

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

// ── Encoding config ───────────────────────────────────────────────────────────
// R2 egress is free and 10 GB of storage covers tens of thousands of images, so
// there is nothing to buy by compressing hard — quality is the only thing worth
// optimising for. 3000 px keeps a generous original for Cloudflare's read-time
// resizer (/cdn-cgi/image/width=…) to work from, and q92 is high enough that
// artefacts around text and flat colour do not show.
//
// Override per-deployment if a different trade-off is wanted.
const MAX_DIMENSION   = Number(process.env.VAULT_MAX_DIMENSION ?? 3000);
const WEBP_QUALITY    = Number(process.env.VAULT_WEBP_QUALITY ?? 92);
const MAX_INPUT_BYTES = 15 * 1024 * 1024;

/**
 * Flat-colour graphics — price cards, banners, logos, screenshots — often come
 * out SMALLER as lossless WebP than as a high-quality lossy one, because large
 * areas of identical colour compress almost for free. Photographs never do.
 *
 * Source format is a good enough proxy: PNG and GIF are what graphics arrive
 * as, JPEG is what cameras produce. Trying lossless on every 12 MP photo would
 * burn CPU on a candidate that cannot win.
 */
function shouldTryLossless(ext: string): boolean {
  return ext === "png" || ext === "gif" || ext === "webp";
}

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png":  "png",
  "image/webp": "webp",
  "image/gif":  "gif",
};

// ── Upload rate limit ─────────────────────────────────────────────────────────
// Dropping 60 files at once is the normal way to use this thing, so the limit
// is generous — but still bounded, so leaked credentials cannot fill a bucket.
const _rate = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 120;
const RATE_WINDOW = 60_000;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = _rate.get(ip);
  if (!entry || now > entry.resetAt) {
    if (_rate.size > 2000) for (const [k, v] of _rate) if (now > v.resetAt) _rate.delete(k);
    _rate.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return false;
  }
  if (entry.count >= RATE_LIMIT) return true;
  entry.count++;
  return false;
}

function monthFolder(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Strip the extension and anything that would look odd in a filename column. */
function cleanName(raw: string): string {
  const base = raw.replace(/\.[A-Za-z0-9]{1,5}$/, "").trim();
  return (base || "ไม่มีชื่อ").slice(0, 120);
}

// ── Upload ────────────────────────────────────────────────────────────────────

export async function uploadToVault(formData: FormData): Promise<ActionResult<{ image: VaultImage }>> {
  await requireAuth();
  try {
    const ip = getTrustedClientIp(await headers()) ?? "unknown";
    if (isRateLimited(ip)) return { ok: false, error: "อัปโหลดถี่เกินไป — รอสักครู่แล้วลองใหม่" };

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "ไม่พบไฟล์" };
    if (file.size > MAX_INPUT_BYTES) return { ok: false, error: "ไฟล์ใหญ่เกิน 15MB" };

    // Trust the MIME type (verified against magic bytes below), not the
    // filename — clipboard pastes routinely arrive with no extension at all.
    const ext = MIME_TO_EXT[file.type];
    if (!ext) return { ok: false, error: "รองรับเฉพาะ JPG / PNG / WebP / GIF" };

    const input = Buffer.from(await file.arrayBuffer());
    if (!checkMagicBytes(input, ext)) return { ok: false, error: "เนื้อไฟล์ไม่ตรงกับชนิดที่แจ้ง" };

    const albumIdRaw = formData.get("albumId");
    const albumId = typeof albumIdRaw === "string" && albumIdRaw ? albumIdRaw : null;

    // ── Encode ────────────────────────────────────────────────────────────────
    const isAnimated = ext === "gif";
    let output: Uint8Array = input;
    let outExt = ext;
    let outMime = file.type;
    let width = 0;
    let height = 0;
    let blur: string | undefined;

    try {
      const resized = () =>
        sharp(input, { animated: isAnimated })
          .rotate() // apply EXIF orientation, then drop the tag
          .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true });

      const lossy = await resized()
        .webp({ quality: WEBP_QUALITY, effort: 4 })
        .toBuffer({ resolveWithObject: true });

      // Lossless is a free upgrade whenever it also happens to be smaller —
      // perfect fidelity at no cost in bytes. Animated frames are excluded:
      // lossless multiplies their size with no chance of winning.
      let best = lossy;
      if (!isAnimated && shouldTryLossless(ext)) {
        try {
          const lossless = await resized()
            .webp({ lossless: true, effort: 4 })
            .toBuffer({ resolveWithObject: true });
          if (lossless.data.length < lossy.data.length) best = lossless;
        } catch {
          // Keep the lossy candidate — it already succeeded.
        }
      }

      const { data, info } = best;
      width  = info.width;
      // sharp reports an animated WebP's height as frames × frame-height.
      height = isAnimated && info.pages && info.pages > 1 ? Math.round(info.height / info.pages) : info.height;

      // Re-encoding can still come out larger than the source. Never hand back
      // a file worse than the one we were given.
      if (data.length < input.length) {
        output = data;
        outExt = "webp";
        outMime = "image/webp";
      } else {
        const meta = await sharp(input).metadata();
        width = meta.width ?? 0;
        height = meta.height ?? 0;
      }

      // ~200-byte placeholder so the grid paints instantly on a cold cache.
      const tiny = await sharp(input, { animated: false })
        .resize(16, 16, { fit: "inside" })
        .webp({ quality: 40 })
        .toBuffer();
      blur = `data:image/webp;base64,${tiny.toString("base64")}`;
    } catch (e) {
      // Corrupt-but-valid-header input: keep the original bytes rather than
      // failing the upload outright.
      console.error("vault encode failed, storing original:", e);
    }

    const key = `img/${monthFolder()}/${randomUUID()}.${outExt}`;
    const { key: storedKey, url } = await putObject(key, output, outMime);

    const image: VaultImage = {
      id: randomUUID(),
      key: storedKey,
      url,
      name: cleanName(file.name || "image"),
      albumId,
      width,
      height,
      bytes: output.length,
      mime: outMime,
      createdAt: Date.now(),
      ...(blur ? { blur } : {}),
    };

    const res = await updateVault<{ image: VaultImage }>((data) => {
      data.images.unshift(image);
      return { next: data, result: { image } };
    });
    if ("error" in res) return { ok: false, error: res.error };

    return { ok: true, image: res.image };
  } catch (e) {
    console.error("uploadToVault error:", e);
    return { ok: false, error: (e as Error).message?.slice(0, 200) || "อัปโหลดไม่สำเร็จ" };
  }
}

// ── Images ────────────────────────────────────────────────────────────────────

export async function deleteVaultImages(ids: string[]): Promise<ActionResult<{ deleted: number }>> {
  await requireAuth();
  if (!Array.isArray(ids) || ids.length === 0) return { ok: false, error: "ไม่ได้เลือกรูป" };

  const vault = await loadVault();
  const targets = vault.images.filter((i) => ids.includes(i.id));

  // Remove the objects first. If the bucket delete fails we still drop the
  // metadata — an orphaned object costs storage, a dangling row breaks the UI.
  await Promise.all(targets.map((i) => deleteObject(i.key).catch((e) => {
    console.error("vault deleteObject failed:", i.key, e);
  })));

  const idSet = new Set(ids);
  const res = await updateVault<{ deleted: number }>((data) => {
    const before = data.images.length;
    data.images = data.images.filter((i) => !idSet.has(i.id));
    return { next: data, result: { deleted: before - data.images.length } };
  });
  if ("error" in res) return { ok: false, error: res.error };
  return { ok: true, deleted: res.deleted };
}

export async function renameVaultImage(id: string, name: string): Promise<ActionResult> {
  await requireAuth();
  const clean = String(name ?? "").trim().slice(0, 120);
  if (!clean) return { ok: false, error: "ชื่อว่างไม่ได้" };

  const res = await updateVault<{ found: boolean }>((data) => {
    const img = data.images.find((i) => i.id === id);
    if (img) img.name = clean;
    return { next: data, result: { found: Boolean(img) } };
  });
  if ("error" in res) return { ok: false, error: res.error };
  if (!res.found) return { ok: false, error: "ไม่พบรูปนี้" };
  return { ok: true };
}

export async function moveVaultImages(ids: string[], albumId: string | null): Promise<ActionResult> {
  await requireAuth();
  if (!Array.isArray(ids) || ids.length === 0) return { ok: false, error: "ไม่ได้เลือกรูป" };

  const idSet = new Set(ids);
  const res = await updateVault<{ ok: boolean }>((data) => {
    const target = albumId && data.albums.some((a) => a.id === albumId) ? albumId : null;
    for (const img of data.images) if (idSet.has(img.id)) img.albumId = target;
    return { next: data, result: { ok: true } };
  });
  if ("error" in res) return { ok: false, error: res.error };
  return { ok: true };
}

// ── Albums ────────────────────────────────────────────────────────────────────

export async function createVaultAlbum(name: string, emoji: string): Promise<ActionResult<{ album: VaultAlbum }>> {
  await requireAuth();
  const clean = String(name ?? "").trim().slice(0, 60);
  if (!clean) return { ok: false, error: "ตั้งชื่อหมวดก่อน" };

  const album: VaultAlbum = {
    id: randomUUID(),
    name: clean,
    emoji: String(emoji || "📁").slice(0, 8),
    createdAt: Date.now(),
  };

  const res = await updateVault<{ album: VaultAlbum }>((data) => {
    data.albums.push(album);
    return { next: data, result: { album } };
  });
  if ("error" in res) return { ok: false, error: res.error };
  return { ok: true, album: res.album };
}

export async function updateVaultAlbum(id: string, name: string, emoji: string): Promise<ActionResult> {
  await requireAuth();
  const clean = String(name ?? "").trim().slice(0, 60);
  if (!clean) return { ok: false, error: "ตั้งชื่อหมวดก่อน" };

  const res = await updateVault<{ found: boolean }>((data) => {
    const album = data.albums.find((a) => a.id === id);
    if (album) {
      album.name = clean;
      album.emoji = String(emoji || "📁").slice(0, 8);
    }
    return { next: data, result: { found: Boolean(album) } };
  });
  if ("error" in res) return { ok: false, error: res.error };
  if (!res.found) return { ok: false, error: "ไม่พบหมวดนี้" };
  return { ok: true };
}

/** Deletes the album only — its images become unfiled, never destroyed. */
export async function deleteVaultAlbum(id: string): Promise<ActionResult> {
  await requireAuth();
  const res = await updateVault<{ ok: boolean }>((data) => {
    data.albums = data.albums.filter((a) => a.id !== id);
    for (const img of data.images) if (img.albumId === id) img.albumId = null;
    return { next: data, result: { ok: true } };
  });
  if ("error" in res) return { ok: false, error: res.error };
  return { ok: true };
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

export async function getVaultStorageStatus(): Promise<{ driver: string; publicBase: string; missing: string[] }> {
  await requireAuth();
  return storageStatus();
}

export async function testVaultStorage(): Promise<{ ok: boolean; detail: string }> {
  await requireAuth();
  return testConnection();
}

export async function reloadVault(): Promise<VaultData> {
  await requireAuth();
  return loadVault();
}
