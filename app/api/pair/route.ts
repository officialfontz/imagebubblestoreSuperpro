// ── POST /api/pair ────────────────────────────────────────────────────────────
// Exchanges a six-character pairing code for a device token. This is the only
// unauthenticated write in the app, so it is rate-limited hard and the code is
// spent on first use.

import type { NextRequest } from "next/server";
import { getTrustedClientIp } from "@/lib/security";
import { makeLimiter } from "@/lib/ratelimit";
import { consumePairingCode } from "@/lib/pairing";
import { generateStaffToken, hashToken, readDeviceHeader } from "@/lib/staff-auth";
import { updateVault } from "@/lib/store";
import { MAX_INPUT_BYTES } from "@/lib/encode";
import { fail, ok, RATE_LIMITED } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 32^6 ≈ 1.07e9 codes with a ten-minute life; ten tries a minute makes guessing
// one hopeless without needing a lockout that a typo could trigger.
const limited = makeLimiter(10, 60_000);

const CAPTURE_MAX_BYTES = 8 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const ip = getTrustedClientIp(req.headers) ?? "unknown";
  if (limited(ip)) return RATE_LIMITED();

  let body: { code?: unknown; device?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail(400, "bad-request", "ข้อมูลไม่ถูกต้อง");
  }

  const staffId = consumePairingCode(String(body.code ?? ""));
  if (!staffId) return fail(400, "bad-code", "รหัสจับคู่ไม่ถูกต้องหรือหมดอายุแล้ว");

  const device = readDeviceHeader(req);
  const fromBody = typeof body.device === "object" && body.device !== null
    ? (body.device as Record<string, unknown>)
    : {};
  const name = typeof fromBody.name === "string" ? fromBody.name.slice(0, 60) : device.name;
  const platform = fromBody.platform === "windows" || fromBody.platform === "macos"
    ? fromBody.platform
    : device.platform;
  const appVersion = typeof fromBody.appVersion === "string"
    ? fromBody.appVersion.slice(0, 20)
    : device.appVersion;

  const token = generateStaffToken();
  const digest = hashToken(token);

  const res = await updateVault<{ staff: { id: string; name: string; emoji: string } | null }>((data) => {
    const staff = data.staff.find((s) => s.id === staffId);
    if (staff) {
      // Pairing again replaces the previous device's token rather than adding a
      // second: one person, one machine, and a lost laptop stops working the
      // moment its replacement is paired.
      staff.tokenHash = digest;
      staff.lastSeenAt = Date.now();
      delete staff.revokedAt;
      if (name) staff.deviceName = name;
      if (platform) staff.platform = platform;
      if (appVersion) staff.appVersion = appVersion;
    }
    return {
      next: data,
      result: { staff: staff ? { id: staff.id, name: staff.name, emoji: staff.emoji } : null },
    };
  });

  if ("error" in res) return fail(507, "storage", res.error);
  if (!res.staff) return fail(400, "bad-code", "ไม่พบทีมงานคนนี้แล้ว — ขอรหัสใหม่จากเจ้าของร้าน");

  return ok({
    token,
    staff: res.staff,
    server: {
      maxBytes: CAPTURE_MAX_BYTES,
      maxInputBytes: MAX_INPUT_BYTES,
      acceptedMimes: ["image/webp", "image/png", "image/jpeg"],
    },
  });
}
