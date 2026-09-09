"use client";

// ── Crop ──────────────────────────────────────────────────────────────────────
// One picture at a time, a ratio, a rectangle dragged into place on a
// preview, then copy or download. Product pictures want the same shape every
// time; the ratio is remembered, the rectangle starts centred and as large as
// it can be, and a drag moves it — so most crops are throw, nudge, copy.

import { useCallback, useEffect, useRef, useState } from "react";
import { Clipboard, Download, Check, ImagePlus, X, Loader2 } from "lucide-react";
import { DEFAULT_CROP, RATIOS, clampRect, crop, fitRect, type CropSettings, type Ratio, type Rect } from "@/lib/crop";
import { asPng, decode, extOf, renamed } from "@/lib/shrink";
import { settingsStore } from "@/lib/settings-store";
import { formatBytes } from "./ui";

const store = settingsStore<CropSettings>("bv.crop.v1", DEFAULT_CROP);

type Source = { file: File; url: string; width: number; height: number };
type Handle = "move" | "nw" | "ne" | "sw" | "se";
type Out = { blob: Blob; url: string; width: number; height: number; forRect: Rect; forFormat: string; copied?: boolean };

export default function CropTool() {
  const settings = store.use();
  const [src, setSrc] = useState<Source | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [made, setMade] = useState<Out | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const drag = useRef<{ handle: Handle; startX: number; startY: number; from: Rect; k: number } | null>(null);

  const say = (text: string) => {
    setNote(text);
    setTimeout(() => setNote((n) => (n === text ? null : n)), 2500);
  };

  // ── In ─────────────────────────────────────────────────────────────────────
  const load = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/") && !/\.(heic|heif)$/i.test(file.name)) { say("ไม่พบรูปในสิ่งที่วาง"); return; }
    try {
      const bitmap = await decode(file);
      const next = { file, url: URL.createObjectURL(file), width: bitmap.width, height: bitmap.height };
      bitmap.close();
      setSrc((prev) => { if (prev) URL.revokeObjectURL(prev.url); return next; });
      setRect(fitRect(next.width, next.height, store.read().ratio));
    } catch {
      say("เปิดรูปนี้ไม่ได้");
    }
  }, []);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = Array.from(e.clipboardData?.files ?? [])[0];
      if (f) { e.preventDefault(); void load(f); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [load]);
  useEffect(() => () => { if (src) URL.revokeObjectURL(src.url); if (made) URL.revokeObjectURL(made.url); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The result is only good while the rectangle and format it was cut for
  // are still the ones on screen; a nudge makes it stale, and the next copy
  // or download cuts again.
  const out = made && made.forRect === rect && made.forFormat === settings.format ? made : null;

  const pickRatio = (ratio: Ratio) => {
    store.patch({ ratio });
    if (src) setRect(fitRect(src.width, src.height, ratio));
  };

  // ── The rectangle, by hand ─────────────────────────────────────────────────
  // Pointer maths in picture pixels: the preview is scaled, so one screen
  // pixel is `k` picture pixels, measured once at pointer-down. Corners resize
  // (keeping the ratio unless it is free); anywhere inside moves.
  const onDown = (e: React.PointerEvent) => {
    if (!rect || !src) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const handle = (el.dataset.h ?? "move") as Handle;
    const img = el.closest(".crop-stage")?.querySelector("img");
    const k = img ? src.width / img.clientWidth : 1;
    drag.current = { handle, startX: e.clientX, startY: e.clientY, from: rect, k };
    // Capture keeps the drag alive when the pointer leaves the stage. Some
    // pointers (a pen mid-gesture, a synthetic one) cannot be captured; the
    // drag still works while the pointer stays over the stage.
    try { el.setPointerCapture(e.pointerId); } catch { /* fine */ }
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !src) return;
    const dx = (e.clientX - d.startX) * d.k, dy = (e.clientY - d.startY) * d.k;
    const f = d.from;
    let next: Rect;
    if (d.handle === "move") {
      next = { ...f, x: f.x + dx, y: f.y + dy };
    } else {
      const r = RATIOS.find((x) => x.id === settings.ratio)!;
      const ax = d.handle.includes("e") ? 1 : -1, ay = d.handle.includes("s") ? 1 : -1;
      let w = f.w + dx * ax, h = f.h + dy * ay;
      if (r.w) { // keep the ratio: follow whichever axis moved more
        const k2 = r.w / r.h;
        if (Math.abs(dx) >= Math.abs(dy)) h = w / k2; else w = h * k2;
      }
      w = Math.max(8, w); h = Math.max(8, h);
      next = { x: ax < 0 ? f.x + f.w - w : f.x, y: ay < 0 ? f.y + f.h - h : f.y, w, h };
    }
    const c = clampRect({ x: Math.round(next.x), y: Math.round(next.y), w: Math.round(next.w), h: Math.round(next.h) }, src.width, src.height);
    setRect(c);
  };
  const onUp = () => { drag.current = null; };

  // ── Out ────────────────────────────────────────────────────────────────────
  const run = async (): Promise<Out | null> => {
    if (!src || !rect) return null;
    if (out) return out;
    setBusy(true);
    try {
      const format = store.read().format;
      const r = await crop(src.file, rect, format);
      const next: Out = { ...r, url: URL.createObjectURL(r.blob), forRect: rect, forFormat: format };
      setMade((prev) => { if (prev) URL.revokeObjectURL(prev.url); return next; });
      return next;
    } catch {
      say("ครอปไม่สำเร็จ");
      return null;
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    const r = await run();
    if (!r) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": await asPng(r.blob) })]);
      setMade((prev) => (prev === r ? { ...r, copied: true } : prev));
      say("คัดลอกแล้ว — วางในแชตได้เลย");
    } catch {
      say("เบราว์เซอร์นี้คัดลอกรูปไม่ได้ — ใช้ดาวน์โหลดแทน");
    }
  };
  const download = async () => {
    const r = await run();
    if (!r || !src) return;
    const a = document.createElement("a");
    a.href = r.url;
    a.download = renamed(src.file.name.replace(/\.[^.]+$/, "") + "-crop", r.blob.type);
    a.click();
  };
  const clear = () => {
    if (src) URL.revokeObjectURL(src.url);
    if (made) URL.revokeObjectURL(made.url);
    setSrc(null); setRect(null); setMade(null);
  };

  const pct = (n: number, of: number) => `${(n / of) * 100}%`;

  return (
    <div
      className="shrink cropt"
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) void load(f); }}
    >
      <div className="shrink-drop" data-over={over} onClick={() => !src && fileInput.current?.click()}>
        {!src || !rect ? (
          <div className="shrink-empty">
            <span className="empty-orb"><ImagePlus size={30} /></span>
            <b>โยนรูปเข้ามาได้เลย</b>
            <span>ลากวาง · Ctrl+V · หรือกดตรงนี้เพื่อเลือกไฟล์ · ทีละรูป</span>
            <small>ทำในเบราว์เซอร์ทั้งหมด ไม่มีอะไรถูกอัปโหลด</small>
          </div>
        ) : (
          <>
            <div className="crop-stage" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src.url} alt="" draggable={false} />
              <div className="crop-shade" style={{ left: pct(rect.x, src.width), top: pct(rect.y, src.height), width: pct(rect.w, src.width), height: pct(rect.h, src.height) }}>
                <div className="crop-box" data-h="move" onPointerDown={onDown}>
                  <i /><i /><i /><i />
                  {(["nw", "ne", "sw", "se"] as Handle[]).map((h) => (
                    <b key={h} data-h={h} onPointerDown={onDown} />
                  ))}
                </div>
              </div>
            </div>
            <p className="crop-meta tnum">
              <b>{src.file.name}</b> · ต้นฉบับ {src.width}×{src.height} → ครอป <b>{rect.w}×{rect.h}</b>
              {out && <> · {formatBytes(out.blob.size)} · {extOf(out.blob.type)}</>}
              <button type="button" className="crop-x" onClick={clear} title="เอาออก" aria-label="เอาออก"><X size={13} /></button>
            </p>
            <button type="button" className="shrink-more" onClick={() => fileInput.current?.click()}>
              วางรูปใหม่ · Ctrl+V · หรือกดเพื่อเลือกไฟล์
            </button>
          </>
        )}
        <input
          ref={fileInput} type="file" accept="image/*,.heic,.heif" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); e.target.value = ""; }}
        />
      </div>

      <div className="shrink-side">
        <div>
          <span className="f-lbl">สัดส่วน</span>
          <div className="crop-ratios" role="radiogroup">
            {RATIOS.map((r) => (
              <button key={r.id} type="button" data-on={settings.ratio === r.id} onClick={() => pickRatio(r.id)}>
                <i style={r.w ? { aspectRatio: `${r.w} / ${r.h}` } : { aspectRatio: "5 / 4", borderStyle: "dashed" }} />
                <span>{r.id === "free" ? "อิสระ" : r.id}</span>
                <small>{r.label}</small>
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="f-lbl">รูปแบบไฟล์</span>
          <div className="seg seg--full" role="radiogroup">
            {([["image/webp", "WebP"], ["image/jpeg", "JPEG"], ["image/png", "PNG"]] as [CropSettings["format"], string][]).map(([f, label]) => (
              <button key={f} type="button" data-on={settings.format === f} onClick={() => store.patch({ format: f })}>{label}</button>
            ))}
          </div>
        </div>

        <div className="shrink-sum">
          ลากกรอบเพื่อย้าย · ลากมุมเพื่อย่อขยาย
          <span>สัดส่วนล็อกตามที่เลือก เลือก “อิสระ” ถ้าอยากตัดตามใจ · จำสัดส่วนไว้ให้ครั้งหน้า</span>
        </div>

        <div className="shrink-foot">
          {note && <p className="shrink-note">{note}</p>}
          <button type="button" className="btn btn--primary btn--lg" disabled={!rect || busy} onClick={() => void copy()}>
            {busy ? <Loader2 size={16} className="spin" /> : out?.copied ? <Check size={16} /> : <Clipboard size={16} />} คัดลอก · วางได้เลย
          </button>
          <div className="shrink-two">
            <button type="button" className="btn" disabled={!rect || busy} onClick={() => void download()}>
              <Download size={15} /> ดาวน์โหลด
            </button>
            <button type="button" className="btn" disabled={!src} onClick={clear}>
              <X size={15} /> ล้าง
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
