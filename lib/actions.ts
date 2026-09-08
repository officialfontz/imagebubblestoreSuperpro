"use server";

// ── Vault server actions ──────────────────────────────────────────────────────
// Every action re-verifies the password (requireAuth also enforces the
// same-origin guard), so replaying a Next-Action POST without credentials gets
// nowhere even if the edge proxy is somehow bypassed.

import { randomUUID } from "crypto";
import { headers } from "next/headers";
import { requireAuth, requireOwner } from "./auth";
import { checkMagicBytes, getTrustedClientIp } from "./security";
import { loadVault, updateVault } from "./store";
import { putObject, getObject, deleteObject, testConnection, storageStatus } from "./storage";
import { canPurge, purgeUrls } from "./purge";
import {
  MAX_INPUT_BYTES, MIME_TO_EXT, cleanName, encodeAtWidth, encodeImage,
  monthFolder, objectKey, withEncodeSlot,
} from "./encode";
import { makeLimiter } from "./ratelimit";
import type { VaultData, VaultImage, VaultAlbum } from "./types";

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

// ── Upload rate limit ─────────────────────────────────────────────────────────
// Dropping 60 files at once is the normal way to use this thing, so the limit
// is generous — but still bounded, so leaked credentials cannot fill a bucket.
const isRateLimited = makeLimiter(120, 60_000);

// ── Upload ────────────────────────────────────────────────────────────────────

export async function uploadToVault(formData: FormData): Promise<ActionResult<{ image: VaultImage }>> {
  await requireOwner();
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

    const encoded = await withEncodeSlot(() => encodeImage(input, ext, file.type));

    const { key: storedKey, url } = await putObject(objectKey("img", encoded.ext), encoded.data, encoded.mime);

    const image: VaultImage = {
      id: randomUUID(),
      key: storedKey,
      url,
      name: cleanName(file.name || "image"),
      albumId,
      width: encoded.width,
      height: encoded.height,
      bytes: encoded.data.length,
      mime: encoded.mime,
      createdAt: Date.now(),
      ...(encoded.blur ? { blur: encoded.blur } : {}),
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
  await requireOwner();
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
  await requireOwner();
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
  await requireOwner();
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
  await requireOwner();
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
  await requireOwner();
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
  await requireOwner();

  const image = (await loadVault()).images.find((i) => i.id === id);
  if (!image) return { ok: false, error: "ไม่พบรูปนี้" };
  if (!Number.isFinite(width) || width < 16) return { ok: false, error: "ขนาดไม่ถูกต้อง" };

  const source = await getObject(image.key);
  if (!source) return { ok: false, error: "อ่านไฟล์ต้นฉบับไม่ได้" };

  try {
    const { data, info } = await withEncodeSlot(() => encodeAtWidth(source, width));
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
  await requireOwner();

  const vault = await loadVault();
  const image = vault.images.find((i) => i.id === id);
  if (!image) return { ok: false, error: "ไม่พบรูปนี้" };
  if (!Number.isFinite(width) || width < 16) return { ok: false, error: "ขนาดไม่ถูกต้อง" };

  const source = await getObject(image.key);
  if (!source) return { ok: false, error: "อ่านไฟล์ต้นฉบับไม่ได้" };

  const keepUrl = canPurge();
  let purgeFailed = false;

  let stored: { key: string; url: string };
  let encoded: { data: Buffer; info: { width: number; height: number } };
  try {
    encoded = await withEncodeSlot(() => encodeAtWidth(source, width));
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
      // The catalog is deliberately still updated below: the object really did
      // change, and leaving the entry describing the old file would make the
      // grid disagree with what the URL serves once the cache does expire.
      console.error("applyResize: purge failed, cache will serve stale bytes until it expires");
    }
    purgeFailed = !purge.ok;
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

  if (purgeFailed) {
    return {
      ok: false,
      error: "ย่อไฟล์สำเร็จ แต่ล้างแคช Cloudflare ไม่ได้ — ตรวจ CF_ZONE_ID (ต้องเป็น 32 ตัวอักษร) แล้วลองใหม่ · รูปจะยังขึ้นเป็นของเดิมจนกว่าแคชจะหมดอายุ",
    };
  }

  return { ok: true, image: next };
}

// ── Albums ────────────────────────────────────────────────────────────────────

export async function createVaultAlbum(name: string, emoji: string): Promise<ActionResult<{ album: VaultAlbum }>> {
  await requireOwner();
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
  await requireOwner();
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
  await requireOwner();
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
