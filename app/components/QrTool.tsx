"use client";

// ── QR ────────────────────────────────────────────────────────────────────────
// A link — a picture in the vault, a payment page, the shop — as a QR with the
// logo in the middle, to paste into a chat or print on a card. Drawn in the
// browser; nothing leaves it.

import { useEffect, useRef, useState } from "react";
import { Clipboard, Download, Check, QrCode } from "lucide-react";
import QR from "qrcode";
import { loadShopLogo } from "@/lib/watermark";
import { settingsStore } from "@/lib/settings-store";

type QrSettings = { size: number; logo: boolean; dark: boolean };
const store = settingsStore<QrSettings>("bv.qr.v1", { size: 512, logo: true, dark: false });
const SIZES = [256, 512, 1024];

export default function QrTool() {
  const s = store.use();
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  const say = (t: string) => { setNote(t); setTimeout(() => setNote((n) => (n === t ? null : n)), 2500); };

  // Redraw whenever the text or a setting changes. High error correction so
  // the logo can cover the middle and the code still scans.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    let gone = false;
    (async () => {
      const value = text.trim();
      const ctx = c.getContext("2d")!;
      c.width = s.size; c.height = s.size;
      if (!value) { ctx.clearRect(0, 0, s.size, s.size); return; }
      await QR.toCanvas(c, value, {
        width: s.size, margin: 2, errorCorrectionLevel: "H",
        color: s.dark ? { dark: "#f6f3feff", light: "#09060fff" } : { dark: "#1a1030ff", light: "#ffffffff" },
      });
      if (gone || !s.logo) return;
      const logo = await loadShopLogo();
      if (gone) return;
      const lw = Math.round(s.size * 0.22);
      const x = (s.size - lw) / 2;
      // A rounded plate behind the logo so it never sits on modules.
      ctx.fillStyle = s.dark ? "#09060f" : "#ffffff";
      ctx.beginPath();
      ctx.roundRect(x - lw * 0.08, x - lw * 0.08, lw * 1.16, lw * 1.16, lw * 0.2);
      ctx.fill();
      ctx.drawImage(logo, x, x, lw, lw);
    })().catch(() => say("สร้าง QR ไม่ได้ — ข้อความยาวเกินไป"));
    return () => { gone = true; };
  }, [text, s.size, s.logo, s.dark]);

  const blob = () => new Promise<Blob>((ok, bad) => canvas.current!.toBlob((b) => (b ? ok(b) : bad(new Error("encode"))), "image/png"));

  const copy = async () => {
    if (!text.trim()) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": await blob() })]);
      setCopied(true); setTimeout(() => setCopied(false), 1800);
      say("คัดลอกแล้ว — วางในแชตได้เลย");
    } catch {
      say("เบราว์เซอร์นี้คัดลอกรูปไม่ได้ — ใช้ดาวน์โหลดแทน");
    }
  };
  const download = async () => {
    if (!text.trim()) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await blob());
    a.download = "bubble-qr.png";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  return (
    <div className="shrink qr">
      <div className="qr-stage" data-empty={!text.trim()}>
        <canvas ref={canvas} width={s.size} height={s.size} aria-label="QR" />
        {!text.trim() && (
          <div className="shrink-empty">
            <span className="empty-orb"><QrCode size={30} /></span>
            <b>วางลิงก์ทางขวา</b>
            <span>ลิงก์รูปในคลัง · หน้าร้าน · ลิงก์โอนเงิน · อะไรก็ได้</span>
          </div>
        )}
      </div>

      <div className="shrink-side">
        <div>
          <span className="f-lbl">ลิงก์หรือข้อความ</span>
          <textarea
            className="qr-in" value={text} onChange={(e) => setText(e.target.value)} rows={4}
            placeholder="https://…" spellCheck={false} autoFocus
          />
        </div>
        <div>
          <span className="f-lbl">ขนาด</span>
          <div className="seg seg--full" role="radiogroup">
            {SIZES.map((n) => <button key={n} type="button" data-on={s.size === n} onClick={() => store.patch({ size: n })}>{n}px</button>)}
          </div>
        </div>
        <div className="qr-checks">
          <label className="check"><input type="checkbox" checked={s.logo} onChange={(e) => store.patch({ logo: e.target.checked })} /> โลโก้ร้านตรงกลาง</label>
          <label className="check"><input type="checkbox" checked={s.dark} onChange={(e) => store.patch({ dark: e.target.checked })} /> พื้นมืด <span className="check-note">สแกนยากกว่านิดหน่อย</span></label>
        </div>
        <div className="shrink-foot">
          {note && <p className="shrink-note">{note}</p>}
          <button type="button" className="btn btn--primary btn--lg" disabled={!text.trim()} onClick={() => void copy()}>
            {copied ? <Check size={16} /> : <Clipboard size={16} />} คัดลอก QR · วางได้เลย
          </button>
          <button type="button" className="btn" disabled={!text.trim()} onClick={() => void download()}><Download size={15} /> ดาวน์โหลด PNG</button>
        </div>
      </div>
    </div>
  );
}
