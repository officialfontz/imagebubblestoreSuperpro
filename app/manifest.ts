import type { MetadataRoute } from "next";

// Installable, so the owner's phone gets a home-screen icon and — the part that
// matters — a place browser notifications are allowed to arrive. iOS only
// delivers them to a web app that has been added to the home screen.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Bubble Vault",
    short_name: "Vault",
    description: "คลังรูปและหลักฐานส่งของของร้าน",
    start_url: "/",
    display: "standalone",
    background_color: "#09060f",
    theme_color: "#09060f",
    lang: "th",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
