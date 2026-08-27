import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans, Noto_Sans_Thai, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./vault.css";

// Jakarta carries the Latin UI and numerals; Noto Sans Thai is listed after it
// so Thai glyphs fall through to a face that actually has them. Both are
// self-hosted by next/font, which keeps the CSP at 'self' with no font CDN.
const sans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-sans",
});

const thai = Noto_Sans_Thai({
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-thai",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

export const viewport: Viewport = {
  themeColor: "#09060f",
  width: "device-width",
  initialScale: 1,
  // The app is a fixed full-height shell; letting iOS zoom on input focus
  // would scroll the whole chrome off screen.
  maximumScale: 1,
};

export const metadata: Metadata = {
  title: "Bubble Vault",
  description: "คลังรูปส่วนตัว — อัปโหลด จัดหมวด แล้วคัดลอกลิงก์ตรงไปใช้ที่เว็บไหนก็ได้",
  robots: { index: false, follow: false, nocache: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body
        className={`${sans.variable} ${thai.variable} ${mono.variable}`}
        style={{ fontFamily: "var(--font-sans), var(--font-thai), system-ui, sans-serif" }}
      >
        {children}
      </body>
    </html>
  );
}
