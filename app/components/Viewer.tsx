"use client";

// ── Viewer: full preview + inspector ─────────────────────────────────────────
// Doubles as the detail panel, so the app never needs a third column.

import { useEffect } from "react";
import {
  X, ChevronLeft, ChevronRight, Copy, Pencil, Trash2, ExternalLink, FolderInput, Check, Clock,
} from "lucide-react";
import type { VaultImage, VaultAlbum, CopyFormat } from "@/lib/types";
import { formatLink, resizedUrl, RESIZE_WIDTHS } from "@/lib/types";
import { CAPTURE_RETENTION_DAYS } from "@/lib/types";
import { daysLeft, formatBytes, timeAgo } from "./ui";

const BANGKOK_STAMP = new Intl.DateTimeFormat("th-TH", {
  timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short",
});

const LINKS: { format: CopyFormat; kind: string }[] = [
  { format: "direct",   kind: "ลิงก์ตรง" },
  { format: "markdown", kind: "Markdown" },
  { format: "html",     kind: "HTML" },
  { format: "bbcode",   kind: "BBCode" },
];

type Props = {
  image: VaultImage;
  albums: VaultAlbum[];
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onCopy: (format: CopyFormat, width?: number) => void;
  /** Cloudflare edge resizing is available for this bucket. */
  canResize: boolean;
  onRename: () => void;
  onDelete: () => void;
  onPickAlbum: (e: React.MouseEvent) => void;
  /**
   * Set when the image is delivery proof rather than a library image. Proof has
   * no collection, no resize, and its heading is the customer it belongs to.
   */
  capture?: {
    staffName: string;
    staffEmoji: string;
    deviceName?: string;
    /** Read-only staff sessions get the same panel without the edit controls. */
    canEdit: boolean;
  };
};

export default function Viewer({
  image, albums, hasPrev, hasNext, onPrev, onNext, onClose, onCopy, onRename, onDelete, onPickAlbum,
  canResize, capture,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && hasPrev) onPrev();
      if (e.key === "ArrowRight" && hasNext) onNext();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext, hasPrev, hasNext]);

  const album = albums.find((a) => a.id === image.albumId);
  const capturedAt = image.capturedAt ?? image.createdAt;
  const expiresInDays = capture ? daysLeft(capturedAt, CAPTURE_RETENTION_DAYS) : 0;

  return (
    <div className="viewer">
      <div className="viewer-stage">
        <button type="button" className="iconbtn viewer-close" onClick={onClose} aria-label="ปิด">
          <X size={18} />
        </button>

        {hasPrev && (
          <button type="button" className="viewer-nav" data-side="prev" onClick={onPrev} aria-label="รูปก่อนหน้า">
            <ChevronLeft size={20} />
          </button>
        )}

        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img key={image.id} src={image.url} alt={image.name} />

        {hasNext && (
          <button type="button" className="viewer-nav" data-side="next" onClick={onNext} aria-label="รูปถัดไป">
            <ChevronRight size={20} />
          </button>
        )}
      </div>

      <aside className="inspect">
        <div className="inspect-scroll">
          <h3>{capture ? image.customer ?? image.name : image.name}</h3>
          <p className="inspect-sub">
            {capture ? `ส่งเมื่อ${timeAgo(capturedAt)}` : `อัปโหลด${timeAgo(image.createdAt)}`}
          </p>

          <div className="sect">
            <span className="sect-label">คัดลอกลิงก์</span>
            {LINKS.map(({ format, kind }) => (
              <button
                type="button"
                className="linkrow"
                key={format}
                onClick={() => onCopy(format)}
                title={formatLink(format, image.url, image.name)}
              >
                <span className="linkrow-body">
                  <span className="linkrow-kind">{kind}</span>
                  <span className="linkrow-val mono">{formatLink(format, image.url, image.name)}</span>
                </span>
                <Copy size={14} color="var(--ink-3)" />
              </button>
            ))}
          </div>

          {canResize && !capture && (
            <div className="sect">
              <span className="sect-label">ลิงก์ย่อขนาด</span>
              {/* One stored original, any width on request — Cloudflare resizes
                  and re-encodes at the edge, so a thumbnail slot never has to
                  download the full-size file. */}
              {RESIZE_WIDTHS.map((w) => (
                <button
                  type="button"
                  className="linkrow"
                  key={w}
                  onClick={() => onCopy("direct", w)}
                  title={resizedUrl(image.url, w)}
                >
                  <span className="linkrow-body">
                    <span className="linkrow-kind">กว้าง {w}px · AVIF/WebP อัตโนมัติ</span>
                    <span className="linkrow-val mono">{resizedUrl(image.url, w)}</span>
                  </span>
                  <Copy size={14} color="var(--ink-3)" />
                </button>
              ))}
            </div>
          )}

          <div className="sect">
            <span className="sect-label">รายละเอียด</span>
            <dl className="facts">
              {capture && (
                <>
                  <div className="fact">
                    <dt>ผู้ส่ง</dt>
                    <dd><span aria-hidden>{capture.staffEmoji}</span> {capture.staffName}</dd>
                  </div>
                  <div className="fact">
                    <dt>ชื่อลูกค้า</dt>
                    <dd>{image.customer ?? "—"}</dd>
                  </div>
                  <div className="fact" style={{ gridColumn: "span 2" }}>
                    <dt>เวลาแคป</dt>
                    <dd className="tnum">{BANGKOK_STAMP.format(new Date(capturedAt))} น.</dd>
                  </div>
                  {capture.deviceName && (
                    <div className="fact" style={{ gridColumn: "span 2" }}>
                      <dt>เครื่อง</dt>
                      <dd>{capture.deviceName}</dd>
                    </div>
                  )}
                </>
              )}
              <div className="fact">
                <dt>ขนาดภาพ</dt>
                <dd className="tnum">{image.width && image.height ? `${image.width} × ${image.height}` : "—"}</dd>
              </div>
              <div className="fact">
                <dt>ไฟล์</dt>
                <dd className="tnum">{formatBytes(image.bytes)}</dd>
              </div>
              <div className="fact">
                <dt>ชนิด</dt>
                <dd>{image.mime.replace("image/", "").toUpperCase()}</dd>
              </div>
              <div className="fact">
                {capture ? (
                  <>
                    <dt>เก็บอีก</dt>
                    <dd style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <Clock size={13} color="var(--ink-3)" />
                      <span className="tnum">{expiresInDays} วัน</span>
                    </dd>
                  </>
                ) : (
                  <>
                    <dt>สถานะ</dt>
                    <dd style={{ color: "var(--ok)", display: "flex", alignItems: "center", gap: 5 }}>
                      <Check size={13} /> พร้อมใช้
                    </dd>
                  </>
                )}
              </div>
            </dl>
          </div>

          {!capture && (
            <div className="sect">
              <span className="sect-label">คอลเลกชัน</span>
              <button type="button" className="picker" onClick={onPickAlbum}>
                <span aria-hidden>{album ? album.emoji : "📥"}</span>
                <span className="picker-label">{album ? album.name : "ยังไม่จัดหมวด"}</span>
                <FolderInput size={14} color="var(--ink-3)" />
              </button>
            </div>
          )}

          <div className="sect">
            <span className="sect-label">การจัดการ</span>
            {(!capture || capture.canEdit) && (
              <>
                <button type="button" className="picker" onClick={onRename}>
                  <Pencil size={14} color="var(--ink-3)" />
                  <span className="picker-label">{capture ? "แก้ชื่อลูกค้า" : "เปลี่ยนชื่อ"}</span>
                </button>
                <div style={{ height: 6 }} />
              </>
            )}
            <a className="picker" href={image.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={14} color="var(--ink-3)" />
              <span className="picker-label">เปิดลิงก์ในแท็บใหม่</span>
            </a>
          </div>
        </div>

        <div className="inspect-foot">
          <button type="button" className="btn btn--primary" style={{ flex: 1 }} onClick={() => onCopy("direct")}>
            <Copy size={14} /> คัดลอกลิงก์
          </button>
          {(!capture || capture.canEdit) && (
            <button
              type="button"
              className="btn btn--danger"
              onClick={onDelete}
              aria-label={capture ? "ลบหลักฐานนี้" : "ลบรูปนี้"}
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}
