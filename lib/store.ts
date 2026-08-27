// ── Vault metadata store ──────────────────────────────────────────────────────
// The image bytes live in R2; the *catalog* (names, albums, dimensions) lives in
// a single vault.json inside DATA_DIR. One file keeps the whole thing
// dependency-free — a few hundred images is ~150 kB of JSON, well inside what a
// single read and parse can absorb, and it is trivial to back up or hand-edit.
//
// On Railway, DATA_DIR must point at a mounted Volume. Without one the catalog
// is wiped on every redeploy while the objects in R2 survive — orphaned bytes
// with no way to find them.

import fs from "fs/promises";
import path from "path";
import { emptyVault, type VaultData, type VaultAlbum, type VaultImage } from "./types";

export const DATA_DIR   = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
export const VAULT_PATH = path.join(DATA_DIR, "vault.json");

// ── Write mutex ───────────────────────────────────────────────────────────────
// Every mutation is a read-modify-write on one JSON file. Uploading 40 files at
// once would otherwise interleave those cycles and silently drop entries, so
// they all queue through a single promise chain.
let _writeQueue: Promise<void> = Promise.resolve();

function queueWork<T>(work: () => Promise<T>, onError: (e: unknown) => unknown): Promise<T> {
  return new Promise<T>((resolve) => {
    _writeQueue = _writeQueue
      .then(async () => { resolve(await work()); })
      .catch((e) => { resolve(onError(e) as T); });
  });
}

const CACHE_TTL = 30_000;
let _cache: { data: VaultData; expiresAt: number } | null = null;

// ── Normalisation ─────────────────────────────────────────────────────────────
// vault.json is hand-editable and survives across deploys, so every field is
// re-validated on load rather than trusted.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function normalizeAlbum(raw: unknown): VaultAlbum | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;
  return {
    id,
    name: str(raw.name, "ไม่มีชื่อ").slice(0, 60),
    emoji: str(raw.emoji, "📁").slice(0, 8),
    createdAt: num(raw.createdAt, 0),
  };
}

function normalizeImage(raw: unknown): VaultImage | null {
  if (!isRecord(raw)) return null;
  const id  = str(raw.id);
  const key = str(raw.key);
  const url = str(raw.url);
  if (!id || !key || !url) return null;
  return {
    id, key, url,
    name: str(raw.name, "image").slice(0, 120),
    albumId: typeof raw.albumId === "string" && raw.albumId ? raw.albumId : null,
    width: num(raw.width),
    height: num(raw.height),
    bytes: num(raw.bytes),
    mime: str(raw.mime, "image/webp"),
    createdAt: num(raw.createdAt, 0),
    ...(typeof raw.blur === "string" && raw.blur ? { blur: raw.blur } : {}),
  };
}

function normalize(raw: unknown): VaultData {
  if (!isRecord(raw)) return emptyVault();
  const albums = Array.isArray(raw.albums)
    ? raw.albums.map(normalizeAlbum).filter((a): a is VaultAlbum => a !== null)
    : [];
  const albumIds = new Set(albums.map((a) => a.id));
  const images = Array.isArray(raw.images)
    ? raw.images
        .map(normalizeImage)
        .filter((i): i is VaultImage => i !== null)
        // An image pointing at a deleted album falls back to "unfiled" rather
        // than vanishing from every view.
        .map((i) => (i.albumId && !albumIds.has(i.albumId) ? { ...i, albumId: null } : i))
    : [];
  return { version: 1, albums, images };
}

// ── Read / write ──────────────────────────────────────────────────────────────

export async function loadVault(): Promise<VaultData> {
  if (_cache && Date.now() < _cache.expiresAt) return _cache.data;
  try {
    const raw = JSON.parse(await fs.readFile(VAULT_PATH, "utf8"));
    const data = normalize(raw);
    _cache = { data, expiresAt: Date.now() + CACHE_TTL };
    return data;
  } catch {
    // Missing file on first run is the normal path, not an error.
    const data = emptyVault();
    _cache = { data, expiresAt: Date.now() + CACHE_TTL };
    return data;
  }
}

async function writeVault(data: VaultData): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  // Write-then-rename: a crash mid-write leaves the previous vault.json intact
  // instead of a truncated file that would orphan every image in the bucket.
  const tmp = `${VAULT_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, VAULT_PATH);
  _cache = { data, expiresAt: Date.now() + CACHE_TTL };
}

/**
 * Read-modify-write under the shared admin mutex. `mutate` receives a fresh
 * copy of the vault and returns the version to persist; the value it puts in
 * `result` is handed back to the caller.
 */
export function updateVault<T>(
  mutate: (data: VaultData) => { next: VaultData; result: T },
): Promise<T | { error: string }> {
  return queueWork<T | { error: string }>(
    async () => {
      // Bypass the TTL cache — the mutation must see the latest committed state.
      _cache = null;
      const current = await loadVault();
      const { next, result } = mutate(structuredClone(current));
      await writeVault(next);
      return result;
    },
    (e) => {
      console.error("updateVault error:", e);
      return { error: "บันทึกข้อมูลไม่สำเร็จ" };
    },
  );
}

export function bustVaultCache(): void {
  _cache = null;
}
