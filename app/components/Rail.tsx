"use client";

// ── Sidebar: brand, upload, collections, storage ─────────────────────────────

import { useState } from "react";
import {
  Upload, Images, Inbox, Plus, Pencil, HardDrive, Cloud, Layers, LogOut, Trash2, Replace,
} from "lucide-react";
import type { VaultAlbum } from "@/lib/types";
import { signOut } from "@/lib/login-actions";
import { formatBytes } from "./ui";

export const ALL = "__all__";
export const UNFILED = "__unfiled__";
export const TRASH = "__trash__";
export const TEXT_TOOL = "__text__";

type Props = {
  albums: VaultAlbum[];
  active: string;
  counts: { all: number; unfiled: number; trash: number; byAlbum: Map<string, number> };
  totalBytes: number;
  storage: { driver: string; publicBase: string; missing: string[] };
  onSelect: (id: string) => void;
  onUpload: () => void;
  onNewAlbum: () => void;
  onEditAlbum: (album: VaultAlbum, e: React.MouseEvent) => void;
  /** Fires when tiles are dragged onto a collection row. */
  onDropOnAlbum: (albumId: string | null) => void;
  isDraggingTiles: boolean;
  onShowSetup: () => void;
};

export default function Rail({
  albums, active, counts, totalBytes, storage,
  onSelect, onUpload, onNewAlbum, onEditAlbum, onDropOnAlbum, isDraggingTiles, onShowSetup,
}: Props) {
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const onR2 = storage.driver === "r2";

  // R2's free tier covers 10 GB of storage. It is not a hard cap — past it the
  // charge is a couple of cents per GB — but it is the only number here that
  // can actually turn into a bill, so it is the only one worth metering.
  // Egress has no quota at all, which is why there is no bandwidth gauge.
  const FREE_STORAGE_BYTES = 10 * 1024 ** 3;
  const freeTierPct = Math.min(100, (totalBytes / FREE_STORAGE_BYTES) * 100);

  // Only collections accept a drop, and only while tiles are actually in flight.
  const dropProps = (id: string, albumId: string | null) =>
    isDraggingTiles
      ? {
          onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDropTarget(id); },
          onDragLeave: () => setDropTarget((cur) => (cur === id ? null : cur)),
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            setDropTarget(null);
            onDropOnAlbum(albumId);
          },
          "data-drop": dropTarget === id,
        }
      : {};

  return (
    <aside className="rail">
      <div className="rail-head">
        <div className="brand">
          <span className="brand-mark"><Layers size={17} strokeWidth={2.2} /></span>
          <span className="brand-text">
            <span className="brand-name">Bubble Vault</span>
            <span className="brand-sub">คลังรูปส่วนตัว</span>
          </span>
        </div>
        <button type="button" className="btn btn--primary btn--block" onClick={onUpload}>
          <Upload size={15} strokeWidth={2.2} />
          อัปโหลดรูป
        </button>
      </div>

      <nav className="rail-scroll">
        <button
          type="button"
          className="nav-item"
          data-active={active === ALL}
          onClick={() => onSelect(ALL)}
        >
          <span className="nav-icon"><Images size={16} /></span>
          <span className="nav-name">รูปทั้งหมด</span>
          <span className="nav-count tnum">{counts.all}</span>
        </button>

        <button
          type="button"
          className="nav-item"
          data-active={active === UNFILED}
          onClick={() => onSelect(UNFILED)}
          {...dropProps(UNFILED, null)}
        >
          <span className="nav-icon"><Inbox size={16} /></span>
          <span className="nav-name">ยังไม่จัดหมวด</span>
          <span className="nav-count tnum">{counts.unfiled}</span>
        </button>

        {counts.trash > 0 && (
          <button
            type="button"
            className="nav-item"
            data-active={active === TRASH}
            onClick={() => onSelect(TRASH)}
          >
            <span className="nav-icon"><Trash2 size={16} /></span>
            <span className="nav-name">ถังขยะ</span>
            <span className="nav-count tnum">{counts.trash}</span>
          </button>
        )}

        <div className="nav-label">
          คอลเลกชัน
          <button type="button" onClick={onNewAlbum} aria-label="สร้างคอลเลกชันใหม่">
            <Plus size={14} />
          </button>
        </div>

        {albums.length === 0 ? (
          <button type="button" className="nav-item" onClick={onNewAlbum}>
            <span className="nav-icon"><Plus size={16} /></span>
            <span className="nav-name">สร้างคอลเลกชันแรก</span>
          </button>
        ) : (
          albums.map((album) => (
            <button
              key={album.id}
              type="button"
              className="nav-item"
              data-active={active === album.id}
              onClick={() => onSelect(album.id)}
              {...dropProps(album.id, album.id)}
            >
              <span className="nav-icon" aria-hidden>{album.emoji}</span>
              <span className="nav-name">{album.name}</span>
              <span className="nav-count tnum">{counts.byAlbum.get(album.id) ?? 0}</span>
              <span
                className="nav-edit"
                role="button"
                tabIndex={0}
                aria-label={`ตัวเลือกของ ${album.name}`}
                onClick={(e) => { e.stopPropagation(); onEditAlbum(album, e); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onEditAlbum(album, e as unknown as React.MouseEvent); } }}
              >
                <Pencil size={12} />
              </span>
            </button>
          ))
        )}
      </nav>

      <nav className="rail-tools">
        <div className="nav-label">เครื่องมือ</div>
        <button
          type="button"
          className="nav-item"
          data-active={active === TEXT_TOOL}
          onClick={() => onSelect(TEXT_TOOL)}
        >
          <span className="nav-icon"><Replace size={16} /></span>
          <span className="nav-name">ค้นหา &amp; แทนที่</span>
        </button>
      </nav>

      <div className="rail-foot">
        <div className="storage">
          <div className="storage-top">
            {onR2 ? <Cloud size={14} color="var(--ok)" /> : <HardDrive size={14} color="var(--warn)" />}
            <span className="storage-title">พื้นที่เก็บ</span>
            <span className={`chip ${onR2 ? "chip--live" : "chip--local"}`}>
              <span className="chip-dot" />
              {onR2 ? "R2 CDN" : "ดิสก์"}
            </span>
          </div>
          <div className="storage-stats">
            <div><b className="tnum">{counts.all}</b>รูป</div>
            <div><b className="tnum">{formatBytes(totalBytes)}</b>ใช้ไป</div>
          </div>

          {onR2 && (
            <div className="quota" title={`${formatBytes(totalBytes)} จาก 10 GB ที่ใช้ได้ฟรี`}>
              <div className="quota-track">
                {/* Always paint at least a hairline: a bar that reads as empty
                    at 0.02% looks broken rather than reassuring. */}
                <span style={{ width: `${Math.max(freeTierPct, 0.8)}%` }} />
              </div>
              <div className="quota-legend">
                <span>{freeTierPct < 0.1 ? "< 0.1" : freeTierPct.toFixed(1)}% ของ 10 GB ฟรี</span>
                <span>แบนด์วิดท์ไม่จำกัด</span>
              </div>
            </div>
          )}
          {!onR2 && (
            <p className="storage-hint">
              ยังเก็บบนดิสก์เซิร์ฟเวอร์ ต่อ Cloudflare R2 แล้วรูปจะวิ่งผ่าน CDN ฟรี ไม่กิน bandwidth{" "}
              <button type="button" onClick={onShowSetup}>ดูวิธีตั้งค่า</button>
            </p>
          )}
        </div>

        <form action={signOut}>
          <button type="submit" className="btn btn--ghost btn--block signout">
            <LogOut size={14} />
            ออกจากระบบ
          </button>
        </form>
      </div>
    </aside>
  );
}
