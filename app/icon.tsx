import { ImageResponse } from "next/og";

// Generated at build time so the tab icon matches the brand mark in the sidebar
// without shipping a binary asset to keep in sync.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 3,
          borderRadius: 8,
          background: "linear-gradient(135deg, #8b5cf6 0%, #a855f7 45%, #e879f9 100%)",
        }}
      >
        {/* Drawn with boxes rather than a glyph: ImageResponse has no bundled
            font for symbol characters and tries to download one at build time,
            which fails in a sandboxed CI. */}
        <div style={{ width: 16, height: 3, borderRadius: 2, background: "#fff" }} />
        <div style={{ width: 16, height: 3, borderRadius: 2, background: "rgba(255,255,255,0.75)" }} />
        <div style={{ width: 16, height: 3, borderRadius: 2, background: "rgba(255,255,255,0.5)" }} />
      </div>
    ),
    size,
  );
}
