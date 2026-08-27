// ── proxy.ts — edge gate ──────────────────────────────────────────────────────
// Next.js 16 renames middleware.ts → proxy.ts. Runs before anything renders.
//
//   /uploads/*   PUBLIC. These are the direct image links; the entire point is
//                that other sites can embed them. Bot-filtered and rate-limited,
//                never session-gated.
//   /login       PUBLIC, so there is somewhere to sign in.
//   /healthz     PUBLIC, for Railway's health check.
//   everything   Requires a valid session cookie; otherwise redirected to
//   else         /login with the original path remembered.

import { NextRequest, NextResponse } from "next/server";
import { getTrustedClientIp } from "@/lib/security";
import { SESSION_COOKIE, getHmacKey, verifySessionToken } from "@/lib/session";

// Scraper and mirroring tools have no business walking an image host.
const SCRAPER_UA_RE =
  /AhrefsBot|SemrushBot|MJ12bot|DotBot|BLEXBot|DataForSeoBot|serpstatbot|HTTrack|scrapy|masscan|nikto|zgrab|sqlmap|python-requests|go-http-client|libwww-perl/i;

type RateEntry = { count: number; resetAt: number };
const pageHits = new Map<string, RateEntry>();
const imageHits = new Map<string, RateEntry>();

const WINDOW_MS = 60_000;
const PAGE_LIMIT = 240;
// A single page embedding 300 vault images is ONE visitor. Sizing this like a
// normal page limit would 429 the images and show broken thumbnails everywhere.
const IMAGE_LIMIT = 1200;
const MAX_ENTRIES = 8_000;

function rateLimited(map: Map<string, RateEntry>, ip: string, limit: number): boolean {
  const now = Date.now();
  if (map.size >= MAX_ENTRIES) {
    for (const [k, v] of map) if (now > v.resetAt) map.delete(k);
  }
  const entry = map.get(ip);
  if (!entry || now > entry.resetAt) {
    map.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  if (entry.count >= limit) return true;
  entry.count++;
  return false;
}

function text(body: string, status: number, extra: Record<string, string> = {}): NextResponse {
  return new NextResponse(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const ip = getTrustedClientIp(req.headers) ?? "unknown";

  if (pathname === "/healthz") return text("ok", 200);

  // ── Public image path ──────────────────────────────────────────────────────
  if (pathname.startsWith("/uploads/")) {
    if (SCRAPER_UA_RE.test(req.headers.get("user-agent") ?? "")) return text("Forbidden", 403);
    if (rateLimited(imageHits, ip, IMAGE_LIMIT)) return text("Too Many Requests", 429, { "Retry-After": "60" });
    return NextResponse.next();
  }

  if (rateLimited(pageHits, ip, PAGE_LIMIT)) return text("Too Many Requests", 429, { "Retry-After": "60" });

  const password = process.env.VAULT_PASSWORD;
  const hmacKey = getHmacKey();
  if (!password || !hmacKey) {
    return text("Vault is not configured — set VAULT_PASSWORD and HMAC_KEY", 503);
  }

  const signedIn = await verifySessionToken(
    req.cookies.get(SESSION_COOKIE)?.value,
    password,
    hmacKey,
  );

  // /login stays reachable while signed out; the page itself bounces a signed-in
  // visitor back to the app.
  if (pathname === "/login") return NextResponse.next();

  if (!signedIn) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
