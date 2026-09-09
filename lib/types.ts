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

/**
 * A staff member who sends delivery proof from the Bubble Capture desktop app.
 *
 * The roster lives in vault.json rather than a separate file because it is
 * tiny, changes a few times a year, and every capture upload has to resolve a
 * token against it — one already-cached read instead of a second round-trip.
 */
export type VaultStaff = {
  id: string;
  name: string;
  /** Single emoji, shown as this person's mark in the sidebar and on tiles. */
  emoji: string;
  createdAt: number;
  /**
   * sha256 of the device's bearer token, hex. The token itself is shown once at
   * pairing and never stored — a leaked catalog therefore cannot be used to
   * upload. Absent means "never paired, or the access was revoked".
   */
  tokenHash?: string;
  /**
   * A live pairing code, as a digest. Set while the owner has one on screen and
   * cleared the moment it is redeemed. Stored rather than kept in memory
   * because the code is issued by a server action and redeemed by a route
   * handler, which are not guaranteed to share a process module.
   */
  pairing?: { hash: string; expiresAt: number };
  revokedAt?: number;
  lastSeenAt?: number;
  /** What the device's own upload queue looked like the last time it called.
   *  `failed` are captures the server refused for good; `pending` are still
   *  being retried. Either above zero is proof sitting on a staff PC. */
  queue?: { pending: number; failed: number; at: number };
  deviceName?: string;
  platform?: "windows" | "macos";
  appVersion?: string;
  /** Result of the app's built-in five-step check, so a Windows install can be
   *  verified without a screen share. */
  lastSelfTest?: { at: number; passed: number; total: number; report: string };
  /** Log tail the staff member sent with "ส่งรายงานปัญหา". */
  lastReport?: { at: number; text: string };
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

  // ── Delivery-proof fields ───────────────────────────────────────────────────
  // Only set on captures, which live in the monthly capture catalogs rather
  // than in `images`. The type is shared so the viewer, the copy menu and
  // resizedUrl() work on a capture without a second code path.

  /** Marks this record as delivery proof rather than a library image. */
  kind?: "capture";
  /** VaultStaff.id of whoever sent it. */
  uploader?: string;
  /** The customer's in-game name — the only thing a capture is filed under. */
  customer?: string;
  /** What was delivered. Picked by the sender with one tap; absent on captures
   *  from before the field existed, which the UI files as "อื่น ๆ". */
  category?: CaptureCategory;
  /** Device clock at the moment of capture, which can precede createdAt by
   *  hours if the upload sat in an offline queue. */
  capturedAt?: number;
  /** Device-generated UUID. A retried upload carries the same one, which is
   *  what stops a flaky connection from filing the same proof twice. */
  clientId?: string;
  /**
   * Which monthly catalog holds this record, "YYYY-MM".
   *
   * Carried on the row rather than inferred from whichever month the UI has
   * open: search spans the whole retention window, and renaming a result from
   * two months ago used to rewrite the wrong file and report "not found".
   */
  month?: string;
};

export type VaultData = {
  version: 1;
  albums: VaultAlbum[];
  images: VaultImage[];
  staff: VaultStaff[];
};

export const emptyVault = (): VaultData => ({ version: 1, albums: [], images: [], staff: [] });

/**
 * One month of delivery proof, stored as its own object.
 *
 * Captures deliberately do NOT join `images`. vault.json is read, cloned,
 * re-serialised and re-uploaded on every single mutation, and it is shipped to
 * the browser in full on every page load — at ~20k captures a year that file
 * would grow into the megabytes and make renaming one library image an
 * expensive operation. Splitting by month keeps each object under a megabyte
 * forever and makes the 90-day sweep a file deletion instead of a rewrite.
 */
export type CaptureMonth = {
  version: 1;
  /** "YYYY-MM", UTC. */
  month: string;
  captures: VaultImage[];
};

export const emptyCaptureMonth = (month: string): CaptureMonth => ({ version: 1, month, captures: [] });

/**
 * How long delivery proof is kept before the sweep destroys it.
 *
 * NEXT_PUBLIC_ so the viewer's "เก็บอีก N วัน" is the real number: a plain env
 * var is not inlined into the client bundle, so the countdown silently fell
 * back to 90 no matter what the server was configured with.
 */
export const CAPTURE_RETENTION_DAYS = Number(
  process.env.NEXT_PUBLIC_CAPTURE_RETENTION_DAYS ?? process.env.CAPTURE_RETENTION_DAYS ?? 90,
);

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

// ── What a delivery was ───────────────────────────────────────────────────────
// Three kinds of order, one tap each. The list is closed on purpose: a free-text
// field would give the shop "gamepass", "Game pass" and "GP" within a week, and
// the whole point is that the web can file them apart without anyone tidying.
export const CAPTURE_CATEGORIES = ["gamepass", "robux", "farm"] as const;
export type CaptureCategory = (typeof CAPTURE_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<CaptureCategory, string> = {
  gamepass: "Game Pass",
  robux: "Robux",
  farm: "ฟาร์ม",
};

export function isCaptureCategory(v: unknown): v is CaptureCategory {
  return typeof v === "string" && (CAPTURE_CATEGORIES as readonly string[]).includes(v);
}
