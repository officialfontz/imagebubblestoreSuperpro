"use client";

// ── Bubble Vault ──────────────────────────────────────────────────────────────
// Drop images in, get permanent CDN links out. Everything the user embeds points
// at R2, so the images keep serving no matter what this container is doing.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Upload, Search, X, Copy, Trash2, Pencil, FolderInput, ExternalLink,
  ArrowUpDown, LayoutGrid, Grid2x2, Check, ImageOff, Sparkles, Inbox,
} from "lucide-react";
import type { VaultData, VaultImage, VaultAlbum, CopyFormat } from "@/lib/types";
import { formatLink } from "@/lib/types";
import {
  uploadToVault, deleteVaultImages, renameVaultImage, moveVaultImages,
  createVaultAlbum, updateVaultAlbum, deleteVaultAlbum,
} from "@/lib/actions";
import Rail, { ALL, UNFILED } from "./Rail";
import Tile from "./Tile";
import Viewer from "./Viewer";
import Tray, { type UploadJob } from "./Tray";
import {
  Menu, MenuItem, PromptModal, ConfirmModal, ToastStack, copyText,
  type Toast, type PromptSpec, type ConfirmSpec, type MenuAnchor,
} from "./ui";

type Props = {
  initialData: VaultData;
  storage: { driver: string; publicBase: string; missing: string[] };
};

type Sort = "new" | "old" | "name" | "size";

const SORTS: { key: Sort; label: string }[] = [
  { key: "new",  label: "ใหม่สุดก่อน" },
  { key: "old",  label: "เก่าสุดก่อน" },
  { key: "name", label: "ชื่อ ก–ฮ" },
  { key: "size", label: "ไฟล์ใหญ่สุดก่อน" },
];

const COPY_FORMATS: { format: CopyFormat; label: string }[] = [
  { format: "direct",   label: "ลิงก์ตรง (URL)" },
  { format: "markdown", label: "Markdown" },
  { format: "html",     label: "HTML <img>" },
  { format: "bbcode",   label: "BBCode" },
];

/** Two in flight: enough to keep the pipe busy, few enough that a handful of
 *  12 MB files never sit in the container's heap at the same time. */
const CONCURRENCY = 2;

type MenuState =
  | { kind: "tile"; anchor: MenuAnchor; image: VaultImage }
  | { kind: "bulk"; anchor: MenuAnchor }
  | { kind: "move"; anchor: MenuAnchor; ids: string[] }
  | { kind: "sort"; anchor: MenuAnchor }
  | { kind: "album"; anchor: MenuAnchor; album: VaultAlbum };

export default function VaultApp({ initialData, storage }: Props) {
  const [albums, setAlbums] = useState<VaultAlbum[]>(initialData.albums);
  const [images, setImages] = useState<VaultImage[]>(initialData.images);
  const [active, setActive] = useState<string>(ALL);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("new");
  const [dense, setDense] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dragFiles, setDragFiles] = useState(false);
  const [dragTiles, setDragTiles] = useState<string[] | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<PromptSpec | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const toastId = useRef(0);
  const dragDepth = useRef(0);

  // ── Toasts ──────────────────────────────────────────────────────────────────
  const say = useCallback((text: string, kind: "ok" | "error" = "ok") => {
    const id = ++toastId.current;
    setToasts((prev) => [...prev.slice(-2), { id, text, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), kind === "error" ? 4500 : 2000);
  }, []);

  // ── Derived ─────────────────────────────────────────────────────────────────
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = images.filter((img) => {
      if (active === UNFILED && img.albumId !== null) return false;
      if (active !== ALL && active !== UNFILED && img.albumId !== active) return false;
      if (q && !img.name.toLowerCase().includes(q)) return false;
      return true;
    });
    const sorted = [...list];
    if (sort === "new")  sorted.sort((a, b) => b.createdAt - a.createdAt);
    if (sort === "old")  sorted.sort((a, b) => a.createdAt - b.createdAt);
    if (sort === "size") sorted.sort((a, b) => b.bytes - a.bytes);
    if (sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name, "th"));
    return sorted;
  }, [images, active, query, sort]);

  const counts = useMemo(() => {
    const byAlbum = new Map<string, number>();
    let unfiled = 0;
    for (const img of images) {
      if (img.albumId === null) unfiled++;
      else byAlbum.set(img.albumId, (byAlbum.get(img.albumId) ?? 0) + 1);
    }
    return { byAlbum, unfiled, all: images.length };
  }, [images]);

  const totalBytes = useMemo(() => images.reduce((sum, i) => sum + i.bytes, 0), [images]);

  // Scoped to what is on screen, not to the raw id set. Filtering or switching
  // collections can hide a selected tile, and a bulk action must never touch an
  // image the user can no longer see.
  const selectedImages = useMemo(() => visible.filter((i) => selected.has(i.id)), [visible, selected]);
  const selectedCount = selectedImages.length;

  const viewerIndex = viewerId ? visible.findIndex((i) => i.id === viewerId) : -1;
  const viewerImage = viewerIndex >= 0 ? visible[viewerIndex] : null;

  const title =
    active === ALL ? "รูปทั้งหมด"
    : active === UNFILED ? "ยังไม่จัดหมวด"
    : albums.find((a) => a.id === active)?.name ?? "รูปทั้งหมด";

  // ── Upload ──────────────────────────────────────────────────────────────────
  const targetAlbum = active === ALL || active === UNFILED ? null : active;
  // Read through a ref inside the queue runner, so files dropped just before a
  // collection switch still land where they were dropped.
  const targetAlbumRef = useRef(targetAlbum);
  targetAlbumRef.current = targetAlbum;

  const runUploads = useCallback(async (files: File[]) => {
    const accepted = files.filter((f) => f.type.startsWith("image/"));
    if (accepted.length === 0) {
      say("ไม่พบไฟล์รูปในสิ่งที่วาง", "error");
      return;
    }

    const batch: UploadJob[] = accepted.map((f, i) => ({
      id: `${Date.now()}-${i}-${f.name}`,
      name: f.name || "clipboard.png",
      status: "queued",
    }));
    // Drop already-settled jobs from a previous run so the tray shows this batch.
    setJobs((prev) => [...prev.filter((j) => j.status === "queued" || j.status === "running"), ...batch]);

    const albumId = targetAlbumRef.current;
    let cursor = 0;

    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= accepted.length) return;
        const job = batch[i];
        setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status: "running" } : j)));

        const fd = new FormData();
        fd.append("file", accepted[i]);
        if (albumId) fd.append("albumId", albumId);

        try {
          const res = await uploadToVault(fd);
          if (res.ok) {
            setImages((prev) => [res.image, ...prev]);
            setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status: "done" } : j)));
          } else {
            setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status: "error", error: res.error } : j)));
          }
        } catch (e) {
          // Framework-level failures never reach the action's own error path,
          // so log the real cause — the tray only has room for a short label.
          console.error("upload failed:", e);
          const msg = (e as Error).message?.includes("Body exceeded") ? "ไฟล์ใหญ่เกินไป" : "อัปโหลดไม่สำเร็จ";
          setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status: "error", error: msg } : j)));
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }, [say]);

  const pendingCount = jobs.filter((j) => j.status === "queued" || j.status === "running").length;

  // ── Drag files onto the window ──────────────────────────────────────────────
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const onEnter = (e: DragEvent) => { if (hasFiles(e)) { dragDepth.current++; setDragFiles(true); } };
    const onOver  = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    // dragenter/dragleave fire per element; a depth counter is the only reliable
    // way to tell that the pointer actually left the window.
    const onLeave = () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragFiles(false); };
    const onDrop  = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragFiles(false);
      void runUploads(Array.from(e.dataTransfer?.files ?? []));
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [runUploads]);

  // ── Paste ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest("input, textarea, [contenteditable]")) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      void runUploads(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [runUploads]);

  // ── Copy ────────────────────────────────────────────────────────────────────
  const copyOne = useCallback(async (img: VaultImage, format: CopyFormat = "direct") => {
    const ok = await copyText(formatLink(format, img.url, img.name));
    say(ok ? "คัดลอกลิงก์แล้ว" : "คัดลอกไม่สำเร็จ", ok ? "ok" : "error");
  }, [say]);

  const copyMany = useCallback(async (list: VaultImage[], format: CopyFormat) => {
    if (list.length === 0) return;
    const ok = await copyText(list.map((i) => formatLink(format, i.url, i.name)).join("\n"));
    say(ok ? `คัดลอก ${list.length} ลิงก์แล้ว` : "คัดลอกไม่สำเร็จ", ok ? "ok" : "error");
  }, [say]);

  // ── Mutations (optimistic, rolled back on failure) ──────────────────────────
  // Server actions throw on an expired session (and Next masks the reason in
  // production). Rather than let that surface as an unhandled rejection, every
  // mutation goes through here: report it, then reload — which lands on /login
  // if the session really is gone, and simply refreshes if it was a blip.
  const guard = useCallback(async <T,>(work: () => Promise<T>, rollback: () => void): Promise<T | null> => {
    try {
      return await work();
    } catch (e) {
      console.error("vault action failed:", e);
      rollback();
      say("เซสชันหมดอายุหรือเชื่อมต่อไม่ได้ — กำลังโหลดหน้าใหม่", "error");
      setTimeout(() => window.location.reload(), 1600);
      return null;
    }
  }, [say]);

  const doDelete = useCallback(async (ids: string[]) => {
    const snapshot = images;
    const idSet = new Set(ids);
    setImages((prev) => prev.filter((i) => !idSet.has(i.id)));
    setSelected(new Set());
    setViewerId(null);
    const res = await guard(() => deleteVaultImages(ids), () => setImages(snapshot));
    if (!res) return;
    if (!res.ok) { setImages(snapshot); say(res.error, "error"); }
    else say(`ลบแล้ว ${res.deleted} รูป`);
  }, [images, say, guard]);

  const doMove = useCallback(async (ids: string[], albumId: string | null) => {
    const snapshot = images;
    const idSet = new Set(ids);
    setImages((prev) => prev.map((i) => (idSet.has(i.id) ? { ...i, albumId } : i)));
    setSelected(new Set());
    const res = await guard(() => moveVaultImages(ids, albumId), () => setImages(snapshot));
    if (!res) return;
    if (!res.ok) { setImages(snapshot); say(res.error, "error"); return; }
    const name = albumId ? albums.find((a) => a.id === albumId)?.name ?? "คอลเลกชัน" : "ยังไม่จัดหมวด";
    say(`ย้าย ${ids.length} รูป → ${name}`);
  }, [images, albums, say, guard]);

  const doRename = useCallback(async (id: string, name: string) => {
    const snapshot = images;
    setImages((prev) => prev.map((i) => (i.id === id ? { ...i, name } : i)));
    const res = await guard(() => renameVaultImage(id, name), () => setImages(snapshot));
    if (res && !res.ok) { setImages(snapshot); say(res.error, "error"); }
  }, [images, say, guard]);

  const doCreateAlbum = useCallback(async (name: string, emoji: string) => {
    const res = await guard(() => createVaultAlbum(name, emoji), () => {});
    if (!res) return;
    if (!res.ok) { say(res.error, "error"); return; }
    setAlbums((prev) => [...prev, res.album]);
    setActive(res.album.id);
  }, [say, guard]);

  const doUpdateAlbum = useCallback(async (id: string, name: string, emoji: string) => {
    const snapshot = albums;
    setAlbums((prev) => prev.map((a) => (a.id === id ? { ...a, name, emoji } : a)));
    const res = await guard(() => updateVaultAlbum(id, name, emoji), () => setAlbums(snapshot));
    if (res && !res.ok) { setAlbums(snapshot); say(res.error, "error"); }
  }, [albums, say, guard]);

  const doDeleteAlbum = useCallback(async (album: VaultAlbum) => {
    const albumSnap = albums;
    const imageSnap = images;
    setAlbums((prev) => prev.filter((a) => a.id !== album.id));
    setImages((prev) => prev.map((i) => (i.albumId === album.id ? { ...i, albumId: null } : i)));
    setActive((cur) => (cur === album.id ? ALL : cur));
    const res = await guard(
      () => deleteVaultAlbum(album.id),
      () => { setAlbums(albumSnap); setImages(imageSnap); },
    );
    if (!res) return;
    if (!res.ok) { setAlbums(albumSnap); setImages(imageSnap); say(res.error, "error"); }
    else say(`ลบคอลเลกชัน "${album.name}" แล้ว — รูปยังอยู่ครบ`);
  }, [albums, images, say, guard]);

  // ── Selection ───────────────────────────────────────────────────────────────
  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const askDelete = useCallback((targets: VaultImage[]) => {
    setConfirm({
      title: targets.length > 1 ? `ลบ ${targets.length} รูป?` : `ลบ "${targets[0].name}"?`,
      body: "ลิงก์จะใช้ไม่ได้ทันทีและกู้คืนไม่ได้ — ถ้าเอาไปแปะไว้ที่เว็บอื่น รูปตรงนั้นจะหายไปด้วย",
      confirm: "ลบถาวร",
      onConfirm: () => void doDelete(targets.map((i) => i.id)),
    });
  }, [doDelete]);

  const askRename = useCallback((img: VaultImage) => {
    setPrompt({
      title: "เปลี่ยนชื่อรูป",
      value: img.name,
      confirm: "บันทึก",
      onConfirm: (name) => void doRename(img.id, name),
    });
  }, [doRename]);

  const askNewAlbum = useCallback(() => {
    setPrompt({
      title: "สร้างคอลเลกชันใหม่",
      value: "",
      emoji: "📁",
      placeholder: "เช่น แบนเนอร์โปรโมท",
      confirm: "สร้าง",
      onConfirm: (name, emoji) => void doCreateAlbum(name, emoji),
    });
  }, [doCreateAlbum]);

  const askRenameAlbum = useCallback((album: VaultAlbum) => {
    setPrompt({
      title: "แก้ไขคอลเลกชัน",
      value: album.name,
      emoji: album.emoji,
      confirm: "บันทึก",
      onConfirm: (name, emoji) => void doUpdateAlbum(album.id, name, emoji),
    });
  }, [doUpdateAlbum]);

  // ── Keyboard ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inField = Boolean((e.target as HTMLElement | null)?.closest("input, textarea, [contenteditable]"));

      if (e.key === "Escape" && !inField) {
        if (selectedCount) { setSelected(new Set()); return; }
        if (query) setQuery("");
        return;
      }
      if (inField || viewerId || prompt || confirm) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && visible.length) {
        e.preventDefault();
        setSelected(new Set(visible.map((i) => i.id)));
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedImages.length) {
        e.preventDefault();
        askDelete(selectedImages);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && selectedImages.length) {
        e.preventDefault();
        void copyMany(selectedImages, "direct");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedCount, selectedImages, visible, query, viewerId, prompt, confirm, askDelete, copyMany]);

  // ── Menu helpers ────────────────────────────────────────────────────────────
  const closeMenu = useCallback(() => setMenu(null), []);
  const openTileMenu = (e: React.MouseEvent, image: VaultImage) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ kind: "tile", anchor: { x: e.clientX, y: e.clientY }, image });
  };

  const menuTargets =
    menu?.kind === "tile" ? [menu.image]
    : menu?.kind === "bulk" ? selectedImages
    : [];

  const showSetup = () => setConfirm({
    title: "ต่อ Cloudflare R2",
    body: `เพิ่ม environment variable เหล่านี้ใน Railway แล้ว redeploy: ${storage.missing.join(", ")} — รูปที่อัปโหลดหลังจากนั้นจะขึ้น R2 ให้อัตโนมัติ ส่วนรูปเดิมยังใช้ลิงก์เดิมได้ตามปกติ ไม่พัง`,
    confirm: "เข้าใจแล้ว",
    tone: "info",
    onConfirm: () => {},
  });

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="shell">
      <Rail
        albums={albums}
        active={active}
        counts={counts}
        totalBytes={totalBytes}
        storage={storage}
        onSelect={(id) => { setActive(id); setSelected(new Set()); }}
        onUpload={() => fileInput.current?.click()}
        onNewAlbum={askNewAlbum}
        onEditAlbum={(album, e) => setMenu({ kind: "album", anchor: { x: e.clientX, y: e.clientY + 8 }, album })}
        onDropOnAlbum={(albumId) => { if (dragTiles) void doMove(dragTiles, albumId); setDragTiles(null); }}
        isDraggingTiles={dragTiles !== null}
        onShowSetup={showSetup}
      />

      <div className="main">
        <header className="bar">
          <div className="bar-title">
            <h1>{title}</h1>
            <span className="tnum">
              {visible.length} รูป
              {query && ` · ค้นหา “${query}”`}
            </span>
          </div>

          <div className="bar-spacer" />

          <label className="search">
            <Search size={15} color="var(--ink-4)" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ค้นหาชื่อรูป…"
              aria-label="ค้นหารูป"
            />
            {query && (
              <button type="button" onClick={() => setQuery("")} aria-label="ล้างคำค้น" style={{ display: "grid" }}>
                <X size={14} color="var(--ink-3)" />
              </button>
            )}
          </label>

          <button
            type="button"
            className="iconbtn"
            aria-label="เรียงลำดับ"
            title={SORTS.find((s) => s.key === sort)?.label}
            onClick={(e) => setMenu({ kind: "sort", anchor: { x: e.clientX, y: e.clientY + 12 } })}
          >
            <ArrowUpDown size={16} />
          </button>

          <div className="seg" role="group" aria-label="ขนาดตาราง">
            <button type="button" data-on={!dense} onClick={() => setDense(false)} aria-label="ตารางปกติ">
              <LayoutGrid size={15} />
            </button>
            <button type="button" data-on={dense} onClick={() => setDense(true)} aria-label="ตารางถี่">
              <Grid2x2 size={15} />
            </button>
          </div>

          <button type="button" className="btn btn--primary" onClick={() => fileInput.current?.click()}>
            <Upload size={15} strokeWidth={2.2} />
            อัปโหลด
          </button>
        </header>

        <div
          className="canvas"
          style={dense
            ? ({ "--tile": "132px", "--gap": "11px" } as React.CSSProperties)
            : undefined}
        >
          {visible.length === 0 && pendingCount === 0 ? (
            <div className="empty">
              <span className="empty-orb">
                {query ? <ImageOff size={30} /> : active === UNFILED ? <Inbox size={30} /> : <Sparkles size={30} />}
              </span>
              <h2>{query ? "ไม่พบรูปที่ค้นหา" : `${title} — ยังไม่มีรูป`}</h2>
              <p>
                {query
                  ? "ลองเปลี่ยนคำค้น หรือดูที่ “รูปทั้งหมด”"
                  : <>ลากไฟล์มาวางตรงไหนก็ได้ กด <span className="kbd">Ctrl</span><span className="kbd">V</span> วางจากคลิปบอร์ด หรือกดปุ่มอัปโหลดด้านบน</>}
              </p>
            </div>
          ) : (
            <div className="grid">
              {/* Skeletons stand in for files still encoding, so the grid never
                  looks empty while a big batch is uploading. */}
              {Array.from({ length: pendingCount }, (_, i) => (
                <figure className="tile tile--ghost" key={`ghost-${i}`}>
                  <div className="tile-img" />
                  <div className="tile-meta">
                    <div className="tile-name" style={{ color: "var(--ink-4)" }}>กำลังอัปโหลด…</div>
                    <div className="tile-sub">&nbsp;</div>
                  </div>
                </figure>
              ))}

              {visible.map((img, i) => (
                <Tile
                  key={img.id}
                  image={img}
                  index={i}
                  selected={selected.has(img.id)}
                  dragging={dragTiles?.includes(img.id) ?? false}
                  onCopy={() => void copyOne(img)}
                  onToggle={() => toggle(img.id)}
                  onOpen={() => setViewerId(img.id)}
                  onMenu={(e) => openTileMenu(e, img)}
                  onDragStart={() => setDragTiles(selected.has(img.id) ? [...selected] : [img.id])}
                  onDragEnd={() => setDragTiles(null)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple
        hidden
        onChange={(e) => { void runUploads(Array.from(e.target.files ?? [])); e.target.value = ""; }}
      />

      {/* ── Overlays ── */}
      {dragFiles && (
        <div className="dropzone">
          <div className="dropzone-card">
            <Upload size={34} color="var(--violet-hi)" />
            <strong>วางเพื่ออัปโหลด</strong>
            <span>เข้า “{title}”</span>
          </div>
        </div>
      )}

      {selectedCount > 0 && (
        <div className="bulk">
          <span className="bulk-count tnum">เลือก {selectedCount} รูป</span>
          <span className="bulk-sep" />
          <button type="button" className="btn btn--sm" onClick={() => void copyMany(selectedImages, "direct")}>
            <Copy size={13} /> คัดลอกลิงก์
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={(e) => setMenu({ kind: "move", anchor: { x: e.clientX - 100, y: e.clientY - 12 }, ids: selectedImages.map((i) => i.id) })}
          >
            <FolderInput size={13} /> ย้ายไป
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={(e) => setMenu({ kind: "bulk", anchor: { x: e.clientX - 100, y: e.clientY - 12 } })}
          >
            เพิ่มเติม
          </button>
          <button type="button" className="btn btn--sm btn--danger" onClick={() => askDelete(selectedImages)}>
            <Trash2 size={13} />
          </button>
          <button type="button" className="iconbtn" onClick={() => setSelected(new Set())} aria-label="ยกเลิกการเลือก">
            <X size={15} />
          </button>
        </div>
      )}

      <Tray jobs={jobs} onDismiss={() => setJobs([])} />
      <ToastStack toasts={toasts} raised={selectedCount > 0} />

      {menu?.kind === "album" && (
        <Menu anchor={menu.anchor} onClose={closeMenu}>
          <div className="menu-label">{menu.album.emoji} {menu.album.name}</div>
          <MenuItem
            icon={<Pencil size={14} />}
            label="เปลี่ยนชื่อ / อีโมจิ"
            onClick={() => { const album = menu.album; closeMenu(); askRenameAlbum(album); }}
          />
          <div className="menu-sep" />
          <MenuItem
            icon={<Trash2 size={14} />}
            label="ลบคอลเลกชัน"
            danger
            onClick={() => {
              const album = menu.album;
              closeMenu();
              setConfirm({
                title: `ลบคอลเลกชัน "${album.name}"?`,
                body: "รูปข้างในจะไม่ถูกลบ — จะย้ายไปอยู่ที่ “ยังไม่จัดหมวด” และลิงก์เดิมยังใช้ได้ตามปกติ",
                confirm: "ลบคอลเลกชัน",
                onConfirm: () => void doDeleteAlbum(album),
              });
            }}
          />
        </Menu>
      )}

      {menu?.kind === "sort" && (
        <Menu anchor={menu.anchor} onClose={closeMenu}>
          <div className="menu-label">เรียงลำดับ</div>
          {SORTS.map((s) => (
            <MenuItem
              key={s.key}
              icon={sort === s.key ? <Check size={14} color="var(--violet-hi)" /> : null}
              label={s.label}
              onClick={() => { setSort(s.key); closeMenu(); }}
            />
          ))}
        </Menu>
      )}

      {menu?.kind === "move" && (
        <Menu anchor={menu.anchor} onClose={closeMenu}>
          <div className="menu-label">ย้ายไปที่</div>
          <MenuItem
            icon={<Inbox size={14} />}
            label="ยังไม่จัดหมวด"
            onClick={() => { const ids = menu.ids; closeMenu(); void doMove(ids, null); }}
          />
          {albums.map((a) => (
            <MenuItem
              key={a.id}
              icon={<span aria-hidden>{a.emoji}</span>}
              label={a.name}
              onClick={() => { const ids = menu.ids; closeMenu(); void doMove(ids, a.id); }}
            />
          ))}
          {albums.length === 0 && (
            <MenuItem icon={<FolderInput size={14} />} label="สร้างคอลเลกชันใหม่…" onClick={() => { closeMenu(); askNewAlbum(); }} />
          )}
        </Menu>
      )}

      {(menu?.kind === "tile" || menu?.kind === "bulk") && menuTargets.length > 0 && (
        <Menu anchor={menu.anchor} onClose={closeMenu}>
          <div className="menu-label">
            {menuTargets.length > 1 ? `คัดลอก ${menuTargets.length} รูปเป็น` : "คัดลอกเป็น"}
          </div>
          {COPY_FORMATS.map(({ format, label }) => (
            <MenuItem
              key={format}
              icon={<Copy size={14} />}
              label={label}
              onClick={() => {
                const targets = menuTargets;
                closeMenu();
                void (targets.length > 1 ? copyMany(targets, format) : copyOne(targets[0], format));
              }}
            />
          ))}

          <div className="menu-sep" />

          {menuTargets.length === 1 && (
            <>
              <MenuItem
                icon={<ExternalLink size={14} />}
                label="เปิดในแท็บใหม่"
                onClick={() => { const url = menuTargets[0].url; closeMenu(); window.open(url, "_blank", "noopener,noreferrer"); }}
              />
              <MenuItem
                icon={<Pencil size={14} />}
                label="เปลี่ยนชื่อ"
                onClick={() => { const target = menuTargets[0]; closeMenu(); askRename(target); }}
              />
            </>
          )}

          <MenuItem
            icon={<FolderInput size={14} />}
            label="ย้ายไปคอลเลกชัน…"
            onClick={() => {
              const ids = menuTargets.map((i) => i.id);
              const anchor = menu.anchor;
              setMenu({ kind: "move", anchor, ids });
            }}
          />

          <div className="menu-sep" />

          <MenuItem
            icon={<Trash2 size={14} />}
            label={menuTargets.length > 1 ? `ลบ ${menuTargets.length} รูป` : "ลบรูปนี้"}
            danger
            onClick={() => { const targets = menuTargets; closeMenu(); askDelete(targets); }}
          />
        </Menu>
      )}

      {viewerImage && (
        <Viewer
          image={viewerImage}
          albums={albums}
          hasPrev={viewerIndex > 0}
          hasNext={viewerIndex < visible.length - 1}
          onPrev={() => setViewerId(visible[viewerIndex - 1].id)}
          onNext={() => setViewerId(visible[viewerIndex + 1].id)}
          onClose={() => setViewerId(null)}
          onCopy={(format) => void copyOne(viewerImage, format)}
          onRename={() => askRename(viewerImage)}
          onDelete={() => askDelete([viewerImage])}
          onPickAlbum={(e) => setMenu({ kind: "move", anchor: { x: e.clientX - 120, y: e.clientY + 10 }, ids: [viewerImage.id] })}
        />
      )}

      {prompt && <PromptModal spec={prompt} onClose={() => setPrompt(null)} />}
      {confirm && <ConfirmModal spec={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
