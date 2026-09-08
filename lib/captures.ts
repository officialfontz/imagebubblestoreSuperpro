// ── Delivery-proof store ──────────────────────────────────────────────────────
// One JSON object per month, kept apart from vault.json.
//
// vault.json is cloned, re-serialised and re-uploaded on every mutation, and is
// shipped to the browser in full on every page load. Delivery proof arrives at
// tens of records a day, forever — folding it into that file would make it grow
// without bound and turn "rename one library image" into a multi-megabyte
// round-trip. A file per month stays small no matter how many years accumulate,
// and expiring a month becomes a delete instead of a rewrite.
//
// Durability comes from a sidecar: every capture also writes its metadata next
// to the image bytes in R2, so a lost or corrupted month file can be rebuilt
// (scripts/rebuild-captures.mjs) without guessing who sent what to whom.

import fs from "fs/promises";
import path from "path";
import { emptyCaptureMonth, type CaptureMonth, type VaultImage } from "./types";
import { getDriver, getCatalog, putCatalog, putObject, listCaptureMonths as listR2CaptureMonths } from "./storage";
import { DATA_DIR, isRecord, normalizeImage, str } from "./store";

const CAPTURE_DIR = path.join(DATA_DIR, "captures");
const MONTH_RE = /^\d{4}-\d{2}$/;

/** "YYYY-MM" in UTC, matching the object-key folder the bytes live in. */
export function monthOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The month proof is being filed into right now. */
export function currentMonth(): string {
  return monthOf(Date.now());
}

/**
 * Which month file a capture belongs in.
 *
 * The device clock decides, because a capture queued offline on the 31st and
 * delivered on the 1st belongs to the day it happened. A clock that is wildly
 * wrong — a fresh Windows install before time sync, say — would otherwise file
 * proof into 2003 where nobody would ever find it, so anything outside a sane
 * window falls back to server time.
 */
export function captureMonthFor(capturedAt: number, now: number = Date.now()): string {
  const sane =
    Number.isFinite(capturedAt) &&
    capturedAt > now - 60 * 24 * 60 * 60 * 1000 &&
    capturedAt < now + 24 * 60 * 60 * 1000;
  return monthOf(sane ? capturedAt : now);
}

function normalize(raw: unknown, month: string): CaptureMonth {
  if (!isRecord(raw)) return emptyCaptureMonth(month);
  const captures = Array.isArray(raw.captures)
    ? raw.captures
        .map(normalizeImage)
        .filter((c): c is VaultImage => c !== null)
        // uploader and clientId are what attribution and de-duplication rest
        // on; a record missing either is unusable rather than merely incomplete.
        .filter((c) => Boolean(c.uploader && c.clientId))
        .map((c) => ({ ...c, kind: "capture" as const }))
    : [];
  return { version: 1, month: str(raw.month, month), captures };
}

// ── Cache + write queue ───────────────────────────────────────────────────────
// Same shape as lib/store.ts: a 30-second read cache per month, and one promise
// chain serialising every read-modify-write so two devices uploading at the
// same instant cannot drop each other's record.

const CACHE_TTL = 30_000;
const _cache = new Map<string, { data: CaptureMonth; expiresAt: number }>();
let _writeQueue: Promise<void> = Promise.resolve();

export function bustCaptureCache(month?: string): void {
  if (month) _cache.delete(month);
  else _cache.clear();
}

function localPath(month: string): string {
  return path.join(CAPTURE_DIR, `${month}.json`);
}

async function readRaw(month: string): Promise<string | null> {
  if (getDriver() === "r2") return getCatalog(month);
  try {
    return await fs.readFile(localPath(month), "utf8");
  } catch {
    return null; // a month with no captures yet is the normal path
  }
}

export async function loadCaptureMonth(month: string): Promise<CaptureMonth> {
  if (!MONTH_RE.test(month)) return emptyCaptureMonth(month);

  const hit = _cache.get(month);
  if (hit && Date.now() < hit.expiresAt) return hit.data;

  let data: CaptureMonth;
  try {
    const raw = await readRaw(month);
    data = raw ? normalize(JSON.parse(raw), month) : emptyCaptureMonth(month);
  } catch (e) {
    // Same reasoning as loadVault: an empty result would be indistinguishable
    // from "this month has no proof", and the next write would make that true.
    console.error(`loadCaptureMonth(${month}) failed:`, e);
    throw new Error("อ่านหลักฐานส่งของไม่สำเร็จ");
  }

  _cache.set(month, { data, expiresAt: Date.now() + CACHE_TTL });
  return data;
}

/** Loads several months at once, skipping any that fail so one bad file cannot
 *  blank the whole view. */
export async function loadCaptureMonths(months: string[]): Promise<VaultImage[]> {
  const loaded = await Promise.all(
    months.map((m) => loadCaptureMonth(m).catch(() => emptyCaptureMonth(m))),
  );
  return loaded.flatMap((m) => m.captures);
}

async function write(data: CaptureMonth): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  if (getDriver() === "r2") {
    await putCatalog(json, data.month);
  } else {
    await fs.mkdir(CAPTURE_DIR, { recursive: true });
    const tmp = `${localPath(data.month)}.${process.pid}.tmp`;
    await fs.writeFile(tmp, json, "utf8");
    await fs.rename(tmp, localPath(data.month));
  }
  _cache.set(data.month, { data, expiresAt: Date.now() + CACHE_TTL });
}

export function updateCaptureMonth<T>(
  month: string,
  mutate: (data: CaptureMonth) => { next: CaptureMonth; result: T },
): Promise<T | { error: string }> {
  return new Promise((resolve) => {
    _writeQueue = _writeQueue
      .then(async () => {
        _cache.delete(month);
        const current = await loadCaptureMonth(month);
        const { next, result } = mutate(structuredClone(current));
        await write(next);
        resolve(result);
      })
      .catch((e) => {
        console.error("updateCaptureMonth error:", e);
        resolve({ error: "บันทึกข้อมูลไม่สำเร็จ" });
      });
  });
}

/** Every month that holds proof, newest first. */
export async function listCaptureMonths(): Promise<string[]> {
  if (getDriver() === "r2") return listR2CaptureMonths();
  try {
    const files = await fs.readdir(CAPTURE_DIR);
    return files
      .map((f) => /^(\d{4}-\d{2})\.json$/.exec(f)?.[1])
      .filter((m): m is string => Boolean(m))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** The months a 90-day lookback can reach: this one plus the previous three. */
export function recentMonths(now: number = Date.now(), count = 4): string[] {
  const out: string[] = [];
  const d = new Date(now);
  for (let i = 0; i < count; i++) {
    out.push(monthOf(d.getTime()));
    d.setUTCMonth(d.getUTCMonth() - 1, 1);
  }
  return out;
}

// ── Sidecar ───────────────────────────────────────────────────────────────────

/**
 * Writes a capture's metadata beside its bytes, at the same key with a .json
 * extension.
 *
 * Without it, a lost month file leaves a folder of anonymous screenshots: the
 * images survive but nobody knows which customer or staff member they belong
 * to, which is exactly the information the proof exists to carry. ~300 bytes
 * per capture buys a guaranteed rebuild.
 */
export async function putCaptureSidecar(capture: VaultImage): Promise<void> {
  const key = capture.key.replace(/\.[A-Za-z0-9]+$/, "") + ".json";
  const body = new TextEncoder().encode(JSON.stringify(capture));
  await putObject(key, body, "application/json; charset=utf-8");
}

// ── Day helpers ───────────────────────────────────────────────────────────────
// Counts are reported in the shop's own day, not UTC: a capture at 3am Bangkok
// belongs to that night's shift, and UTC would file it under yesterday.

const BANGKOK_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Bangkok",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function shopDay(ts: number): string {
  return BANGKOK_DAY.format(new Date(ts));
}

/** Captures sent by one person today, and how many days running they have sent
 *  at least one. */
export function staffTally(
  captures: VaultImage[],
  staffId: string,
  now: number = Date.now(),
): { today: number; streakDays: number } {
  const days = new Set<string>();
  let today = 0;
  const todayKey = shopDay(now);

  for (const c of captures) {
    if (c.uploader !== staffId) continue;
    const day = shopDay(c.capturedAt ?? c.createdAt);
    days.add(day);
    if (day === todayKey) today++;
  }

  let streakDays = 0;
  const cursor = new Date(now);
  // A streak that has not been extended *today* is still alive until tomorrow,
  // so start counting from yesterday when today is empty.
  if (!days.has(todayKey)) cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (days.has(shopDay(cursor.getTime()))) {
    streakDays++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  return { today, streakDays };
}
