"use client";

// ── Delivery proof ────────────────────────────────────────────────────────────
// Self-contained on purpose. Proof shares nothing with the image library —
// no selection, no collections, no trash, no upload — so folding it into
// VaultApp's state would have doubled the conditionals in every handler there
// for no gain. VaultApp swaps this in the way it already swaps in the text
// tool, and this owns the rest.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PackageCheck, SearchX, Loader2, Users } from "lucide-react";
import type { VaultImage, VaultStaff, CopyFormat } from "@/lib/types";
import type { VaultRole } from "@/lib/session";
import { loadCaptures, searchCaptures } from "@/lib/capture-actions";
import CaptureTile from "./CaptureTile";
import Viewer from "./Viewer";
import { dayLabel, shopDay } from "./ui";

type Props = {
  captures: VaultImage[];
  staff: VaultStaff[];
  role: VaultRole;
  /** null = everyone's proof; otherwise one person's. */
  filterStaffId: string | null;
  query: string;
  month: string;
  currentMonth: string;
  canResize: boolean;
  onCopy: (capture: VaultImage, format: CopyFormat, width?: number) => void;
  onRename: (capture: VaultImage) => void;
  onDelete: (capture: VaultImage) => void;
  onRefresh: (captures: VaultImage[]) => void;
  onOpenStaff: () => void;
};

export default function CapturesView({
  captures, staff, role, filterStaffId, query, month, currentMonth,
  canResize, onCopy, onRename, onDelete, onRefresh, onOpenStaff,
}: Props) {
  const [viewerId, setViewerId] = useState<string | null>(null);
  // Search reaches back across the whole retention window; the month view does
  // not. Loaded on first use rather than up front, because most sessions never
  // search at all and the extra months are dead weight until they do.
  const [archive, setArchive] = useState<VaultImage[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchStarted = useRef(false);

  const staffById = useMemo(() => new Map(staff.map((s) => [s.id, s])), [staff]);
  const q = query.trim().toLowerCase();

  useEffect(() => {
    if (!q || searchStarted.current) return;
    // Guarded by a ref, not by state: setting state here to mark the fetch
    // in-flight would re-run the effect before the fetch resolved.
    searchStarted.current = true;
    let live = true;
    setSearching(true);
    void searchCaptures()
      .then((r) => { if (live) setArchive(r.captures); })
      .catch(() => { if (live) setArchive([]); })
      .finally(() => { if (live) setSearching(false); });
    return () => { live = false; };
  }, [q]);

  // A new capture can land while someone is looking at the page. Polling is the
  // honest tool here: there is no socket, and a stale grid on a shared screen is
  // exactly what would make someone think the app had stopped working.
  useEffect(() => {
    if (month !== currentMonth) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void loadCaptures(month).then((r) => onRefresh(r.captures)).catch(() => undefined);
    };
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [month, currentMonth, onRefresh]);

  const source = q && archive ? archive : captures;

  const visible = useMemo(() => {
    const list = source.filter((c) => {
      if (filterStaffId && c.uploader !== filterStaffId) return false;
      if (!q) return true;
      const who = c.uploader ? staffById.get(c.uploader)?.name ?? "" : "";
      return (c.customer ?? c.name).toLowerCase().includes(q) || who.toLowerCase().includes(q);
    });
    return list.sort((a, b) => (b.capturedAt ?? b.createdAt) - (a.capturedAt ?? a.createdAt));
  }, [source, filterStaffId, q, staffById]);

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

  if (visible.length === 0) {
    return (
      <div className="empty">
        <span className="empty-orb">
          {q ? <SearchX size={30} /> : <PackageCheck size={30} />}
        </span>
        <h2>
          {q ? "ไม่พบหลักฐานที่ค้นหา"
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
    );
  }

  return (
    <>
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
