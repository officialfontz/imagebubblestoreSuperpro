"use client";

// ── Delivery proof ────────────────────────────────────────────────────────────
// Self-contained on purpose. Proof shares nothing with the image library —
// no selection, no collections, no trash, no upload — so folding it into
// VaultApp's state would have doubled the conditionals in every handler there
// for no gain. VaultApp swaps this in the way it already swaps in the text
// tool, and this owns the rest.

import { useCallback, useMemo, useState } from "react";
import { PackageCheck, SearchX, Loader2, Users } from "lucide-react";
import type { VaultImage, VaultStaff, CopyFormat, CaptureCategory } from "@/lib/types";
import { CAPTURE_CATEGORIES, CATEGORY_LABEL } from "@/lib/types";
import type { VaultRole } from "@/lib/session";
import CaptureTile from "./CaptureTile";
import Viewer from "./Viewer";
import { dayLabel, shopDay } from "./ui";

type Props = {
  /** Already merged and de-duplicated by VaultApp: the open month, plus the
   *  whole retention window while a search is running. */
  captures: VaultImage[];
  searching: boolean;
  staff: VaultStaff[];
  role: VaultRole;
  /** null = everyone's proof; otherwise one person's. */
  filterStaffId: string | null;
  query: string;
  canResize: boolean;
  onCopy: (capture: VaultImage, format: CopyFormat, width?: number) => void;
  onRename: (capture: VaultImage) => void;
  onDelete: (capture: VaultImage) => void;
  onSetCategory: (capture: VaultImage, category: CaptureCategory) => void;
  onOpenStaff: () => void;
};

/** The filter bar's fourth option: captures from before the field existed. */
type CategoryFilter = CaptureCategory | "all" | "none";

export default function CapturesView({
  captures, searching, staff, role, filterStaffId, query,
  canResize, onCopy, onRename, onDelete, onSetCategory, onOpenStaff,
}: Props) {
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [category, setCategory] = useState<CategoryFilter>("all");

  const staffById = useMemo(() => new Map(staff.map((s) => [s.id, s])), [staff]);
  const q = query.trim().toLowerCase();

  // Counted before the category filter is applied, so the bar always shows
  // how many of each kind there are rather than going blank for the others.
  const byStaff = useMemo(
    () => captures.filter((c) => !filterStaffId || c.uploader === filterStaffId),
    [captures, filterStaffId],
  );
  const counts = useMemo(() => {
    const out: Record<CategoryFilter, number> = { all: byStaff.length, gamepass: 0, robux: 0, farm: 0, none: 0 };
    for (const c of byStaff) out[c.category ?? "none"]++;
    return out;
  }, [byStaff]);

  const visible = useMemo(() => {
    const list = captures.filter((c) => {
      if (filterStaffId && c.uploader !== filterStaffId) return false;
      if (category !== "all" && (c.category ?? "none") !== category) return false;
      if (!q) return true;
      const who = c.uploader ? staffById.get(c.uploader)?.name ?? "" : "";
      return (c.customer ?? c.name).toLowerCase().includes(q) || who.toLowerCase().includes(q);
    });
    return list.sort((a, b) => (b.capturedAt ?? b.createdAt) - (a.capturedAt ?? a.createdAt));
  }, [captures, filterStaffId, category, q, staffById]);

  // Grouped by day, because that is how anyone actually looks for proof: "the
  // one from Tuesday evening", not "the four hundredth item".
  const days = useMemo(() => {
    const out: { day: string; items: VaultImage[] }[] = [];
    for (const c of visible) {
      const day = shopDay(c.capturedAt ?? c.createdAt);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(c);
      else out.push({ day, items: [c] });
    }
    return out;
  }, [visible]);

  const viewerIndex = viewerId ? visible.findIndex((c) => c.id === viewerId) : -1;
  const viewerCapture = viewerIndex >= 0 ? visible[viewerIndex] : null;
  const viewerStaff = viewerCapture?.uploader ? staffById.get(viewerCapture.uploader) : undefined;

  const stepViewer = useCallback((delta: number) => {
    setViewerId(visible[viewerIndex + delta]?.id ?? null);
  }, [visible, viewerIndex]);

  const bar = byStaff.length > 0 && (
    <div className="catbar" role="group" aria-label="กรองตามหมวด">
      {(["all", ...CAPTURE_CATEGORIES, ...(counts.none ? ["none" as const] : [])] as CategoryFilter[]).map((key) => (
        <button
          key={key}
          type="button"
          data-on={category === key}
          data-cat={key}
          onClick={() => setCategory(key)}
        >
          {key === "all" ? "ทั้งหมด" : key === "none" ? "ไม่ระบุ" : CATEGORY_LABEL[key]}
          <small className="tnum">{counts[key]}</small>
        </button>
      ))}
    </div>
  );

  if (visible.length === 0) {
    return (
      <>
      {bar}
      <div className="empty">
        <span className="empty-orb">
          {q ? <SearchX size={30} /> : <PackageCheck size={30} />}
        </span>
        <h2>
          {q ? "ไม่พบหลักฐานที่ค้นหา"
            : category !== "all" ? "ไม่มีหลักฐานในหมวดนี้"
            : staff.length === 0 ? "ยังไม่มีทีมงาน"
            : "ยังไม่มีหลักฐานในเดือนนี้"}
        </h2>
        <p>
          {q ? (searching ? "กำลังค้นย้อนหลัง…" : "ค้นย้อนหลังได้ 90 วัน ลองเปลี่ยนคำค้นดู")
            : staff.length === 0
              ? "เพิ่มทีมงานแล้วส่งรหัสจับคู่ให้ เพื่อเริ่มส่งหลักฐานจากโปรแกรม Bubble Capture"
              : "หลักฐานจะขึ้นที่นี่เองทันทีที่ทีมงานกดส่งจากโปรแกรม"}
        </p>
        {staff.length === 0 && role === "owner" && !q && (
          <button type="button" className="btn btn--primary" style={{ marginTop: 12 }} onClick={onOpenStaff}>
            <Users size={15} /> เพิ่มทีมงาน
          </button>
        )}
      </div>
      </>
    );
  }

  return (
    <>
      {bar}
      {q && searching && (
        <div className="v-note">
          <Loader2 size={14} className="spin" />
          <span>กำลังค้นย้อนหลัง 90 วัน…</span>
        </div>
      )}

      {days.map(({ day, items }) => (
        <section key={day} style={{ marginBottom: 22 }}>
          <div className="day-label">
            {dayLabel(day)}
            <small className="tnum">{items.length} รูป</small>
          </div>
          <div className="grid">
            {items.map((capture) => (
              <CaptureTile
                key={capture.id}
                capture={capture}
                staff={capture.uploader ? staffById.get(capture.uploader) : undefined}
                canResize={canResize}
                onOpen={() => setViewerId(capture.id)}
              />
            ))}
          </div>
        </section>
      ))}

      {viewerCapture && (
        <Viewer
          image={viewerCapture}
          albums={[]}
          capture={{
            staffName: viewerStaff?.name ?? "ไม่ทราบผู้ส่ง",
            staffEmoji: viewerStaff?.emoji ?? "❓",
            deviceName: viewerStaff?.deviceName,
            canEdit: role === "owner",
            onSetCategory: (next) => onSetCategory(viewerCapture, next),
          }}
          hasPrev={viewerIndex > 0}
          hasNext={viewerIndex < visible.length - 1}
          onPrev={() => stepViewer(-1)}
          onNext={() => stepViewer(1)}
          onClose={() => setViewerId(null)}
          onCopy={(format, width) => onCopy(viewerCapture, format, width)}
          canResize={canResize}
          onRename={() => onRename(viewerCapture)}
          onDelete={() => { onDelete(viewerCapture); setViewerId(null); }}
          onPickAlbum={() => undefined}
        />
      )}
    </>
  );
}
