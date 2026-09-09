// ── Image encoding ────────────────────────────────────────────────────────────
// Shared by the browser upload action and by the desktop app's capture endpoint
// so both produce byte-identical results. Plain module, not "use server": these
// are helpers, not actions, and marking the file would force every export to
// become an async server entry point.
//
// R2 egress is free and 10 GB of storage covers tens of thousands of images, so
// there is nothing to buy by compressing hard — quality is the only thing worth
// optimising for. 3000 px keeps a generous original for Cloudflare's read-time
// resizer (/cdn-cgi/image/width=…) to work from, and q92 is high enough that
// artefacts around text and flat colour do not show.

import sharp from "sharp";
import { randomUUID } from "crypto";

// sharp keeps a decoded-image cache and a libvips thread pool, both sized for a
// machine with room to spare. On a 384 MB Railway container three large PNGs
// arriving together is enough to be killed for memory, so both are disabled and
// concurrency is bounded by withEncodeSlot below.
sharp.cache(false);
sharp.concurrency(1);

export const MAX_DIMENSION   = Number(process.env.VAULT_MAX_DIMENSION ?? 3000);
export const WEBP_QUALITY    = Number(process.env.VAULT_WEBP_QUALITY ?? 92);
export const MAX_INPUT_BYTES = 15 * 1024 * 1024;

export const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png":  "png",
  "image/webp": "webp",
  "image/gif":  "gif",
};

/**
 * Flat-colour graphics — price cards, banners, logos, screenshots — often come
 * out SMALLER as lossless WebP than as a high-quality lossy one, because large
 * areas of identical colour compress almost for free. Photographs never do.
 *
 * Source format is a good enough proxy: PNG and GIF are what graphics arrive
 * as, JPEG is what cameras produce. Trying lossless on every 12 MP photo would
 * burn CPU on a candidate that cannot win.
 */
function shouldTryLossless(ext: string): boolean {
  return ext === "png" || ext === "gif" || ext === "webp";
}

export function monthFolder(at: number = Date.now()): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Object key for stored bytes. "img" is the library, "cap" is delivery proof —
 *  kept apart so rebuild-catalog, which lists img/, can never pull a customer's
 *  proof into the public library. */
export function objectKey(prefix: "img" | "cap", ext: string, at?: number): string {
  return `${prefix}/${monthFolder(at)}/${randomUUID()}.${ext}`;
}

/** Strip the extension and anything that would look odd in a filename column. */
export function cleanName(raw: string): string {
  const base = raw.replace(/\.[A-Za-z0-9]{1,5}$/, "").trim();
  return (base || "ไม่มีชื่อ").slice(0, 120);
}

// ── Concurrency gate ──────────────────────────────────────────────────────────
// A decoded 4000×2000 RGBA frame is ~32 MB. Two at a time is the most this
// container can hold alongside Next itself; the rest wait rather than pushing
// the process into the OOM killer, which would drop uploads already in flight.
const MAX_CONCURRENT_ENCODES = 2;
let _active = 0;
const _waiting: (() => void)[] = [];

/**
 * Waits until a slot is genuinely free.
 *
 * The loop matters: a caller that arrives while a waiter is being woken would
 * otherwise take the slot, and the woken waiter — which resumed without
 * re-checking — would take it too. Four concurrent sharp decodes is exactly the
 * memory blow-up this gate exists to prevent.
 */
export async function withEncodeSlot<T>(work: () => Promise<T>): Promise<T> {
  while (_active >= MAX_CONCURRENT_ENCODES) {
    await new Promise<void>((resolve) => _waiting.push(resolve));
  }
  _active++;
  try {
    return await work();
  } finally {
    _active--;
    _waiting.shift()?.();
  }
}

export type Encoded = {
  data: Uint8Array;
  ext: string;
  mime: string;
  width: number;
  height: number;
  /** ~200-byte base64 placeholder, so a grid paints instantly on a cold cache. */
  blur?: string;
};

/**
 * Re-encodes to WebP, capped at MAX_DIMENSION. Never throws and never returns
 * something worse than it was given: a corrupt-but-valid-header file, or one
 * that simply does not compress, comes back as the original bytes.
 */
export async function encodeImage(
  input: Uint8Array,
  ext: string,
  mime: string,
  opts: { maxDimension?: number; quality?: number } = {},
): Promise<Encoded> {
  const maxDimension = opts.maxDimension ?? MAX_DIMENSION;
  const quality = opts.quality ?? WEBP_QUALITY;
  const isAnimated = ext === "gif";

  const out: Encoded = { data: input, ext, mime, width: 0, height: 0 };

  try {
    const resized = () =>
      sharp(input, { animated: isAnimated })
        .rotate() // apply EXIF orientation, then drop the tag
        .resize(maxDimension, maxDimension, { fit: "inside", withoutEnlargement: true });

    const lossy = await resized().webp({ quality, effort: 4 }).toBuffer({ resolveWithObject: true });

    // Lossless is a free upgrade whenever it also happens to be smaller —
    // perfect fidelity at no cost in bytes. Animated frames are excluded:
    // lossless multiplies their size with no chance of winning.
    let best = lossy;
    if (!isAnimated && shouldTryLossless(ext)) {
      try {
        const lossless = await resized().webp({ lossless: true, effort: 4 }).toBuffer({ resolveWithObject: true });
        if (lossless.data.length < lossy.data.length) best = lossless;
      } catch {
        // Keep the lossy candidate — it already succeeded.
      }
    }

    const { data, info } = best;
    out.width = info.width;
    // sharp reports an animated WebP's height as frames × frame-height.
    out.height = isAnimated && info.pages && info.pages > 1 ? Math.round(info.height / info.pages) : info.height;

    if (data.length < input.length) {
      out.data = data;
      out.ext = "webp";
      out.mime = "image/webp";
    } else {
      const meta = await sharp(input).metadata();
      out.width = meta.width ?? 0;
      out.height = meta.height ?? 0;
    }

    const tiny = await sharp(input, { animated: false })
      .resize(16, 16, { fit: "inside" })
      .webp({ quality: 40 })
      .toBuffer();
    out.blur = `data:image/webp;base64,${tiny.toString("base64")}`;
  } catch (e) {
    console.error("vault encode failed, storing original:", e);
  }

  return out;
}

/** Re-encode at an exact width. Used by the in-place downscale feature. */
export async function encodeAtWidth(source: Uint8Array, width: number) {
  return sharp(source, { animated: false })
    .resize(width, undefined, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY, effort: 4 })
    .toBuffer({ resolveWithObject: true });
}
