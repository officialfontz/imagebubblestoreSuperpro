/**
 * Serves one vault image as it is stored, for the browser-side tools.
 *
 * The bucket has no CORS policy, so a tool that draws a library picture on a
 * canvas — the logo stamp, the cropper — cannot fetch the public URL: the
 * bytes come back unreadable and the canvas is tainted. This hands the same
 * object over from the app's own origin instead.
 *
 * Deliberately not /api/png: that one transcodes with sharp for the
 * clipboard, and putting a shift's worth of promo art through it would be a
 * lot of work on a 384 MB box for no gain. Tools decode WebP fine.
 *
 * Behind the same session gate as everything else.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { loadVault } from "@/lib/store";
import { getObject } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
};

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth();
  } catch {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { id } = await ctx.params;
  const image = (await loadVault()).images.find((i) => i.id === id);
  if (!image) return new NextResponse("Not Found", { status: 404 });

  const bytes = await getObject(image.key);
  if (!bytes) return new NextResponse("Not Found", { status: 404 });

  const ext = image.key.split(".").pop()?.toLowerCase() ?? "";
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": TYPES[ext] ?? "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, max-age=300",
    },
  });
}
