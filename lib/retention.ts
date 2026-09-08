// ── Delivery-proof retention ──────────────────────────────────────────────────
// Proof exists to settle a dispute, and disputes do not arrive months later. So
// captures expire on their own: 90 days by default, after which the bytes, the
// sidecar and the catalog row all go.
//
// There is no cron on Railway's free tier, so the sweep is lazy — it piggybacks
// on traffic the app already gets, at most once every six hours. That is dense
// enough for a daily-use tool and costs nothing on a quiet day.

import { CAPTURE_RETENTION_DAYS } from "./types";
import { deleteObject, deleteCatalog } from "./storage";
import { canPurge, purgeUrls } from "./purge";
import {
  listCaptureMonths, loadCaptureMonth, updateCaptureMonth, bustCaptureCache, monthOf,
} from "./captures";

const SWEEP_INTERVAL_MS = 6 * 60 * 60_000;
let _lastSweep = 0;
let _running = false;

/**
 * Fire-and-forget: callers must not await this. It runs behind a request, and
 * making an upload wait on a hundred deletes would turn the slowest path in the
 * app into the one a staff member notices.
 */
export function scheduleCaptureSweep(): void {
  const now = Date.now();
  if (_running || now - _lastSweep < SWEEP_INTERVAL_MS) return;
  _lastSweep = now;
  _running = true;
  void sweepExpiredCaptures()
    .catch((e) => console.error("capture sweep failed:", e))
    .finally(() => { _running = false; });
}

export async function sweepExpiredCaptures(now: number = Date.now()): Promise<{ removed: number }> {
  const cutoff = now - CAPTURE_RETENTION_DAYS * 24 * 60 * 60_000;
  const months = await listCaptureMonths();
  let removed = 0;

  for (const month of months) {
    const data = await loadCaptureMonth(month).catch(() => null);
    if (!data) continue;

    const expired = data.captures.filter((c) => (c.capturedAt ?? c.createdAt) < cutoff);
    if (expired.length === 0) continue;

    // Bytes first. A crash between the two leaves an orphaned object, which
    // costs a little storage; the reverse leaves a catalog row pointing at
    // nothing, which shows up as a broken tile.
    for (const capture of expired) {
      await deleteObject(capture.key).catch((e) => console.error("sweep deleteObject:", capture.key, e));
      const sidecar = capture.key.replace(/\.[A-Za-z0-9]+$/, "") + ".json";
      await deleteObject(sidecar).catch(() => undefined);
    }
    if (canPurge()) await purgeUrls(expired.map((c) => c.url)).catch(() => undefined);

    const expiredIds = new Set(expired.map((c) => c.id));
    const res = await updateCaptureMonth(month, (m) => {
      m.captures = m.captures.filter((c) => !expiredIds.has(c.id));
      return { next: m, result: { left: m.captures.length } };
    });

    removed += expired.length;

    // An emptied month that is itself past retention leaves nothing behind.
    // Never the current month: today's first capture would recreate it anyway.
    if (!("error" in res) && res.left === 0 && month !== monthOf(now)) {
      await deleteCatalog(month).catch(() => undefined);
      bustCaptureCache(month);
    }
  }

  if (removed > 0) console.log(`capture sweep: removed ${removed} expired captures`);
  return { removed };
}
