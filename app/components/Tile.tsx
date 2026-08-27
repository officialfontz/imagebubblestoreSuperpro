"use client";

// ── One image tile ────────────────────────────────────────────────────────────

import { Copy, Check, Maximize2, MoreHorizontal } from "lucide-react";
import type { VaultImage } from "@/lib/types";
import { formatBytes } from "./ui";

type Props = {
  image: VaultImage;
  selected: boolean;
  index: number;
  onCopy: () => void;
  onToggle: () => void;
  onOpen: () => void;
  onMenu: (e: React.MouseEvent) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  dragging: boolean;
  /** Off while the grid is virtualised — tiles re-mount as you scroll, and
   *  replaying the entrance animation each time reads as flicker. */
  animate: boolean;
};

export default function Tile({
  image, selected, index, onCopy, onToggle, onOpen, onMenu, onDragStart, onDragEnd, dragging, animate,
}: Props) {
  return (
    <figure
      className="tile"
      data-sel={selected}
      data-dragging={dragging}
      // Staggered entrance, capped so a 300-image album does not spend nine
      // seconds animating in.
      style={animate ? { animationDelay: `${Math.min(index, 14) * 22}ms` } : { animation: "none" }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", image.url);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onContextMenu={onMenu}
    >
      <button
        type="button"
        className="tile-check"
        data-on={selected}
        aria-label={selected ? `เอา ${image.name} ออกจากที่เลือก` : `เลือก ${image.name}`}
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
      >
        {selected && <Check size={12} color="#fff" strokeWidth={3} />}
      </button>

      {/* The image itself is the copy button — that is the one thing this app
          exists to do, so it gets the largest possible hit target. */}
      <div
        className="tile-img"
        role="button"
        tabIndex={0}
        aria-label={`คัดลอกลิงก์ของ ${image.name}`}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) { onToggle(); return; }
          onCopy();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onCopy(); }
        }}
      >
        {/* Plain <img>: already-optimised WebP straight off a CDN, so Next's
            optimizer would only add a proxy hop and RAM. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image.url}
          alt={image.name}
          loading="lazy"
          decoding="async"
          draggable={false}
          // A cached image can finish before React attaches onLoad, so the ref
          // settles the flag for that case too.
          ref={(el) => { if (el?.complete) el.dataset.loaded = "true"; }}
          onLoad={(e) => { e.currentTarget.dataset.loaded = "true"; }}
          style={image.blur ? { backgroundImage: `url(${image.blur})`, backgroundSize: "cover" } : undefined}
        />

        <div className="tile-veil">
          <span className="tile-cta"><Copy size={13} /><span className="tile-cta-label">คัดลอกลิงก์</span></span>
          <button
            type="button"
            className="tile-mini"
            aria-label={`เปิดดู ${image.name}`}
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
          >
            <Maximize2 size={14} />
          </button>
          <button
            type="button"
            className="tile-mini"
            aria-label={`เมนูของ ${image.name}`}
            onClick={onMenu}
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      </div>

      <figcaption className="tile-meta">
        <div className="tile-name" title={image.name}>{image.name}</div>
        <div className="tile-sub tnum">
          {image.width && image.height ? `${image.width}×${image.height} · ` : ""}
          {formatBytes(image.bytes)}
        </div>
      </figcaption>
    </figure>
  );
}
