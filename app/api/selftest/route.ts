// ── POST /api/selftest ────────────────────────────────────────────────────────
// The result of the app's five-step check, so the owner can confirm a Windows
// install works without a screen share or a phone call.

import type { NextRequest } from "next/server";
import { authenticateStaff, isAuthFailure } from "@/lib/staff-auth";
import { makeLimiter } from "@/lib/ratelimit";
import { updateVault } from "@/lib/store";
import { fail, ok, RATE_LIMITED } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limited = makeLimiter(6, 60_000);

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

  const at = Date.now();
  const passed = Number(body.passed) || 0;
  const total = Number(body.total) || 0;
  const report = String(body.report ?? "").slice(0, 2000);
  const platform = body.platform === "windows" || body.platform === "macos" ? body.platform : undefined;
  const appVersion = typeof body.appVersion === "string" ? body.appVersion.slice(0, 20) : undefined;

  const res = await updateVault((data) => {
    const staff = data.staff.find((s) => s.id === auth.staff.id);
    if (staff) {
      staff.lastSelfTest = { at, passed, total, report };
      staff.lastSeenAt = at;
      if (platform) staff.platform = platform;
      if (appVersion) staff.appVersion = appVersion;
    }
    return { next: data, result: { ok: true } };
  });
  if ("error" in res) return fail(507, "storage", res.error);

  return ok({ at });
}
