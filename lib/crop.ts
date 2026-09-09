// ── Cropping to a ratio, in the browser ───────────────────────────────────────
// Product pictures and posts want fixed shapes: square for a catalogue, 4:5
// for a feed, 16:9 for a banner. The picture is decoded once; the crop is a
// rectangle in picture pixels, chosen by hand on the preview.

import { decode } from "./shrink";

export type Ratio = "1:1" | "4:5" | "3:4" | "16:9" | "9:16" | "free";
export const RATIOS: { id: Ratio; label: string; w: number; h: number }[] = [
  { id: "1:1", label: "จัตุรัส", w: 1, h: 1 },
  { id: "4:5", label: "โพสต์", w: 4, h: 5 },
  { id: "3:4", label: "แนวตั้ง", w: 3, h: 4 },
  { id: "16:9", label: "แบนเนอร์", w: 16, h: 9 },
  { id: "9:16", label: "สตอรี่", w: 9, h: 16 },
  { id: "free", label: "อิสระ", w: 0, h: 0 },
];

export type Rect = { x: number; y: number; w: number; h: number };

export type CropSettings = {
  ratio: Ratio;
  format: "image/webp" | "image/png" | "image/jpeg";
};
export const DEFAULT_CROP: CropSettings = { ratio: "1:1", format: "image/webp" };

/** The largest centred rectangle of the ratio that fits the picture. */
export function fitRect(W: number, H: number, ratio: Ratio): Rect {
  const r = RATIOS.find((x) => x.id === ratio)!;
  if (r.w === 0) return { x: 0, y: 0, w: W, h: H };
  const k = r.w / r.h;
  let w = W, h = Math.round(W / k);
  if (h > H) { h = H; w = Math.round(H * k); }
  return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h };
}

/** Keeps a rectangle inside the picture, and at least a few pixels wide. */
export function clampRect(r: Rect, W: number, H: number): Rect {
  const w = Math.max(8, Math.min(r.w, W));
  const h = Math.max(8, Math.min(r.h, H));
  return { x: Math.min(Math.max(0, r.x), W - w), y: Math.min(Math.max(0, r.y), H - h), w, h };
}

/** Cuts the rectangle out and encodes it. */
export async function crop(file: Blob, rect: Rect, format: CropSettings["format"]): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await decode(file);
  try {
    const r = clampRect(rect, bitmap.width, bitmap.height);
    const c = document.createElement("canvas");
    c.width = r.w;
    c.height = r.h;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bitmap, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    const blob = await new Promise<Blob>((ok, bad) =>
      c.toBlob((b) => (b ? ok(b) : bad(new Error("encode"))), format, format === "image/png" ? undefined : 0.92),
    );
    return { blob, width: r.w, height: r.h };
  } finally {
    bitmap.close();
  }
}
