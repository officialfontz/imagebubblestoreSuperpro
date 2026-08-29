"use client";

// ── Downscale one image ───────────────────────────────────────────────────────
// Picking a width previews the real encode on the server, so the size shown is
// the size you get — not an estimate. Only then does the confirm button write.

import { useCallback, useEffect, useState } from "react";
import { Loader2, Minimize2, AlertTriangle, ArrowRight, ShieldCheck } from "lucide-react";
import type { VaultImage } from "@/lib/types";
import { previewResize } from "@/lib/actions";
import { formatBytes } from "./ui";

/** Offered as fractions of the current width, so the choices stay sensible for
 *  an image that is already small — a fixed 400/800/1600 list would show three
 *  options that all mean "no change" on a 320px logo. */
const STEPS = [0.75, 0.5, 0.35, 0.25];

type Preview = { bytes: number; width: number; height: number };
/** Tagged with the width it belongs to, so "still loading" is derived from a
 *  mismatch rather than tracked as its own piece of state. */
type Result = { forWidth: number; preview: Preview | null; error: string | null };

export default function ResizeDialog({
  image, keepsUrl, onApply, onClose,
}: {
  image: VaultImage;
  /** Whether the edge cache can be purged, and so whether the URL survives. */
  keepsUrl: boolean;
  onApply: (width: number) => void;
  onClose: () => void;
}) {
  const widths = Array.from(
    new Set(STEPS.map((f) => Math.round(image.width * f)).filter((w) => w >= 32)),
  );

  const [width, setWidth] = useState<number | null>(widths[1] ?? widths[0] ?? null);
  const [result, setResult] = useState<Result | null>(null);

  const pending = width !== null && result?.forWidth !== width;
  const preview = pending ? null : result?.preview ?? null;
  const error = pending ? null : result?.error ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Every width change re-encodes on the server; a stale reply must not
  // overwrite a newer one when the user clicks through the options quickly.
  useEffect(() => {
    if (width === null) return;
    let current = true;
    previewResize(image.id, width)
      .then((res) => {
        if (!current) return;
        setResult(res.ok
          ? { forWidth: width, preview: { bytes: res.bytes, width: res.width, height: res.height }, error: null }
          : { forWidth: width, preview: null, error: res.error });
      })
      .catch(() => {
        if (current) setResult({ forWidth: width, preview: null, error: "ย่อรูปไม่สำเร็จ" });
      });
    return () => { current = false; };
  }, [image.id, width]);

  const saved = preview ? image.bytes - preview.bytes : 0;
  const savedPct = preview && image.bytes ? Math.round((saved / image.bytes) * 100) : 0;

  const confirm = useCallback(() => {
    if (width === null || !preview) return;
    onApply(width);
    onClose();
  }, [width, preview, onApply, onClose]);

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal modal--wide" role="dialog" aria-modal="true" aria-label="ย่อขนาดรูป">
        <h2><Minimize2 size={15} /> ย่อขนาดรูป</h2>
        <p className="resize-name">{image.name}</p>

        <div className="resize-now">
          <span className="tnum">{image.width} × {image.height}</span>
          <span className="tnum">{formatBytes(image.bytes)}</span>
        </div>

        <div className="resize-steps">
          {widths.map((w) => (
            <button
              type="button"
              key={w}
              className="resize-step"
              data-on={w === width}
              onClick={() => setWidth(w)}
            >
              <b className="tnum">{w}px</b>
              <span className="tnum">{Math.round((w / image.width) * 100)}%</span>
            </button>
          ))}
        </div>

        <div className="resize-out" data-state={pending ? "load" : error ? "error" : preview ? "ok" : "idle"}>
          {pending && <><Loader2 size={15} className="spin" /> กำลังคำนวณขนาดจริง…</>}
          {!pending && error && <><AlertTriangle size={15} /> {error}</>}
          {!pending && !error && preview && (
            <>
              <span className="tnum">{formatBytes(image.bytes)}</span>
              <ArrowRight size={14} />
              <b className="tnum">{formatBytes(preview.bytes)}</b>
              <em className="tnum" data-good={saved > 0}>
                {saved > 0 ? `เล็กลง ${savedPct}%` : "ไม่เล็กลง"}
              </em>
              <span className="resize-dims tnum">{preview.width} × {preview.height}</span>
            </>
          )}
        </div>

        {keepsUrl ? (
          <p className="resize-warn" data-tone="ok">
            <ShieldCheck size={14} />
            <span>
              <b>ลิงก์เดิมไม่เปลี่ยน</b> — ทับไฟล์เดิมแล้วสั่ง Cloudflare ล้างแคชให้
              ที่แปะไว้ตามเว็บต่าง ๆ ไม่ต้องไปแก้อะไรเลย
            </span>
          </p>
        ) : (
          <p className="resize-warn">
            <AlertTriangle size={14} />
            <span>
              <b>ลิงก์ของรูปนี้จะเปลี่ยนเป็นลิงก์ใหม่</b> — ถ้าเคยเอาลิงก์เดิมไปแปะที่เว็บอื่นไว้
              ต้องกลับไปเปลี่ยนด้วย · ตั้งค่า <code>CF_ZONE_ID</code> + <code>CF_PURGE_TOKEN</code>
              แล้วลิงก์จะคงเดิม
            </span>
          </p>
        )}

        <div className="modal-foot">
          <button type="button" className="btn btn--ghost" onClick={onClose}>ยกเลิก</button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!preview || pending || saved <= 0}
            onClick={confirm}
          >
            ย่อเป็น {width}px
          </button>
        </div>
      </div>
    </div>
  );
}
