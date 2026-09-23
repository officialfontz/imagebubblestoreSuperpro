// ── Putting the shop's mark on pictures ───────────────────────────────────────
// Product photos and promo images go out with the logo in a corner, so a
// picture lifted from the shop's chat still says whose it is. Client-side,
// like every tool here.

import { decode } from "./shrink";

export type Corner = "tl" | "tr" | "bl" | "br" | "c";

export type WatermarkSettings = {
  /** What gets laid on: the corner logo, the footer strip, or both. */
  mode: "logo" | "footer" | "both";
  /** The library image used as the footer strip, if one is picked. */
  footerId: string | null;
  corner: Corner;
  /** Logo width as a fraction of the picture's shorter edge. */
  size: number;
  /** 0–1. */
  opacity: number;
  /** Margin from the edge, as a fraction of the shorter edge. */
  margin: number;
  /** Optional line under the logo — a handle, a shop name. */
  caption: string;
  format: "image/webp" | "image/png" | "image/jpeg";
};

export const DEFAULT_WATERMARK: WatermarkSettings = {
  mode: "logo", footerId: null,
  corner: "br", size: 0.18, opacity: 0.85, margin: 0.03, caption: "", format: "image/webp",
};

// ── Footer strips ─────────────────────────────────────────────────────────────
// A footer is a full-size picture with a transparent top and the contact bar
// along the bottom, so laying one on is one drawImage: scale it to the width
// and sit it on the bottom edge.

const footerCache = new Map<string, Promise<HTMLImageElement>>();

/** Loads a footer from the app's own origin — the bucket has no CORS policy. */
export function loadFooter(id: string): Promise<HTMLImageElement> {
  const hit = footerCache.get(id);
  if (hit) return hit;
  const job = new Promise<HTMLImageElement>((ok, bad) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => bad(new Error("footer"));
    img.src = `/api/file/${id}`;
  });
  footerCache.set(id, job);
  return job;
}

/** Draws the strip across the bottom, at the picture's own width. */
export function drawFooter(ctx: CanvasRenderingContext2D, footer: HTMLImageElement, W: number, H: number) {
  const scale = W / footer.naturalWidth;
  const h = footer.naturalHeight * scale;
  ctx.drawImage(footer, 0, H - h, W, h);
}

let logoPromise: Promise<HTMLImageElement> | null = null;
export function loadShopLogo(): Promise<HTMLImageElement> {
  logoPromise ??= new Promise((ok, bad) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => bad(new Error("logo"));
    img.src = "/logo.png";
  });
  return logoPromise;
}

/** Draws the mark and/or the footer onto a copy of the picture, and encodes it. */
export async function watermark(file: Blob, s: WatermarkSettings): Promise<{ blob: Blob; width: number; height: number }> {
  const wantsLogo = s.mode !== "footer";
  const wantsFooter = s.mode !== "logo" && Boolean(s.footerId);
  const [bitmap, logo, footer] = await Promise.all([
    decode(file),
    wantsLogo ? loadShopLogo() : Promise.resolve(null),
    wantsFooter ? loadFooter(s.footerId!).catch(() => null) : Promise.resolve(null),
  ]);
  try {
    const W = bitmap.width, H = bitmap.height;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    // The strip goes on first: the corner logo belongs on top of it, not under.
    if (footer) drawFooter(ctx, footer, W, H);
    if (logo) drawMark(ctx, logo, W, H, s);
    const blob = await new Promise<Blob>((ok, bad) =>
      c.toBlob((b) => (b ? ok(b) : bad(new Error("encode"))), s.format, s.format === "image/png" ? undefined : 0.9),
    );
    return { blob, width: W, height: H };
  } finally {
    bitmap.close();
  }
}

/** The mark itself, so the preview and the export are one drawing. */
export function drawMark(ctx: CanvasRenderingContext2D, logo: HTMLImageElement, W: number, H: number, s: WatermarkSettings) {
  const short = Math.min(W, H);
  const lw = Math.round(short * s.size);
  const lh = Math.round(lw * (logo.naturalHeight / logo.naturalWidth));
  const m = Math.round(short * s.margin);
  const fontPx = Math.max(12, Math.round(lw * 0.16));
  const capH = s.caption ? Math.round(fontPx * 1.5) : 0;
  const totalH = lh + capH;

  let x: number, y: number;
  switch (s.corner) {
    case "tl": x = m; y = m; break;
    case "tr": x = W - m - lw; y = m; break;
    case "bl": x = m; y = H - m - totalH; break;
    case "c": x = Math.round((W - lw) / 2); y = Math.round((H - totalH) / 2); break;
    default: x = W - m - lw; y = H - m - totalH;
  }

  ctx.save();
  ctx.globalAlpha = s.opacity;
  // A soft shadow so the mark reads on a white product shot as well as a dark
  // game screen, without a box around it.
  ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
  ctx.shadowBlur = Math.max(4, lw * 0.08);
  ctx.shadowOffsetY = Math.max(1, lw * 0.02);
  ctx.drawImage(logo, x, y, lw, lh);
  if (s.caption) {
    ctx.font = `800 ${fontPx}px "Noto Sans Thai", "Plus Jakarta Sans", system-ui, sans-serif`;
    ctx.textBaseline = "top";
    ctx.textAlign = s.corner === "tl" || s.corner === "bl" ? "left" : s.corner === "c" ? "center" : "right";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(2, fontPx * 0.18);
    ctx.strokeStyle = "rgba(9, 6, 15, 0.8)";
    ctx.fillStyle = "#ffffff";
    const tx = ctx.textAlign === "left" ? x : ctx.textAlign === "center" ? x + lw / 2 : x + lw;
    ctx.strokeText(s.caption, tx, y + lh + fontPx * 0.25);
    ctx.fillText(s.caption, tx, y + lh + fontPx * 0.25);
  }
  ctx.restore();
}
