// ── Desktop-app authentication ────────────────────────────────────────────────
// The Bubble Capture app authenticates with one bearer token per device, not
// with the shared vault password. That is what makes a staff departure a
// one-click revoke instead of a password rotation that logs out the whole shop.
//
// Only the sha256 of a token is stored, so the catalog is useless to anyone who
// obtains it: it proves which token is valid without containing one.

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { loadVault, updateVault } from "./store";
import type { VaultStaff } from "./types";

const TOKEN_PREFIX = "bcap_";

export function generateStaffToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function digestsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export type AuthFailure = { error: "unauthorized" | "token-revoked"; message: string };
export type AuthResult = { staff: VaultStaff } | AuthFailure;

export function isAuthFailure(r: AuthResult): r is AuthFailure {
  return "error" in r;
}

function bearerFrom(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Resolves the device's token to a staff member.
 *
 * A revoked account is reported separately from an unknown token so the app can
 * say something true — "ask for a new pairing code" rather than a generic
 * failure the user cannot act on.
 */
export async function authenticateStaff(req: Request): Promise<AuthResult> {
  const token = bearerFrom(req);
  if (!token) return { error: "unauthorized", message: "ยังไม่ได้จับคู่อุปกรณ์" };

  const digest = hashToken(token);
  const vault = await loadVault();

  for (const staff of vault.staff) {
    if (!staff.tokenHash || !digestsMatch(staff.tokenHash, digest)) continue;
    if (staff.revokedAt) {
      return {
        error: "token-revoked",
        message: "อุปกรณ์นี้ถูกยกเลิกสิทธิ์แล้ว — ขอรหัสจับคู่ใหม่จากเจ้าของร้าน",
      };
    }
    return { staff };
  }

  return { error: "unauthorized", message: "ยังไม่ได้จับคู่อุปกรณ์" };
}

export type DeviceInfo = { name?: string; platform?: "windows" | "macos"; appVersion?: string };

/** Reads the X-Bubble-Device header the app sends with every request. */
export function readDeviceHeader(req: Request): DeviceInfo {
  try {
    const raw = req.headers.get("x-bubble-device");
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const d = parsed as Record<string, unknown>;
    const platform = d.platform === "windows" || d.platform === "macos" ? d.platform : undefined;
    return {
      ...(typeof d.name === "string" && d.name ? { name: d.name.slice(0, 60) } : {}),
      ...(platform ? { platform } : {}),
      ...(typeof d.appVersion === "string" && d.appVersion ? { appVersion: d.appVersion.slice(0, 20) } : {}),
    };
  } catch {
    return {};
  }
}

// Writing the catalog on every upload just to move a timestamp would double the
// R2 traffic of a capture for no benefit. Ten minutes is fine for a "last seen"
// column that is read by a human.
const TOUCH_INTERVAL_MS = 10 * 60_000;

export async function touchLastSeen(staffId: string, device: DeviceInfo): Promise<void> {
  const now = Date.now();
  const current = (await loadVault()).staff.find((s) => s.id === staffId);
  if (!current) return;

  const stale = !current.lastSeenAt || now - current.lastSeenAt > TOUCH_INTERVAL_MS;
  const deviceChanged =
    (device.name && device.name !== current.deviceName) ||
    (device.platform && device.platform !== current.platform) ||
    (device.appVersion && device.appVersion !== current.appVersion);

  if (!stale && !deviceChanged) return;

  await updateVault((data) => {
    const staff = data.staff.find((s) => s.id === staffId);
    if (staff) {
      staff.lastSeenAt = now;
      if (device.name) staff.deviceName = device.name;
      if (device.platform) staff.platform = device.platform;
      if (device.appVersion) staff.appVersion = device.appVersion;
    }
    return { next: data, result: { ok: true } };
  });
}
