"use server";

// ── Sign in / out ─────────────────────────────────────────────────────────────

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  SESSION_COOKIE, createSessionToken, passwordMatches, getHmacKey, sessionCookieOptions,
  vaultPasswords, type VaultRole,
} from "./session";
import { getTrustedClientIp } from "./security";

// ── Brute-force gate ──────────────────────────────────────────────────────────
// In-memory is the right trade here: a restart clearing the counter is harmless
// (an attacker cannot cause restarts), and it avoids a disk write per attempt.
const attempts = new Map<string, { count: number; until: number }>();
const MAX_ATTEMPTS = 6;
const LOCKOUT_MS = 15 * 60_000;

function lockedOut(ip: string): number {
  const entry = attempts.get(ip);
  if (!entry || Date.now() > entry.until) return 0;
  if (entry.count < MAX_ATTEMPTS) return 0;
  return Math.ceil((entry.until - Date.now()) / 60_000);
}

function recordFailure(ip: string): void {
  const now = Date.now();
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) if (now > v.until) attempts.delete(k);
  }
  const entry = attempts.get(ip);
  if (!entry || now > entry.until) attempts.set(ip, { count: 1, until: now + LOCKOUT_MS });
  else entry.count++;
}

export type SignInState = { error?: string };

export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const { owner, staff } = vaultPasswords();
  const hmacKey = getHmacKey();
  if (!owner || !hmacKey) {
    return { error: "เซิร์ฟเวอร์ยังตั้งค่าไม่ครบ (VAULT_PASSWORD / HMAC_KEY)" };
  }

  const ip = getTrustedClientIp(await headers()) ?? "unknown";
  const waitMinutes = lockedOut(ip);
  if (waitMinutes > 0) {
    return { error: `ใส่รหัสผิดหลายครั้ง กรุณารออีก ${waitMinutes} นาที` };
  }

  // One form, two passwords: which one was typed decides the role. Both are
  // always compared so a wrong guess takes the same time either way.
  const supplied = String(formData.get("password") ?? "");
  const [isOwner, isStaff] = await Promise.all([
    passwordMatches(supplied, owner, hmacKey),
    staff ? passwordMatches(supplied, staff, hmacKey) : Promise.resolve(false),
  ]);

  const role: VaultRole | null = isOwner ? "owner" : isStaff ? "staff" : null;
  if (!role) {
    recordFailure(ip);
    return { error: "รหัสผ่านไม่ถูกต้อง" };
  }

  attempts.delete(ip);
  const password = role === "owner" ? owner : staff!;
  const store = await cookies();
  store.set(SESSION_COOKIE, await createSessionToken(password, hmacKey, role), sessionCookieOptions());

  // redirect() throws a control-flow signal, so nothing after it runs.
  redirect("/");
}

export async function signOut(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
