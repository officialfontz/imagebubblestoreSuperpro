// ── proxy.ts — edge gate ──────────────────────────────────────────────────────
// Next.js 16 renames middleware.ts → proxy.ts. Runs before anything renders.
//
//   /uploads/*   PUBLIC. These are the direct image links; the entire point is
//                that other sites can embed them. Bot-filtered and rate-limited,
//                never session-gated.
//   /login       PUBLIC, so there is somewhere to sign in.
//   /healthz     PUBLIC, for Railway's health check.
//   /manifest.webmanifest, /icon-*.png, /apple-touch-icon.png
//                PUBLIC: fetched cookie-less by "add to home screen".
//   /api/pair    NO COOKIE. The desktop capture app authenticates with a bearer
//   /api/me      token per staff device, which the route handlers verify
//   /api/capture themselves — the cookie check here would only ever redirect a
//   /api/selftest native HTTP client to an HTML sign-in page. Still rate-limited.
//   /api/report
//   everything   Requires a valid session cookie; otherwise redirected to
//   else         /login with the original path remembered.

import { NextRequest, NextResponse } from "next/server";
import { getTrustedClientIp } from "@/lib/security";
import { SESSION_COOKIE, getHmacKey, readSessionRole, vaultPasswords } from "@/lib/session";

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

// Bearer-authenticated endpoints for the Bubble Capture desktop app. Listed
// exactly, not by prefix: /api/png/* must stay behind the session cookie.
const PWA_ASSETS = new Set(["/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/logo.png"]);

const BEARER_API = new Set(["/api/pair", "/api/me", "/api/capture", "/api/selftest", "/api/report"]);

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

  // The install manifest and its icons. A phone fetches these without the
  // session cookie when "add to home screen" is tapped; redirecting them to
  // the sign-in page made the install silently produce a blank icon.
  if (PWA_ASSETS.has(pathname)) return NextResponse.next();

  // ── Public image path ──────────────────────────────────────────────────────
  if (pathname.startsWith("/uploads/")) {
    if (SCRAPER_UA_RE.test(req.headers.get("user-agent") ?? "")) return text("Forbidden", 403);
    if (rateLimited(imageHits, ip, IMAGE_LIMIT)) return text("Too Many Requests", 429, { "Retry-After": "60" });
    return NextResponse.next();
  }

  if (rateLimited(pageHits, ip, PAGE_LIMIT)) return text("Too Many Requests", 429, { "Retry-After": "60" });

  if (BEARER_API.has(pathname)) return NextResponse.next();

  const { owner } = vaultPasswords();
  const hmacKey = getHmacKey();
  if (!owner || !hmacKey) {
    return text("Vault is not configured — set VAULT_PASSWORD and HMAC_KEY", 503);
  }

  const signedIn = await readSessionRole(req.cookies.get(SESSION_COOKIE)?.value, hmacKey) !== null;

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
