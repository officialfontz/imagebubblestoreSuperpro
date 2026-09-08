"use server";

// ── Delivery-proof actions (web app) ──────────────────────────────────────────
// Reading is open to any signed-in session, including the read-only staff role:
// the whole point of that role is that anyone on the team can look a customer
// up. Everything that changes or destroys is requireOwner.

import { randomUUID } from "crypto";
import { requireAuth, requireOwner } from "./auth";
import { loadVault, updateVault } from "./store";
import { deleteObject } from "./storage";
import { canPurge, purgeUrls } from "./purge";
import { issuePairingCode } from "./pairing";
import {
  listCaptureMonths as listMonths, loadCaptureMonth, loadCaptureMonths, monthOf,
  recentMonths, shopDay, updateCaptureMonth,
} from "./captures";
import type { ActionResult } from "./actions";
import type { VaultImage, VaultStaff } from "./types";

// ── Team ──────────────────────────────────────────────────────────────────────

export async function createStaff(name: string, emoji: string): Promise<ActionResult<{ staff: VaultStaff }>> {
  await requireOwner();
  const clean = String(name ?? "").trim().slice(0, 40);
  if (!clean) return { ok: false, error: "ใส่ชื่อทีมงานก่อน" };

  const staff: VaultStaff = {
    id: randomUUID(),
    name: clean,
    emoji: String(emoji || "🧑‍💻").slice(0, 8),
    createdAt: Date.now(),
  };

  const res = await updateVault<{ staff: VaultStaff }>((data) => {
    data.staff.push(staff);
    return { next: data, result: { staff } };
  });
  if ("error" in res) return { ok: false, error: res.error };
  return { ok: true, staff: res.staff };
}

export async function updateStaff(id: string, name: string, emoji: string): Promise<ActionResult> {
  await requireOwner();
  const clean = String(name ?? "").trim().slice(0, 40);
  if (!clean) return { ok: false, error: "ใส่ชื่อทีมงานก่อน" };

  const res = await updateVault<{ found: boolean }>((data) => {
    const staff = data.staff.find((s) => s.id === id);
    if (staff) {
      staff.name = clean;
      staff.emoji = String(emoji || "🧑‍💻").slice(0, 8);
    }
    return { next: data, result: { found: Boolean(staff) } };
  });
  if ("error" in res) return { ok: false, error: res.error };
  if (!res.found) return { ok: false, error: "ไม่พบทีมงานคนนี้" };
  return { ok: true };
}

/**
 * Cuts a device off immediately. The proof that person already sent stays
 * exactly where it is — this is about the device, not about the history.
 */
export async function revokeStaff(id: string): Promise<ActionResult> {
  await requireOwner();

  const res = await updateVault<{ found: boolean }>((data) => {
    const staff = data.staff.find((s) => s.id === id);
    if (staff) {
      staff.revokedAt = Date.now();
      delete staff.tokenHash;
      // A code issued a minute ago must not survive the revoke that followed it.
      delete staff.pairing;
    }
    return { next: data, result: { found: Boolean(staff) } };
  });
  if ("error" in res) return { ok: false, error: res.error };
  if (!res.found) return { ok: false, error: "ไม่พบทีมงานคนนี้" };
  return { ok: true };
}

/**
 * Removes someone from the roster entirely — refused while any of their proof
 * survives, because a capture whose uploader cannot be resolved is proof of
 * nothing. Revoking is the answer for someone who has left.
 */
export async function deleteStaff(id: string): Promise<ActionResult> {
  await requireOwner();

  const captures = await loadCaptureMonths(await listMonths());
  if (captures.some((c) => c.uploader === id)) {
    return { ok: false, error: "ยังมีหลักฐานที่ส่งโดยคนนี้ — ใช้ยกเลิกสิทธิ์แทน" };
  }

  const res = await updateVault<{ ok: boolean }>((data) => {
    data.staff = data.staff.filter((s) => s.id !== id);
    return { next: data, result: { ok: true } };
  });
  if ("error" in res) return { ok: false, error: res.error };
  return { ok: true };
}

export async function createPairingCode(
  staffId: string,
): Promise<ActionResult<{ code: string; expiresAt: number }>> {
  await requireOwner();
  const staff = (await loadVault()).staff.find((s) => s.id === staffId);
  if (!staff) return { ok: false, error: "ไม่พบทีมงานคนนี้" };
  const issued = await issuePairingCode(staffId);
  if ("error" in issued) return { ok: false, error: issued.error };
  return { ok: true, ...issued };
}

// ── Captures ──────────────────────────────────────────────────────────────────

export async function loadCaptures(month: string): Promise<{ captures: VaultImage[] }> {
  await requireAuth();
  const data = await loadCaptureMonth(month);
  return { captures: data.captures };
}

/**
 * Everything inside the retention window, for search.
 *
 * A customer who comes back to complain does it days or weeks later, so a
 * search that only looked at the current month would miss most of what people
 * actually go looking for.
 */
export async function searchCaptures(): Promise<{ captures: VaultImage[] }> {
  await requireAuth();
  const months = await listMonths();
  const recent = new Set(recentMonths());
  return { captures: await loadCaptureMonths(months.filter((m) => recent.has(m))) };
}

export async function listCaptureMonths(): Promise<{ months: string[] }> {
  await requireAuth();
  return { months: await listMonths() };
}

/** Fixes a mistyped in-game name. Without this a typo is permanent, since a
 *  capture cannot be re-sent once the moment has passed. */
export async function renameCapture(id: string, month: string, customer: string): Promise<ActionResult> {
  await requireOwner();
  const clean = String(customer ?? "").trim().slice(0, 60);
  if (!clean) return { ok: false, error: "ใส่ชื่อลูกค้าก่อน" };

  const res = await updateCaptureMonth(month, (data) => {
    const capture = data.captures.find((c) => c.id === id);
    if (capture) {
      capture.customer = clean;
      capture.name = clean;
    }
    return { next: data, result: { found: Boolean(capture) } };
  });
  if ("error" in res) return { ok: false, error: res.error };
  if (!res.found) return { ok: false, error: "ไม่พบหลักฐานนี้" };
  return { ok: true };
}

/**
 * Destroys one capture outright. There is no trash for proof: unlike a library
 * image whose URL may be embedded on a live page, a capture is referenced by
 * nothing, so a second state to reason about would buy nothing.
 */
export async function deleteCapture(id: string, month: string): Promise<ActionResult> {
  await requireOwner();

  const capture = (await loadCaptureMonth(month)).captures.find((c) => c.id === id);
  if (!capture) return { ok: false, error: "ไม่พบหลักฐานนี้" };

  await deleteObject(capture.key).catch((e) => console.error("deleteCapture object:", e));
  await deleteObject(capture.key.replace(/\.[A-Za-z0-9]+$/, "") + ".json").catch(() => undefined);
  if (canPurge()) await purgeUrls([capture.url]).catch(() => undefined);

  const res = await updateCaptureMonth(month, (data) => {
    data.captures = data.captures.filter((c) => c.id !== id);
    return { next: data, result: { ok: true } };
  });
  if ("error" in res) return { ok: false, error: res.error };
  return { ok: true };
}

/** Per-person counts for the sidebar, in the shop's own day. */
export async function captureCountsToday(): Promise<{ total: number; byStaff: Record<string, number> }> {
  await requireAuth();
  const now = Date.now();
  const today = shopDay(now);
  const captures = (await loadCaptureMonth(monthOf(now))).captures;

  const byStaff: Record<string, number> = {};
  let total = 0;
  for (const c of captures) {
    if (shopDay(c.capturedAt ?? c.createdAt) !== today) continue;
    total++;
    if (c.uploader) byStaff[c.uploader] = (byStaff[c.uploader] ?? 0) + 1;
  }
  return { total, byStaff };
}
