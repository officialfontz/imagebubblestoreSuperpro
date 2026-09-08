// ── Shared helpers for the desktop-app endpoints ──────────────────────────────
// These routes answer a native HTTP client, not a browser, so every reply is
// JSON with a stable machine code plus a Thai sentence the app can show
// verbatim. The app never has to compose an error message of its own.

import { NextResponse } from "next/server";

export function ok<T extends object>(body: T): NextResponse {
  return NextResponse.json({ ok: true, ...body }, { headers: { "Cache-Control": "no-store" } });
}

export function fail(status: number, error: string, message: string): NextResponse {
  return NextResponse.json(
    { ok: false, error, message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export const RATE_LIMITED = () =>
  fail(429, "rate-limited", "ส่งถี่เกินไป — รอสักครู่แล้วลองใหม่");
