// ── Shrinking pictures, in the browser ────────────────────────────────────────
// Nothing here touches the server. A phone photo is 4 MB; a busy day is fifty
// of them; and the Railway box has 384 MB — so the one place this can run at
// scale is the machine the picture is already on.

export type ShrinkMode = "kb" | "quality" | "width";
export type ShrinkFormat = "image/webp" | "image/jpeg" | "image/png";

export type ShrinkSettings = {
  mode: ShrinkMode;
  /** For "kb": the ceiling per picture, in KB. */
  maxKb: number;
  /** For "quality": 0.3–0.95. */
  quality: number;
  /** For "width": the longest edge allowed. */
  maxWidth: number;
  format: ShrinkFormat;
};

export const DEFAULT_SHRINK: ShrinkSettings = {
  mode: "kb", maxKb: 500, quality: 0.8, maxWidth: 1920, format: "image/webp",
};

export type ShrinkResult = {
  blob: Blob;
  width: number;
  height: number;
  /** What the picture was before. */
  from: { bytes: number; width: number; height: number };
};

/** Decodes anything the browser can open, HEIC included where it can. */
export async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    // Some browsers refuse createImageBitmap on formats an <img> still loads.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error("decode")); img.src = url; });
      return await createImageBitmap(img);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function draw(bitmap: ImageBitmap, width: number, height: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  return c;
}

const toBlob = (c: HTMLCanvasElement, type: string, q?: number) =>
  new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("encode"))), type, q));

/**
 * One picture, to the settings. For a size ceiling it searches the quality
 * first (six halvings between 0.95 and 0.3), and only when the floor of
 * quality is still too big does it shrink the picture itself — a smaller
 * sharp picture beats a big smeary one every time.
 */
export async function shrink(file: Blob, s: ShrinkSettings): Promise<ShrinkResult> {
  const bitmap = await decode(file);
  const from = { bytes: file.size, width: bitmap.width, height: bitmap.height };
  const type = s.format;
  const supportsQ = type !== "image/png";

  const fit = (maxW: number) => {
    const k = Math.min(1, maxW / Math.max(bitmap.width, bitmap.height));
    return { w: Math.max(1, Math.round(bitmap.width * k)), h: Math.max(1, Math.round(bitmap.height * k)) };
  };

  try {
    if (s.mode === "width") {
      const { w, h } = fit(s.maxWidth);
      const blob = await toBlob(draw(bitmap, w, h), type, supportsQ ? 0.86 : undefined);
      return { blob, width: w, height: h, from };
    }
    if (s.mode === "quality") {
      const { w, h } = fit(2560);
      const blob = await toBlob(draw(bitmap, w, h), type, supportsQ ? s.quality : undefined);
      return { blob, width: w, height: h, from };
    }

    const limit = s.maxKb * 1024;
    let edge = Math.max(bitmap.width, bitmap.height);
    for (let round = 0; round < 6; round++) {
      const { w, h } = fit(edge);
      const canvas = draw(bitmap, w, h);
      if (!supportsQ) {
        const blob = await toBlob(canvas, type);
        if (blob.size <= limit || edge <= 320) return { blob, width: w, height: h, from };
      } else {
        let lo = 0.3, hi = 0.95;
        let best: Blob | null = null;
        for (let i = 0; i < 6; i++) {
          const q = (lo + hi) / 2;
          const blob = await toBlob(canvas, type, q);
          if (blob.size <= limit) { best = blob; lo = q; } else { hi = q; }
        }
        if (best) return { blob: best, width: w, height: h, from };
        const floor = await toBlob(canvas, type, 0.3);
        if (floor.size <= limit || edge <= 320) return { blob: floor, width: w, height: h, from };
      }
      edge = Math.round(edge * 0.75);
    }
    const { w, h } = fit(edge);
    const blob = await toBlob(draw(bitmap, w, h), type, supportsQ ? 0.3 : undefined);
    return { blob, width: w, height: h, from };
  } finally {
    bitmap.close();
  }
}

export const extOf = (type: string) => (type === "image/webp" ? "webp" : type === "image/jpeg" ? "jpg" : "png");

/** `photo.HEIC` → `photo.webp`. */
export function renamed(name: string, type: string) {
  return name.replace(/\.[^.]+$/, "") + "." + extOf(type);
}

/** A copy of one picture as PNG, which is what the clipboard accepts. */
export async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await decode(blob);
  try {
    return await toBlob(draw(bitmap, bitmap.width, bitmap.height), "image/png");
  } finally {
    bitmap.close();
  }
}

// ── A ZIP with no compression ─────────────────────────────────────────────────
// Every entry is already a compressed image; deflating it again would gain
// nothing and cost a library. Store-only ZIP is forty lines and every
// unzipper on earth reads it.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export async function zipOf(files: { name: string; blob: Blob }[]): Promise<Blob> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const { time, date } = dosTime(new Date());

  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const name = enc.encode(f.name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }

  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  // Typed views over plain ArrayBuffers; the cast is for TypeScript's newer
  // "could be a SharedArrayBuffer" strictness, which these never are.
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[], { type: "application/zip" });
}
