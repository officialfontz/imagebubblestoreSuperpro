// ── POST /api/report ──────────────────────────────────────────────────────────
// "ส่งรายงานปัญหา" in the desktop app: the tail of its local log, so a staff
// member can report a problem without describing it, and the owner can read
// what actually happened instead of interpreting a screenshot.

import type { NextRequest } from "next/server";
import { authenticateStaff, isAuthFailure } from "@/lib/staff-auth";
import { makeLimiter } from "@/lib/ratelimit";
import { updateVault } from "@/lib/store";
import { fail, ok, RATE_LIMITED } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limited = makeLimiter(4, 60_000);
const MAX_LOG_CHARS = 20_000;

export async function POST(req: NextRequest) {
  const auth = await authenticateStaff(req);
  if (isAuthFailure(auth)) return fail(401, auth.error, auth.message);
  if (limited(auth.staff.id)) return RATE_LIMITED();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail(400, "bad-request", "ข้อมูลไม่ถูกต้อง");
  }

  const text = String(body.log ?? "").slice(-MAX_LOG_CHARS);
  if (!text.trim()) return fail(400, "empty", "ไม่มีข้อมูลให้ส่ง");

  const at = Date.now();
  const res = await updateVault((data) => {
    const staff = data.staff.find((s) => s.id === auth.staff.id);
    if (staff) {
      staff.lastReport = { at, text };
      staff.lastSeenAt = at;
    }
    return { next: data, result: { ok: true } };
  });
  if ("error" in res) return fail(507, "storage", res.error);

  return ok({ at });
}
