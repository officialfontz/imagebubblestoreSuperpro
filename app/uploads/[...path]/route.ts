/**
 * Serves locally-stored images — the fallback used when R2 is not configured.
 *
 * With R2 set up, nothing hits this route: image URLs point straight at the
 * bucket's public domain and Cloudflare serves them. This exists so the app is
 * fully usable on a fresh clone with no cloud account, and so switching to R2
 * later never breaks the links handed out before the switch.
 *
 * proxy.ts leaves /uploads/* unauthenticated on purpose: these URLs are meant
 * to be embedded on other sites.
 */

import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { Readable } from "stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "public", "uploads");

const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp",
};

function headersFor(name: string, size: number, mtimeMs: number, type: string): Record<string, string> {
  return {
    "Content-Type": type,
    "Content-Length": String(size),
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: `"${name}-${size}-${Math.round(mtimeMs)}"`,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Access-Control-Allow-Origin": "*",
  };
}

async function resolve(segments: string[]) {
  if (!segments?.length) return null;

  // Flatten to a bare filename: the store writes a flat directory, and this
  // drops any "../" a caller tries to smuggle in through the path segments.
  const name = path.basename(segments[segments.length - 1]);
  if (!name || name.startsWith(".")) return null;

  const type = MIME[name.split(".").pop()?.toLowerCase() ?? ""];
  if (!type) return null;

  // turbopackIgnore on the fs calls below: UPLOAD_DIR is an env var, so the
  // bundler cannot prove which directory is read and would otherwise trace the
  // entire project into the server output. The path is validated by hand right
  // here instead — basename() plus the prefix check.
  const dir = path.resolve(/*turbopackIgnore: true*/ UPLOAD_DIR);
  const file = path.resolve(/*turbopackIgnore: true*/ UPLOAD_DIR, name);
  // Belt and braces: even after basename(), confirm we stayed inside the dir.
  if (!file.startsWith(dir + path.sep)) return null;

  try {
    const stat = await fs.stat(/*turbopackIgnore: true*/ file);
    if (!stat.isFile()) return null;
    return { name, file, stat, type };
  } catch {
    return null;
  }
}

export async function HEAD(_req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const found = await resolve((await ctx.params).path);
  if (!found) return new NextResponse(null, { status: 404 });
  return new NextResponse(null, {
    status: 200,
    headers: headersFor(found.name, found.stat.size, found.stat.mtimeMs, found.type),
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const found = await resolve((await ctx.params).path);
  if (!found) return new NextResponse("Not Found", { status: 404 });

  const headers = headersFor(found.name, found.stat.size, found.stat.mtimeMs, found.type);
  if (req.headers.get("if-none-match") === headers.ETag) {
    return new NextResponse(null, { status: 304, headers });
  }

  const stream = createReadStream(/*turbopackIgnore: true*/ found.file);
  // Without this, a client that disconnects mid-transfer leaves the controller
  // being pushed to after the response is gone (ERR_INVALID_STATE).
  req.signal.addEventListener("abort", () => stream.destroy(), { once: true });

  return new NextResponse(Readable.toWeb(stream) as unknown as BodyInit, { status: 200, headers });
}
