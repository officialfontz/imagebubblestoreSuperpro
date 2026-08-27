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
};

export type VaultData = {
  version: 1;
  albums: VaultAlbum[];
  images: VaultImage[];
};

export const emptyVault = (): VaultData => ({ version: 1, albums: [], images: [] });

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
