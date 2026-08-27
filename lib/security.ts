// ── Upload validation + client IP ─────────────────────────────────────────────

export const SAFE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

const MAGIC_BYTES = {
  jpg:  [255, 216, 255],
  jpeg: [255, 216, 255],
  png:  [137, 80, 78, 71],
  gif:  [71, 73, 70, 56],
  webp: [82, 73, 70, 70], // "RIFF" — the WEBP tag sits at offset 8
} as const;

type SafeExtension = keyof typeof MAGIC_BYTES;

/**
 * Confirms the file's leading bytes match the extension derived from its MIME
 * type. The declared type is attacker-controlled; the bytes are not.
 */
export function checkMagicBytes(buffer: Uint8Array, ext: string): boolean {
  const signature = MAGIC_BYTES[ext.toLowerCase() as SafeExtension];
  if (!signature) return false;
  if (buffer.length < signature.length) return false;
  return signature.every((value, index) => buffer[index] === value);
}

type HeaderBag = Pick<Headers, "get">;

/**
 * Resolves the real client IP behind Cloudflare and/or Railway.
 * cf-connecting-ip comes first: Cloudflare overwrites it with the true end-user
 * address, whereas x-real-ip behind Cloudflare is the edge server itself —
 * which would collapse every visitor into one bucket for rate limiting.
 */
export function getTrustedClientIp(headers: HeaderBag): string | null {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;

  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;

  const forwarded = headers.get("x-forwarded-for")?.trim();
  if (forwarded) return forwarded.split(",")[0].trim();

  if (process.env.NODE_ENV !== "production") return "127.0.0.1";
  return null;
}
