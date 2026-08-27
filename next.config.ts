import type { NextConfig } from "next";

// Direct image links are meant to be embedded on OTHER sites, so the usual
// lock-everything-down posture would break the entire point of this app. The
// headers below harden the *tool* (the admin UI) while leaving /uploads/* — the
// only publicly reachable path — freely embeddable.
const securityHeaders = [
  { key: "X-Frame-Options",           value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options",    value: "nosniff" },
  { key: "Referrer-Policy",           value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy",        value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // 'unsafe-inline' covers Next's inline bootstrap + the inline styles the
      // grid uses for blur placeholders. 'unsafe-eval' is dev-only (Turbopack).
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV !== "production" ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      // Thumbnails come from whichever R2 / CDN domain R2_PUBLIC_BASE points at.
      "img-src 'self' data: blob: https:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  compress: true,
  poweredByHeader: false,
  turbopack: { root: __dirname },

  images: {
    // Every image here is already a size-capped WebP on a CDN. Running them
    // through Next's optimizer would only add a proxy hop and hold decoded
    // variants in RAM — the exact cost this app exists to avoid.
    unoptimized: true,
  },

  experimental: {
    serverActions: {
      allowedOrigins: [
        ...(process.env.NODE_ENV !== "production" ? ["localhost:3100", "127.0.0.1:3100"] : []),
        ...(process.env.RAILWAY_PUBLIC_DOMAIN ? [process.env.RAILWAY_PUBLIC_DOMAIN] : []),
        ...(process.env.PUBLIC_HOST ? [process.env.PUBLIC_HOST] : []),
      ],
      // Must clear the 15 MB per-file guard in lib/actions.ts. Next's default
      // is 1 MB, which would reject most phone photos before the action runs.
      bodySizeLimit: "16mb",
    },
  },

  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      {
        // The admin UI is private and always fresh.
        source: "/",
        headers: [...securityHeaders, { key: "Cache-Control", value: "no-store, must-revalidate" }],
      },
      {
        // Locally-stored images (no R2 configured). Filenames carry a UUID and
        // are never reused, so they can be cached forever. CORP must be
        // cross-origin or other sites cannot embed them at all.
        source: "/uploads/(.*)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
