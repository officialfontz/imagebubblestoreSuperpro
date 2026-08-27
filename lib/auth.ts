// ── Auth ──────────────────────────────────────────────────────────────────────
// Checked twice: once at the edge in proxy.ts, so nothing renders for a
// stranger, and once inside every server action, so a replayed Next-Action POST
// cannot skip the edge.

import { headers, cookies } from "next/headers";
import { SESSION_COOKIE, getHmacKey, verifySessionToken } from "./session";

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

/** Call at the top of every server action and of the page component. */
export async function requireAuth(): Promise<void> {
  const password = process.env.VAULT_PASSWORD;
  const hmacKey = getHmacKey();
  if (!password || !hmacKey) throw new Error("Unauthorized");

  assertSameOrigin(await headers());

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!await verifySessionToken(token, password, hmacKey)) {
    throw new Error("Unauthorized");
  }
}

/** Non-throwing variant, for pages that branch on auth instead of failing. */
export async function isSignedIn(): Promise<boolean> {
  const password = process.env.VAULT_PASSWORD;
  const hmacKey = getHmacKey();
  if (!password || !hmacKey) return false;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return verifySessionToken(token, password, hmacKey);
}
