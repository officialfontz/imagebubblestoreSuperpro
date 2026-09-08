// ── Auth ──────────────────────────────────────────────────────────────────────
// Checked twice: once at the edge in proxy.ts, so nothing renders for a
// stranger, and once inside every server action, so a replayed Next-Action POST
// cannot skip the edge.
//
// Two roles share one cookie (see lib/session.ts). "owner" is the shop owner;
// "staff" is a read-only delivery-proof account handed to the whole team, so
// they can look a customer up without being able to delete the evidence.

import { headers, cookies } from "next/headers";
import { SESSION_COOKIE, getHmacKey, readSessionRole, type VaultRole } from "./session";

/**
 * Rejects cross-origin server action calls. A same-origin request either omits
 * Origin (a direct navigation) or sends one matching the forwarded host —
 * x-forwarded-host, not host, because behind Railway/Cloudflare the raw host
 * header is the proxy's internal name, not the public domain.
 */
function assertSameOrigin(h: Awaited<ReturnType<typeof headers>>): void {
  const origin = h.get("origin");
  if (!origin) return;
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  try {
    if (new URL(origin).host !== host) throw new Error("Unauthorized");
  } catch {
    throw new Error("Unauthorized");
  }
}

/**
 * Call at the top of every server action and of the page component. Returns the
 * caller's role so an action can decide what they may do — it never grants
 * anything by itself beyond "is signed in at all".
 */
export async function requireAuth(): Promise<VaultRole> {
  const hmacKey = getHmacKey();
  if (!hmacKey) throw new Error("Unauthorized");

  assertSameOrigin(await headers());

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const role = await readSessionRole(token, hmacKey);
  if (!role) throw new Error("Unauthorized");
  return role;
}

/**
 * For anything that changes or destroys data. Staff sessions are readers: they
 * exist so the team can find a customer's proof, not so a bad day can wipe it.
 */
export async function requireOwner(): Promise<void> {
  if (await requireAuth() !== "owner") throw new Error("Unauthorized");
}

/** Non-throwing variant, for pages that branch on auth instead of failing. */
export async function isSignedIn(): Promise<boolean> {
  const hmacKey = getHmacKey();
  if (!hmacKey) return false;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return await readSessionRole(token, hmacKey) !== null;
}
