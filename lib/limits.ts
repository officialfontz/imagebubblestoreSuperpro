// ── Shared limits ─────────────────────────────────────────────────────────────
// Here rather than in either route, because /api/pair advertises the number and
// /api/capture enforces it. Two copies were free to drift apart, which shows up
// as the app confidently sending an upload the server refuses.

/**
 * The app already downscales to 1920px and encodes before sending, so a real
 * capture is 200 KB - 2 MB. This is generous headroom that still bounds what a
 * single request can make the container decode.
 */
export const CAPTURE_MAX_BYTES = 8 * 1024 * 1024;
