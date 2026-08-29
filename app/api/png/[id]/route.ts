/**
 * Serves one vault image as PNG, for "copy image" in the context menu.
 *
 * Two reasons this cannot just fetch the public URL from the browser:
 *   - the bucket has no CORS policy, so a cross-origin fetch cannot read the
 *     bytes back, and a canvas drawn from it would be tainted;
 *   - the clipboard accepts PNG far more widely than WebP, so the stored WebP
 *     has to be transcoded anyway.
 *
 * Behind the same session gate as everything else — proxy.ts leaves only
 * /uploads/* and /login public.
 */

import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { requireAuth } from "@/lib/auth";
import { loadVault } from "@/lib/store";
import { getObject } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  try {
    // animated: false — the clipboard takes a single frame, and asking sharp
    // for every frame of an animated WebP would balloon the PNG.
    const png = await sharp(bytes, { animated: false }).png({ compressionLevel: 6 }).toBuffer();
    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(png.byteLength),
        // Private and short-lived: this exists to feed one clipboard write.
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (e) {
    console.error("png transcode failed:", e);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
