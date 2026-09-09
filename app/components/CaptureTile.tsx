"use client";

// ── One piece of delivery proof ──────────────────────────────────────────────
// Deliberately not the library Tile: that one carries selection, drag-to-file
// and a copy-link call to action, none of which apply here. Proof is looked at,
// not organised. Same visual classes so the two grids read as one product.

import { Maximize2 } from "lucide-react";
import type { VaultImage, VaultStaff } from "@/lib/types";
import { CATEGORY_LABEL } from "@/lib/types";
import { resizedUrl } from "@/lib/types";
import { clockTime } from "./ui";

type Props = {
  capture: VaultImage;
  staff: VaultStaff | undefined;
  /** Cloudflare edge resizing is available, so tiles can request a thumbnail
   *  instead of pulling the full-size original. */
  canResize: boolean;
  onOpen: () => void;
};

export default function CaptureTile({ capture, staff, canResize, onOpen }: Props) {
  const when = capture.capturedAt ?? capture.createdAt;

  return (
    <figure className="tile">
      <button
        type="button"
        className="tile-img"
        style={{ cursor: "zoom-in" }}
        onClick={onOpen}
        aria-label={`เปิดดูหลักฐานของ ${capture.customer ?? capture.name}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          // A tile never needs the full-size original. Where Cloudflare can
          // resize at the edge, ask for a thumbnail: a day of proof is dozens
          // of images, and at 200 KB each the difference is the whole page.
          src={canResize ? resizedUrl(capture.url, 400) : capture.url}
          alt={capture.customer ?? capture.name}
          loading="lazy"
          decoding="async"
          draggable={false}
          // A cached image can finish before React attaches onLoad, so the ref
          // settles the flag for that case too.
          ref={(el) => { if (el?.complete) el.dataset.loaded = "true"; }}
          onLoad={(e) => { e.currentTarget.dataset.loaded = "true"; }}
          style={capture.blur ? { backgroundImage: `url(${capture.blur})`, backgroundSize: "cover" } : undefined}
        />
        <div className="tile-veil">
          <span className="tile-mini" style={{ marginLeft: "auto" }}><Maximize2 size={14} /></span>
        </div>
      </button>

      <figcaption className="tile-meta">
        <div className="tile-name" title={capture.customer ?? capture.name}>
          {capture.customer ?? capture.name}
        </div>
        <div className="tile-sub cap-sub">
          <span className="chip chip--staff">
            <span aria-hidden>{staff?.emoji ?? "❓"}</span>
            {staff?.name ?? "ไม่ทราบผู้ส่ง"}
          </span>
          {capture.category && (
            <span className="chip chip--cat" data-cat={capture.category}>{CATEGORY_LABEL[capture.category]}</span>
          )}
          <span className="tnum">{clockTime(when)} น.</span>
        </div>
      </figcaption>
    </figure>
  );
}
