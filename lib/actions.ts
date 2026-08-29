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
import { putObject, getObject, deleteObject, testConnection, storageStatus } from "./storage";
import { canPurge, purgeUrls } from "./purge";
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

/**
 * Moves images to the trash. Nothing is destroyed: the R2 objects stay put, so
 * a link already embedded on another site keeps working and a restore brings
 * the image back under the URL it always had. `purgeVaultImages` is what
 * actually deletes bytes.
 */
export async function deleteVaultImages(ids: string[]): Promise<ActionResult<{ deleted: number }>> {
  await requireAuth();
  if (!Array.isArray(ids) || ids.length === 0) return { ok: false, error: "ไม่ได้เลือกรูป" };

  const idSet = new Set(ids);
  const now = Date.now();
  const res = await updateVault<{ deleted: number }>((data) => {
    let deleted = 0;
    for (const img of data.images) {
      if (idSet.has(img.id) && !img.deletedAt) {
        img.deletedAt = now;
        deleted++;
      }
    }
    return { next: data, result: { deleted } };
  });
  if ("error" in res) return { ok: false, error: res.error };
  return { ok: true, deleted: res.deleted };
}

/** Takes images back out of the trash. */
export async function restoreVaultImages(ids: string[]): Promise<ActionResult<{ restored: number }>> {
  await requireAuth();
  if (!Array.isArray(ids) || ids.length === 0) return { ok: false, error: "ไม่ได้เลือกรูป" };

  const idSet = new Set(ids);
  const res = await updateVault<{ restored: number }>((data) => {
    let restored = 0;
    for (const img of data.images) {
      if (idSet.has(img.id) && img.deletedAt) {
        delete img.deletedAt;
        restored++;
      }
    }
    return { next: data, result: { restored } };
  });
  if ("error" in res) return { ok: false, error: res.error };
  return { ok: true, restored: res.restored };
}

/**
 * Permanently deletes the bytes. Only ever applied to images already in the
 * trash, so a single mis-click can never destroy anything.
 */
export async function purgeVaultImages(ids: string[]): Promise<ActionResult<{ purged: number }>> {
  await requireAuth();
  if (!Array.isArray(ids) || ids.length === 0) return { ok: false, error: "ไม่ได้เลือกรูป" };

  const vault = await loadVault();
  const idSet = new Set(ids);
  // Refuse anything not already binned — purge is not a shortcut past delete.
  const targets = vault.images.filter((i) => idSet.has(i.id) && i.deletedAt);
  if (targets.length === 0) return { ok: false, error: "ไม่มีรูปในถังขยะที่ตรงกับที่เลือก" };

  await Promise.all(targets.map((i) => deleteObject(i.key).catch((e) => {
    // An orphaned object costs a little storage; a dangling row breaks the UI.
    // Dropping the metadata anyway is the lesser evil.
    console.error("vault deleteObject failed:", i.key, e);
  })));

  // Without this the edge keeps serving a deleted image for up to a year —
  // best-effort, since the metadata removal below matters more.
  if (canPurge()) {
    await purgeUrls(targets.map((i) => i.url)).catch(() => undefined);
  }

  const purgeIds = new Set(targets.map((i) => i.id));
  const res = await updateVault<{ purged: number }>((data) => {
    const before = data.images.length;
    data.images = data.images.filter((i) => !purgeIds.has(i.id));
    return { next: data, result: { purged: before - data.images.length } };
  });
  if ("error" in res) return { ok: false, error: res.error };
  return { ok: true, purged: res.purged };
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

// ── Downscaling an existing image ─────────────────────────────────────────────
// Re-encoding at a smaller width, in place.
//
// The URL must survive. A storefront accumulates hundreds of embedded links
// over years, and any scheme that changes one means going back to edit every
// page that used it — so the object is overwritten at its existing key and the
// stale copy is purged from Cloudflare's edge.
//
// Without purge credentials that is not safe: the one-year immutable cache
// would keep the old bytes in circulation for months and the resize would look
// like it did nothing. So when purge is unavailable we fall back to writing a
// new key, and the UI says which of the two will happen before you commit.

/** Encodes at the requested width and reports the result without saving. */
export async function previewResize(
  id: string,
  width: number,
): Promise<ActionResult<{ bytes: number; width: number; height: number }>> {
  await requireAuth();

  const image = (await loadVault()).images.find((i) => i.id === id);
  if (!image) return { ok: false, error: "ไม่พบรูปนี้" };
  if (!Number.isFinite(width) || width < 16) return { ok: false, error: "ขนาดไม่ถูกต้อง" };

  const source = await getObject(image.key);
  if (!source) return { ok: false, error: "อ่านไฟล์ต้นฉบับไม่ได้" };

  try {
    const { data, info } = await encodeAtWidth(source, width);
    return { ok: true, bytes: data.length, width: info.width, height: info.height };
  } catch (e) {
    console.error("previewResize failed:", e);
    return { ok: false, error: "ย่อรูปไม่สำเร็จ" };
  }
}

export async function applyResize(
  id: string,
  width: number,
): Promise<ActionResult<{ image: VaultImage }>> {
  await requireAuth();

  const vault = await loadVault();
  const image = vault.images.find((i) => i.id === id);
  if (!image) return { ok: false, error: "ไม่พบรูปนี้" };
  if (!Number.isFinite(width) || width < 16) return { ok: false, error: "ขนาดไม่ถูกต้อง" };

  const source = await getObject(image.key);
  if (!source) return { ok: false, error: "อ่านไฟล์ต้นฉบับไม่ได้" };

  const keepUrl = canPurge();

  let stored: { key: string; url: string };
  let encoded: { data: Buffer; info: { width: number; height: number } };
  try {
    encoded = await encodeAtWidth(source, width);
    stored = keepUrl
      // Same key: the URL is the thing being protected here.
      ? await putObject(image.key, encoded.data, "image/webp")
      : await putObject(`img/${monthFolder()}/${randomUUID()}.webp`, encoded.data, "image/webp");
  } catch (e) {
    console.error("applyResize encode/put failed:", e);
    return { ok: false, error: "ย่อรูปไม่สำเร็จ" };
  }

  if (keepUrl) {
    // The bytes are already replaced; until the edge is purged, visitors keep
    // getting the old ones. A failure here is worth reporting rather than
    // leaving the user to wonder why nothing changed.
    const purge = await purgeUrls([image.url]);
    if (!purge.ok) {
      return { ok: false, error: `ย่อไฟล์แล้ว แต่ล้างแคช CDN ไม่สำเร็จ (${purge.reason ?? "ไม่ทราบสาเหตุ"}) — รูปอาจยังขึ้นเป็นของเดิมสักพัก` };
    }
  }

  const next: VaultImage = {
    ...image,
    key: stored.key,
    url: stored.url,
    width: encoded.info.width,
    height: encoded.info.height,
    bytes: encoded.data.length,
    mime: "image/webp",
  };

  const res = await updateVault<{ ok: boolean }>((data) => {
    const i = data.images.findIndex((x) => x.id === id);
    if (i !== -1) data.images[i] = next;
    return { next: data, result: { ok: i !== -1 } };
  });
  if ("error" in res) return { ok: false, error: res.error };

  // Only relevant on the fallback path — on the same-key path there is no old
  // object, and deleting it would delete the replacement.
  if (!keepUrl && stored.key !== image.key) {
    await deleteObject(image.key).catch((e) => console.error("applyResize cleanup failed:", e));
  }

  return { ok: true, image: next };
}

async function encodeAtWidth(source: Uint8Array, width: number) {
  return sharp(source, { animated: false })
    .resize(width, undefined, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY, effort: 4 })
    .toBuffer({ resolveWithObject: true });
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
