// ── Vault types ───────────────────────────────────────────────────────────────
// The image vault is a private image host: drop files in, get permanent direct
// URLs out. Images live in Cloudflare R2 (free egress, global CDN) and are
// served straight from R2's public domain — they never touch the Railway
// container after upload, so the storefront can embed hundreds of them without
// paying Railway egress or risking a redeploy blanking the images.

/** A user-created folder. Images carry `albumId`; `null` means "unfiled". */
export type VaultAlbum = {
  id: string;
  name: string;
  /** Single emoji shown next to the album name in the sidebar. */
  emoji: string;
  createdAt: number;
};

export type VaultImage = {
  id: string;
  /** Object key inside the bucket, e.g. "img/2026-08/ab12cd34.webp". */
  key: string;
  /** Absolute, permanently-shareable URL. This is what the copy button yields. */
  url: string;
  /** Display name — defaults to the original filename, editable. */
  name: string;
  albumId: string | null;
  width: number;
  height: number;
  /** Stored byte size, after WebP conversion. */
  bytes: number;
  mime: string;
  createdAt: number;
  /** Tiny base64 preview (~200 bytes) rendered while the real image loads. */
  blur?: string;
  /** Original filename, set only by scripts/import-images.mjs. Persisted so a
   *  re-run of the import can skip what it already brought in. */
  importedFrom?: string;
  /**
   * When set, the image is in the trash: hidden from every normal view but not
   * yet destroyed. The R2 object is untouched, so the public link keeps working
   * and a restore returns the image with the same URL it always had — which is
   * the whole point, since those links are embedded on other people's pages.
   * Emptying the trash is what actually deletes the bytes.
   */
  deletedAt?: number;
};

export type VaultData = {
  version: 1;
  albums: VaultAlbum[];
  images: VaultImage[];
};

export const emptyVault = (): VaultData => ({ version: 1, albums: [], images: [] });

/**
 * Rewrites a public image URL to go through Cloudflare Image Resizing, which
 * resizes and re-encodes on the fly at the edge. One stored original therefore
 * serves every size the site needs — upload once at full detail, request the
 * width the slot actually wants.
 *
 * `format=auto` sends AVIF to browsers that take it (~20-30% smaller than the
 * stored WebP) and falls back on its own.
 *
 * Only works on a bucket fronted by a Cloudflare custom domain — the free
 * *.r2.dev hostname does not run the /cdn-cgi pipeline.
 */
export function resizedUrl(url: string, width: number, quality = 85): string {
  try {
    const u = new URL(url);
    return `${u.origin}/cdn-cgi/image/width=${width},quality=${quality},format=auto${u.pathname}`;
  } catch {
    // Relative URL (local-disk driver) — there is no edge to resize at.
    return url;
  }
}

/** Widths offered in the copy menu. */
export const RESIZE_WIDTHS = [400, 800, 1600] as const;

/** Link formats offered by the copy menu. */
export type CopyFormat = "direct" | "markdown" | "html" | "bbcode";

export function formatLink(format: CopyFormat, url: string, name: string): string {
  switch (format) {
    case "markdown": return `![${name}](${url})`;
    case "html":     return `<img src="${url}" alt="${name}" />`;
    case "bbcode":   return `[img]${url}[/img]`;
    default:         return url;
  }
}
