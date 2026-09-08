// ── GET /api/me ───────────────────────────────────────────────────────────────
// The desktop app's heartbeat: proves the token still works and returns the
// numbers the tray panel shows. Also reports server time so the app can warn
// about a device clock that would file proof under the wrong day.

import type { NextRequest } from "next/server";
import { authenticateStaff, isAuthFailure, readDeviceHeader, touchLastSeen } from "@/lib/staff-auth";
import { loadCaptureMonths, monthOf, recentMonths, staffTally } from "@/lib/captures";
import { fail, ok } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateStaff(req);
  if (isAuthFailure(auth)) return fail(401, auth.error, auth.message);

  const now = Date.now();
  // Two months, so a streak that started last month still reads correctly on
  // the first of this one.
  const captures = await loadCaptureMonths([monthOf(now), recentMonths(now, 2)[1]]);
  const tally = staffTally(captures, auth.staff.id, now);

  await touchLastSeen(auth.staff.id, readDeviceHeader(req)).catch(() => undefined);

  return ok({
    staff: { id: auth.staff.id, name: auth.staff.name, emoji: auth.staff.emoji },
    ...tally,
    serverTime: now,
  });
}
