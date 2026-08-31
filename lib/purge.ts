// ── Cloudflare cache purge ────────────────────────────────────────────────────
// Objects are served with `immutable, max-age=1y`, which is what makes a page
// full of vault images essentially free after the first view — Cloudflare never
// asks R2 about them again. The cost is that overwriting an object leaves the
// edge serving the old bytes for months.
//
// Purging lets us overwrite in place and keep the URL. That matters more than
// it sounds: a storefront accumulates hundreds of embedded links over years,
// and any scheme that changes a URL means going back to edit every page that
// used it.
//
// Note what purging does NOT reach: a visitor whose own browser already cached
// the file keeps it until their cache expires. For a resize that is harmless —
// same picture, just a bigger file than necessary — which is precisely why
// overwriting is safe here and would not be for replacing one image with a
// different one.

const API = "https://api.cloudflare.com/client/v4";

type PurgeConfig = { zoneId: string; token: string };

/** A Cloudflare zone id is always 32 lowercase hex characters. */
const ZONE_ID_RE = /^[0-9a-f]{32}$/;

function readConfig(): PurgeConfig | null {
  const zoneId = process.env.CF_ZONE_ID?.trim();
  const token = process.env.CF_PURGE_TOKEN?.trim();
  if (!zoneId || !token) return null;

  // Worth checking rather than trusting: a zone id is copied by hand into a
  // dashboard, and losing one character produces a 32-character-looking value
  // that fails only at the moment of purging — after the object has already
  // been overwritten, with the stale copy left in circulation.
  if (!ZONE_ID_RE.test(zoneId)) {
    console.error(
      `CF_ZONE_ID is not a valid zone id (expected 32 hex characters, got ${zoneId.length}: "${zoneId}")`,
    );
    return null;
  }

  return { zoneId, token };
}

export function canPurge(): boolean {
  return readConfig() !== null;
}

export type PurgeResult = { ok: boolean; reason?: string };

/** Purges specific URLs from Cloudflare's edge. Up to 30 per call. */
export async function purgeUrls(urls: string[]): Promise<PurgeResult> {
  const cfg = readConfig();
  if (!cfg) return { ok: false, reason: "not-configured" };

  const unique = [...new Set(urls.filter((u) => /^https?:\/\//.test(u)))];
  if (unique.length === 0) return { ok: true };

  try {
    for (let i = 0; i < unique.length; i += 30) {
      const res = await fetch(`${API}/zones/${cfg.zoneId}/purge_cache`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ files: unique.slice(i, i + 30) }),
        signal: AbortSignal.timeout(10_000),
      });

      const body = await res.json().catch(() => null) as { success?: boolean; errors?: { message?: string }[] } | null;
      if (!res.ok || !body?.success) {
        const detail = body?.errors?.[0]?.message ?? `HTTP ${res.status}`;
        console.error("cache purge failed:", detail);
        return { ok: false, reason: detail };
      }
    }
    return { ok: true };
  } catch (e) {
    console.error("cache purge error:", e);
    return { ok: false, reason: (e as Error).message };
  }
}
