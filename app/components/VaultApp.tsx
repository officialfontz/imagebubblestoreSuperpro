"use client";

// ── Bubble Vault ──────────────────────────────────────────────────────────────
// Drop images in, get permanent CDN links out. Everything the user embeds points
// at R2, so the images keep serving no matter what this container is doing.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Upload, Search, X, Copy, Trash2, Pencil, FolderInput, ExternalLink,
  ArrowUpDown, LayoutGrid, Grid2x2, Check, ImageOff, Sparkles, Inbox, Shrink, Undo2, Plus,
  ImageDown, Minimize2, Calendar, Bell, BellOff,
} from "lucide-react";
import type { VaultData, VaultImage, VaultAlbum, VaultStaff, CopyFormat, CaptureCategory } from "@/lib/types";
import { formatLink, resizedUrl, RESIZE_WIDTHS } from "@/lib/types";
import type { StorageStatus } from "@/lib/storage";
import {
  uploadToVault, deleteVaultImages, restoreVaultImages, purgeVaultImages,
  renameVaultImage, moveVaultImages, applyResize,
  createVaultAlbum, updateVaultAlbum, deleteVaultAlbum,
} from "@/lib/actions";
import type { VaultRole } from "@/lib/session";
import { deleteCapture, loadCaptures, renameCapture, searchCaptures, setCaptureCategory } from "@/lib/capture-actions";
import { ping } from "@/lib/ping";
import Rail, { ALL, UNFILED, TRASH, TEXT_TOOL, CAPTURES, isCaptureView, captureStaffId } from "./Rail";
import CapturesView from "./CapturesView";
import StaffModal from "./StaffModal";
import TextTool from "./TextTool";
import ResizeDialog from "./ResizeDialog";
import Tile from "./Tile";
import Viewer from "./Viewer";
import Tray, { type UploadJob } from "./Tray";
import { useVirtualGrid } from "./useVirtualGrid";
import { useMarqueeSelect } from "./useMarqueeSelect";
import {
  Menu, MenuItem, PromptModal, ConfirmModal, ToastStack, copyText, formatBytes, monthKey, shopDay,
  type Toast, type PromptSpec, type ConfirmSpec, type MenuAnchor,
} from "./ui";

type Props = {
  initialData: VaultData;
  storage: StorageStatus;
  role: VaultRole;
  /** Current month's delivery proof, rendered on the first paint. */
  initialCaptures: VaultImage[];
  captureMonths: string[];
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

/** "2026-09" → "กันยายน 2026", for the month picker. */
function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("th-TH", {
    month: "long", year: "numeric", timeZone: "UTC",
  });
}

type MenuState =
  | { kind: "tile"; anchor: MenuAnchor; image: VaultImage }
  | { kind: "bulk"; anchor: MenuAnchor }
  | { kind: "move"; anchor: MenuAnchor; ids: string[] }
  | { kind: "sort"; anchor: MenuAnchor }
  | { kind: "album"; anchor: MenuAnchor; album: VaultAlbum }
  | { kind: "month"; anchor: MenuAnchor };

// The alerts switch lives in localStorage, read through useSyncExternalStore so
// the server renders "on", the client agrees on first paint, and a change in
// another tab of the same browser is picked up too.
const alertListeners = new Set<() => void>();
function readAlerts(): boolean {
  try { return localStorage.getItem("vault:alerts") !== "off"; } catch { return true; }
}
function subscribeAlerts(fn: () => void) {
  alertListeners.add(fn);
  window.addEventListener("storage", fn);
  return () => { alertListeners.delete(fn); window.removeEventListener("storage", fn); };
}

export default function VaultApp({ initialData, storage, role, initialCaptures, captureMonths }: Props) {
  const isOwner = role === "owner";
  const [albums, setAlbums] = useState<VaultAlbum[]>(initialData.albums);
  const [images, setImages] = useState<VaultImage[]>(initialData.images);
  const [staff, setStaff] = useState<VaultStaff[]>(initialData.staff);
  const [captures, setCaptures] = useState<VaultImage[]>(initialCaptures);
  // The whole retention window, fetched only when someone actually searches.
  const [archive, setArchive] = useState<VaultImage[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [captureMonth, setCaptureMonth] = useState(() => monthKey(Date.now()));
  const [staffOpen, setStaffOpen] = useState(false);
  // A read-only team session has no library to land on.
  const [active, setActive] = useState<string>(isOwner ? ALL : CAPTURES);
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
  const [resizing, setResizing] = useState<VaultImage | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const toastId = useRef(0);
  const dragDepth = useRef(0);

  // ── Toasts ──────────────────────────────────────────────────────────────────
  const say = useCallback((text: string, kind: "ok" | "error" = "ok", ms?: number) => {
    const id = ++toastId.current;
    setToasts((prev) => [...prev.slice(-2), { id, text, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), ms ?? (kind === "error" ? 4500 : 2000));
  }, []);

  // ── Arrivals ────────────────────────────────────────────────────────────────
  // Whether to say something when a capture lands. Stored per browser: the
  // shop's shared screen wants the ping, the owner's phone probably does not.
  const alerts = useSyncExternalStore(subscribeAlerts, readAlerts, () => true);
  const toggleAlerts = useCallback(() => {
    const next = !readAlerts();
    try { localStorage.setItem("vault:alerts", next ? "on" : "off"); } catch { /* private mode */ }
    alertListeners.forEach((fn) => fn());
    // Ask for browser notifications the moment someone turns alerts on — that
    // click is the user gesture the permission prompt needs.
    if (next && "Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }, []);

  /** Ids already on screen, so a refresh can tell what is actually new. */
  const seenCaptures = useRef<Set<string>>(new Set(initialCaptures.map((c) => c.id)));
  /** Arrivals nobody has looked at yet — shown on the tab title while hidden. */
  const unseen = useRef(0);

  const announce = useCallback((fresh: VaultImage[]) => {
    if (fresh.length === 0) return;
    const who = (c: VaultImage) => {
      const s = staff.find((m) => m.id === c.uploader);
      return s ? `${s.emoji} ${s.name}` : "ทีมงาน";
    };
    const first = fresh[0];
    const text = fresh.length === 1
      ? `${who(first)} ส่งหลักฐาน · ${first.customer ?? first.name}`
      : `หลักฐานใหม่ ${fresh.length} ใบ · ล่าสุด ${first.customer ?? first.name}`;
    say(text, "ok", 6000);
    ping();

    if (document.visibilityState !== "visible") {
      unseen.current += fresh.length;
      document.title = `(${unseen.current}) Bubble Vault`;
      if ("Notification" in window && Notification.permission === "granted") {
        try {
          const n = new Notification("Bubble Vault", { body: text, tag: "vault-capture" });
          n.onclick = () => { window.focus(); n.close(); };
        } catch { /* some browsers throw without a service worker */ }
      }
    }
  }, [staff, say]);

  // ── Derived ─────────────────────────────────────────────────────────────────
  const inTrash = active === TRASH;
  // The text tool takes over the main column; none of the image chrome applies.
  const inTextTool = active === TEXT_TOOL;
  // Delivery proof does the same, and additionally has its own search, its own
  // viewer and its own month.
  const inCaptures = isCaptureView(active);
  const captureStaff = captureStaffId(active);

  // Rows removed optimistically. A poll or a search landing before the server
  // has committed the delete would otherwise put them back on screen.
  const deletedCaptures = useRef<Set<string>>(new Set());

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (active === TEXT_TOOL || isCaptureView(active)) return [];
    const list = images.filter((img) => {
      // Binned images appear in exactly one place, and nowhere else.
      if (Boolean(img.deletedAt) !== (active === TRASH)) return false;
      if (active === UNFILED && img.albumId !== null) return false;
      if (active !== ALL && active !== UNFILED && active !== TRASH && img.albumId !== active) return false;
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

  // Only the rows near the viewport are mounted; the rest is empty padding.
  const win = useVirtualGrid({
    scrollRef: canvasRef,
    gridRef,
    count: visible.length,
    resetKey: dense,
  });

  // Changing what is on screen should start at the top — otherwise you land
  // halfway down a list you have never seen.
  const resetScroll = useCallback(() => {
    canvasRef.current?.scrollTo({ top: 0 });
  }, []);

  // ── Drag a box across empty space to select ────────────────────────────────
  // The ids covered mid-drag replace whatever the drag itself added, so shrinking
  // the box de-selects again; `base` is what was selected before the drag began.
  const marqueeBase = useRef<Set<string>>(new Set());

  const onMarquee = useCallback((ids: string[], additive: boolean) => {
    setSelected((prev) => {
      if (marqueeBase.current.size === 0 && additive) marqueeBase.current = new Set(prev);
      const next = additive ? new Set(marqueeBase.current) : new Set<string>();
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);

  const marquee = useMarqueeSelect({
    scrollRef: canvasRef,
    enabled: visible.length > 0,
    onSelect: onMarquee,
    onClear: useCallback(() => { marqueeBase.current = new Set(); setSelected(new Set()); }, []),
  });

  const counts = useMemo(() => {
    const byAlbum = new Map<string, number>();
    let unfiled = 0, all = 0, trash = 0;
    for (const img of images) {
      if (img.deletedAt) { trash++; continue; }
      all++;
      if (img.albumId === null) unfiled++;
      else byAlbum.set(img.albumId, (byAlbum.get(img.albumId) ?? 0) + 1);
    }
    return { byAlbum, unfiled, all, trash };
  }, [images]);

  // Binned images still occupy R2 until the trash is emptied, so they count.
  const totalBytes = useMemo(() => images.reduce((sum, i) => sum + i.bytes, 0), [images]);

  // Scoped to what is on screen, not to the raw id set. Filtering or switching
  // collections can hide a selected tile, and a bulk action must never touch an
  // image the user can no longer see.
  const selectedImages = useMemo(() => visible.filter((i) => selected.has(i.id)), [visible, selected]);
  const selectedCount = selectedImages.length;

  const viewerIndex = viewerId ? visible.findIndex((i) => i.id === viewerId) : -1;
  const viewerImage = viewerIndex >= 0 ? visible[viewerIndex] : null;

  const captureQuery = inCaptures ? query.trim() : "";

  /** The open month plus, while searching, everything inside retention. */
  const captureList = useMemo(() => {
    const merged = new Map<string, VaultImage>();
    for (const c of captures) merged.set(c.id, c);
    if (captureQuery && archive) for (const c of archive) merged.set(c.id, merged.get(c.id) ?? c);
    return [...merged.values()].filter((c) => !deletedCaptures.current.has(c.id));
  }, [captures, archive, captureQuery]);

  /** Newest createdAt this tab has seen for the open month — the delta cursor. */
  const newestSeen = useRef(Math.max(0, ...initialCaptures.map((c) => c.createdAt)));
  const captureCount = useRef(initialCaptures.length);

  const refreshCaptures = useCallback(async (month: string, full = false) => {
    const since = full ? undefined : newestSeen.current;
    const [current, wide] = await Promise.all([
      loadCaptures(month, since).catch(() => null),
      archive ? searchCaptures().then((r) => r.captures).catch(() => null) : Promise.resolve(null),
    ]);
    if (current) {
      const fresh = current.captures.filter((c) => !seenCaptures.current.has(c.id));
      for (const c of current.captures) {
        seenCaptures.current.add(c.id);
        newestSeen.current = Math.max(newestSeen.current, c.createdAt);
      }
      if (current.partial) {
        if (fresh.length) setCaptures((prev) => [...fresh, ...prev]);
        captureCount.current += fresh.length;
        // A delta cannot show a deletion or an edit made elsewhere; a count
        // that disagrees with the server's is the signal to load properly.
        if (captureCount.current !== current.total) void refreshCaptures(month, true);
      } else {
        setCaptures(current.captures);
        captureCount.current = current.captures.length;
      }
      if (alerts) announce(fresh);
    }
    if (wide) setArchive(wide);
  }, [archive, alerts, announce]);

  // Fetch the archive the first time a search runs, and refresh it whenever the
  // query changes afterwards — a snapshot taken once per session went stale the
  // moment anyone sent another capture.
  useEffect(() => {
    if (!captureQuery) return;
    let live = true;
    // Debounced, and the in-flight flag is set inside the timer rather than in
    // the effect body — setting state synchronously here would re-render on
    // every keystroke before the request had even started.
    const timer = setTimeout(() => {
      if (!live) return;
      setSearching(true);
      void searchCaptures()
        .then((r) => { if (live) setArchive(r.captures); })
        .catch(() => { if (live) setArchive((prev) => prev ?? []); })
        .finally(() => { if (live) setSearching(false); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [captureQuery]);

  // New captures land while someone is looking at the page. Polling is the
  // honest tool here: there is no socket, and a stale grid on a shared screen
  // is what makes people think the app has stopped working.
  //
  // It runs in every section, not only this one: the point of an alert is to
  // hear about a delivery while looking at something else. A hidden tab keeps
  // polling too, more slowly, so the title can carry the count.
  useEffect(() => {
    const tick = () => {
      // Recomputed per tick, not captured once: a screen left open across the
      // month boundary used to stop refreshing entirely.
      if (captureMonth !== monthKey(Date.now())) return;
      if (document.visibilityState !== "visible" && !alerts) return;
      void refreshCaptures(captureMonth);
    };
    const id = setInterval(tick, document.visibilityState === "visible" ? 20_000 : 60_000);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      unseen.current = 0;
      document.title = "Bubble Vault";
      tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [captureMonth, refreshCaptures, alerts]);

  /**
   * Sidebar counts: today's captures while the current month is open, and the
   * whole month's otherwise.
   *
   * Looking at August and seeing every counter read 0 under a header saying
   * "รูปวันนี้" was worse than useless — it read as "nobody sent anything".
   */
  const viewingCurrentMonth = captureMonth === monthKey(Date.now());

  const captureCounts = useMemo(() => {
    const byStaff: Record<string, number> = {};
    let total = 0;
    const today = shopDay(Date.now());
    for (const c of captureList) {
      if (viewingCurrentMonth && shopDay(c.capturedAt ?? c.createdAt) !== today) continue;
      total++;
      if (c.uploader) byStaff[c.uploader] = (byStaff[c.uploader] ?? 0) + 1;
    }
    return { total, byStaff };
  }, [captureList, viewingCurrentMonth]);

  const captureStaffMember = captureStaff ? staff.find((s) => s.id === captureStaff) : undefined;

  const title =
    active === ALL ? "รูปทั้งหมด"
    : active === UNFILED ? "ยังไม่จัดหมวด"
    : active === TRASH ? "ถังขยะ"
    : active === TEXT_TOOL ? "ค้นหา & แทนที่"
    : active === CAPTURES ? "หลักฐานส่งของ"
    : captureStaffMember ? `${captureStaffMember.emoji} ${captureStaffMember.name}`
    : captureStaff ? "หลักฐานส่งของ"
    : albums.find((a) => a.id === active)?.name ?? "รูปทั้งหมด";

  // ── Upload ──────────────────────────────────────────────────────────────────
  const targetAlbum = active === ALL || active === UNFILED || active === TRASH ? null : active;
  // Read through a ref inside the queue runner, so files dropped just before a
  // collection switch still land where they were dropped.
  const targetAlbumRef = useRef(targetAlbum);
  targetAlbumRef.current = targetAlbum;

  // Same trick for "may this session upload at all": the window listeners below
  // are registered once, and would otherwise close over a stale view.
  const uploadableRef = useRef(true);
  uploadableRef.current = isOwner && !inCaptures && !inTextTool;

  const runUploads = useCallback(async (files: File[]) => {
    if (!uploadableRef.current) return;
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

    const onEnter = (e: DragEvent) => { if (hasFiles(e) && uploadableRef.current) { dragDepth.current++; setDragFiles(true); } };
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
  /** `width` routes the URL through Cloudflare's edge resizer; omit for the original. */
  const linkFor = useCallback(
    (img: VaultImage, format: CopyFormat, width?: number) =>
      formatLink(format, width ? resizedUrl(img.url, width) : img.url, img.name),
    [],
  );

  const copyOne = useCallback(async (img: VaultImage, format: CopyFormat = "direct", width?: number) => {
    const ok = await copyText(linkFor(img, format, width));
    say(
      ok ? (width ? `คัดลอกลิงก์ ${width}px แล้ว` : "คัดลอกลิงก์แล้ว") : "คัดลอกไม่สำเร็จ",
      ok ? "ok" : "error",
    );
  }, [say, linkFor]);

  /**
   * Puts the picture on the clipboard, not its address — for pasting straight
   * into a chat or a document. The ClipboardItem is handed a *promise* rather
   * than an awaited blob on purpose: Safari drops the user-activation the
   * moment you await before constructing it, and the write is then refused.
   */
  const copyImage = useCallback(async (img: VaultImage) => {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
      say("เบราว์เซอร์นี้คัดลอกรูปไม่ได้ — ใช้คัดลอกลิงก์แทน", "error");
      return;
    }
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "image/png": fetch(`/api/png/${img.id}`).then((r) => {
            if (!r.ok) throw new Error(String(r.status));
            return r.blob();
          }),
        }),
      ]);
      say("คัดลอกรูปแล้ว — วางในแชทหรือเอกสารได้เลย");
    } catch (e) {
      console.error("copy image failed:", e);
      say("คัดลอกรูปไม่สำเร็จ", "error");
    }
  }, [say]);

  const copyMany = useCallback(async (list: VaultImage[], format: CopyFormat, width?: number) => {
    if (list.length === 0) return;
    const ok = await copyText(list.map((i) => linkFor(i, format, width)).join("\n"));
    say(ok ? `คัดลอก ${list.length} ลิงก์แล้ว` : "คัดลอกไม่สำเร็จ", ok ? "ok" : "error");
  }, [say, linkFor]);

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
    const now = Date.now();
    setImages((prev) => prev.map((i) => (idSet.has(i.id) ? { ...i, deletedAt: now } : i)));
    setSelected(new Set());
    setViewerId(null);
    const res = await guard(() => deleteVaultImages(ids), () => setImages(snapshot));
    if (!res) return;
    if (!res.ok) { setImages(snapshot); say(res.error, "error"); }
    else say(`ย้าย ${res.deleted} รูปไปถังขยะ`);
  }, [images, say, guard]);

  const doRestore = useCallback(async (ids: string[]) => {
    const snapshot = images;
    const idSet = new Set(ids);
    setImages((prev) => prev.map((i) => {
      if (!idSet.has(i.id)) return i;
      const { deletedAt: _dropped, ...rest } = i;
      return rest;
    }));
    setSelected(new Set());
    setViewerId(null);
    const res = await guard(() => restoreVaultImages(ids), () => setImages(snapshot));
    if (!res) return;
    if (!res.ok) { setImages(snapshot); say(res.error, "error"); }
    else say(`กู้คืน ${res.restored} รูปแล้ว`);
  }, [images, say, guard]);

  const doPurge = useCallback(async (ids: string[]) => {
    const snapshot = images;
    const idSet = new Set(ids);
    setImages((prev) => prev.filter((i) => !idSet.has(i.id)));
    setSelected(new Set());
    setViewerId(null);
    const res = await guard(() => purgeVaultImages(ids), () => setImages(snapshot));
    if (!res) return;
    if (!res.ok) { setImages(snapshot); say(res.error, "error"); }
    else say(`ลบถาวร ${res.purged} รูป`);
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

  // doCreateAlbum needs doMove, which is declared above it; going through a ref
  // keeps that call current without adding doMove to every dependency list.
  const doMoveRef = useRef(doMove);
  doMoveRef.current = doMove;

  const doRename = useCallback(async (id: string, name: string) => {
    const snapshot = images;
    setImages((prev) => prev.map((i) => (i.id === id ? { ...i, name } : i)));
    const res = await guard(() => renameVaultImage(id, name), () => setImages(snapshot));
    if (res && !res.ok) { setImages(snapshot); say(res.error, "error"); }
  }, [images, say, guard]);

  /** `moveIds` covers "move to a new collection": create it, then put them in.
   *  Without this the create path silently dropped the pending move. */
  const doResize = useCallback(async (id: string, width: number) => {
    const before = images.find((i) => i.id === id);
    const res = await guard(() => applyResize(id, width), () => {});
    if (!res) return;
    if (!res.ok) { say(res.error, "error"); return; }
    setImages((prev) => prev.map((i) => (i.id === id ? res.image : i)));
    const saved = before ? before.bytes - res.image.bytes : 0;
    say(`ย่อแล้ว — เล็กลง ${formatBytes(Math.max(0, saved))}`);
  }, [images, say, guard]);

  const doCreateAlbum = useCallback(async (name: string, emoji: string, moveIds?: string[]) => {
    const res = await guard(() => createVaultAlbum(name, emoji), () => {});
    if (!res) return;
    if (!res.ok) { say(res.error, "error"); return; }
    setAlbums((prev) => [...prev, res.album]);
    setActive(res.album.id);
    if (moveIds?.length) await doMoveRef.current(moveIds, res.album.id);
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
  // Where a Shift-click measures from: the last tile touched without Shift.
  const anchorId = useRef<string | null>(null);

  const toggle = useCallback((id: string) => {
    anchorId.current = id;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  /**
   * Shift-click selects everything between the anchor and the clicked tile, in
   * the order currently on screen — so it follows the active sort and filter
   * rather than some hidden underlying order.
   */
  const selectRange = useCallback((id: string) => {
    const to = visible.findIndex((i) => i.id === id);
    if (to === -1) return;
    const fromId = anchorId.current;
    const from = fromId ? visible.findIndex((i) => i.id === fromId) : -1;
    if (from === -1) { toggle(id); return; }

    const [lo, hi] = from <= to ? [from, to] : [to, from];
    setSelected((prev) => {
      // Additive: shift-clicking a second range keeps the first.
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) next.add(visible[i].id);
      return next;
    });
  }, [visible, toggle]);

  /** Binning is reversible and the links keep working, so it needs no dialog. */
  const askDelete = useCallback((targets: VaultImage[]) => {
    void doDelete(targets.map((i) => i.id));
  }, [doDelete]);

  /** Purging is the irreversible one, so this is where the warning lives. */
  const askPurge = useCallback((targets: VaultImage[]) => {
    setConfirm({
      title: targets.length > 1 ? `ลบถาวร ${targets.length} รูป?` : `ลบถาวร "${targets[0].name}"?`,
      body: "ไฟล์จะถูกลบออกจาก R2 จริง ๆ และกู้คืนไม่ได้ — ถ้าลิงก์นี้ถูกเอาไปแปะไว้ที่เว็บอื่น รูปตรงนั้นจะหายไปด้วย",
      confirm: "ลบถาวร",
      onConfirm: () => void doPurge(targets.map((i) => i.id)),
    });
  }, [doPurge]);

  const askRename = useCallback((img: VaultImage) => {
    setPrompt({
      title: "เปลี่ยนชื่อรูป",
      value: img.name,
      confirm: "บันทึก",
      onConfirm: (name) => void doRename(img.id, name),
    });
  }, [doRename]);

  const askNewAlbum = useCallback((moveIds?: string[]) => {
    setPrompt({
      title: moveIds?.length ? `สร้างคอลเลกชันแล้วย้าย ${moveIds.length} รูปเข้าไป` : "สร้างคอลเลกชันใหม่",
      value: "",
      emoji: "📁",
      placeholder: "เช่น แบนเนอร์โปรโมท",
      confirm: "สร้าง",
      onConfirm: (name, emoji) => void doCreateAlbum(name, emoji, moveIds),
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
        if (inTrash) askPurge(selectedImages); else askDelete(selectedImages);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && selectedImages.length) {
        e.preventDefault();
        void copyMany(selectedImages, "direct");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedCount, selectedImages, visible, query, viewerId, prompt, confirm, askDelete, askPurge, inTrash, copyMany]);

  // ── Delivery proof ──────────────────────────────────────────────────────────
  // Optimistic like every other mutation here: the row disappears immediately
  // and comes back if the server refuses, so a slow connection never makes the
  // click feel ignored.

  // A search spans months, so the row's own month is the only reliable answer
  // to "which file holds this?" — the month picker is not it.
  const monthOfCapture = (capture: VaultImage) =>
    capture.month ?? monthKey(capture.capturedAt ?? capture.createdAt);

  const patchCapture = useCallback((id: string, change: Partial<VaultImage> | null) => {
    const apply = (list: VaultImage[]) =>
      change === null
        ? list.filter((c) => c.id !== id)
        : list.map((c) => (c.id === id ? { ...c, ...change } : c));
    setCaptures(apply);
    setArchive((prev) => (prev ? apply(prev) : prev));
  }, []);

  const askRenameCapture = useCallback((capture: VaultImage) => {
    setPrompt({
      title: "แก้ชื่อลูกค้า",
      value: capture.customer ?? capture.name,
      placeholder: "ชื่อในเกมของลูกค้า",
      confirm: "บันทึก",
      onConfirm: (name) => {
        const before = { customer: capture.customer, name: capture.name };
        patchCapture(capture.id, { customer: name, name });
        void guard(
          () => renameCapture(capture.id, monthOfCapture(capture), name),
          () => patchCapture(capture.id, before),
        ).then((res) => {
          if (!res || res.ok) return;
          patchCapture(capture.id, before);
          say(res.error, "error");
        });
      },
    });
  }, [guard, patchCapture, say]);

  const changeCaptureCategory = useCallback((capture: VaultImage, category: CaptureCategory) => {
    if (capture.category === category) return;
    const before = { category: capture.category };
    patchCapture(capture.id, { category });
    void guard(
      () => setCaptureCategory(capture.id, monthOfCapture(capture), category),
      () => patchCapture(capture.id, before),
    ).then((res) => {
      if (!res || res.ok) return;
      patchCapture(capture.id, before);
      say(res.error, "error");
    });
  }, [guard, patchCapture, say]);

  const askDeleteCapture = useCallback((capture: VaultImage) => {
    setConfirm({
      title: `ลบหลักฐานของ “${capture.customer ?? capture.name}”?`,
      body: "หลักฐานไม่มีถังขยะ — ลบแล้วหายถาวรทันที",
      confirm: "ลบถาวร",
      tone: "danger",
      onConfirm: () => {
        const restore = () => { deletedCaptures.current.delete(capture.id); setCaptures((p) => [capture, ...p]); };
        // Tombstoned as well as removed: a poll or a search landing before the
        // server commits would otherwise put the row straight back.
        deletedCaptures.current.add(capture.id);
        patchCapture(capture.id, null);

        void guard(() => deleteCapture(capture.id, monthOfCapture(capture)), restore).then((res) => {
          if (!res) return;
          if (res.ok) { say("ลบหลักฐานแล้ว"); return; }
          restore();
          say(res.error, "error");
        });
      },
    });
  }, [guard, patchCapture, say]);

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
        staff={staff}
        role={role}
        captureCounts={captureCounts}
        active={active}
        counts={counts}
        totalBytes={totalBytes}
        storage={storage}
        onSelect={(id) => { setActive(id); setSelected(new Set()); resetScroll(); }}
        onUpload={() => fileInput.current?.click()}
        onNewAlbum={askNewAlbum}
        onEditAlbum={(album, e) => setMenu({ kind: "album", anchor: { x: e.clientX, y: e.clientY + 8 }, album })}
        onDropOnAlbum={(albumId) => { if (dragTiles) void doMove(dragTiles, albumId); setDragTiles(null); }}
        isDraggingTiles={dragTiles !== null}
        onShowSetup={showSetup}
        onOpenStaff={() => setStaffOpen(true)}
      />

      <div className="main">
        <header className="bar">
          <div className="bar-title">
            <h1>{title}</h1>
            {inCaptures ? (
              <span className="tnum">
                {captureStaff ? captureCounts.byStaff[captureStaff] ?? 0 : captureCounts.total}
                {viewingCurrentMonth ? " รูปวันนี้" : " รูปเดือนนี้"}
                {query && ` · ค้นหา “${query}”`}
              </span>
            ) : !inTextTool && (
              <span className="tnum">
                {visible.length} รูป
                {query && ` · ค้นหา “${query}”`}
              </span>
            )}
          </div>

          <div className="bar-spacer" />

          {!inTextTool && (
          <>
          <label className="search">
            <Search size={15} color="var(--ink-4)" />
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); resetScroll(); }}
              placeholder={inCaptures ? "ค้นหาชื่อลูกค้าหรือทีมงาน…" : "ค้นหาชื่อรูป…"}
              aria-label={inCaptures ? "ค้นหาหลักฐาน" : "ค้นหารูป"}
            />
            {query && (
              <button type="button" onClick={() => setQuery("")} aria-label="ล้างคำค้น" style={{ display: "grid" }}>
                <X size={14} color="var(--ink-3)" />
              </button>
            )}
          </label>

          {inCaptures ? (
            <>
            <button
              type="button"
              className="iconbtn"
              data-on={alerts}
              aria-pressed={alerts}
              aria-label="แจ้งเตือนเมื่อมีหลักฐานใหม่"
              title={alerts ? "แจ้งเตือนเปิดอยู่ — เสียงติ๊งและป้ายเมื่อมีใบใหม่" : "แจ้งเตือนปิดอยู่"}
              onClick={toggleAlerts}
            >
              {alerts ? <Bell size={16} /> : <BellOff size={16} />}
            </button>
            <button
              type="button"
              className="btn"
              onClick={(e) => setMenu({ kind: "month", anchor: { x: e.clientX - 120, y: e.clientY + 14 } })}
            >
              <Calendar size={15} />
              {monthLabel(captureMonth)}
            </button>
            </>
          ) : (
          <button
            type="button"
            className="iconbtn"
            aria-label="เรียงลำดับ"
            title={SORTS.find((s) => s.key === sort)?.label}
            onClick={(e) => setMenu({ kind: "sort", anchor: { x: e.clientX, y: e.clientY + 12 } })}
          >
            <ArrowUpDown size={16} />
          </button>
          )}

          {!inCaptures && (
          <div className="seg" role="group" aria-label="ขนาดตาราง">
            <button type="button" data-on={!dense} onClick={() => setDense(false)} aria-label="ตารางปกติ">
              <LayoutGrid size={15} />
            </button>
            <button type="button" data-on={dense} onClick={() => setDense(true)} aria-label="ตารางถี่">
              <Grid2x2 size={15} />
            </button>
          </div>
          )}

          {inCaptures ? null : inTrash ? (
            <button
              type="button"
              className="btn btn--danger"
              disabled={visible.length === 0}
              onClick={() => askPurge(visible)}
            >
              <Trash2 size={15} />
              ล้างถังขยะ
            </button>
          ) : (
            <button type="button" className="btn btn--primary" onClick={() => fileInput.current?.click()}>
              <Upload size={15} strokeWidth={2.2} />
              อัปโหลด
            </button>
          )}
          </>
          )}
        </header>

        <div
          ref={canvasRef}
          className="canvas"
          onMouseDown={() => { marqueeBase.current = new Set(); }}
          style={dense
            ? ({ "--tile": "132px", "--gap": "11px" } as React.CSSProperties)
            : undefined}
        >
          {inTextTool ? <TextTool /> : inCaptures ? (
            <CapturesView
              captures={captureList}
              searching={searching}
              staff={staff}
              role={role}
              filterStaffId={captureStaff}
              query={query}
              canResize={storage.canResize}
              onCopy={(capture, format, width) => void copyOne(capture, format, width)}
              onRename={askRenameCapture}
              onDelete={askDeleteCapture}
              onSetCategory={changeCaptureCategory}
              onOpenStaff={() => setStaffOpen(true)}
            />
          ) : <>

          {/* The reversible-vs-permanent distinction should never be a surprise. */}
          {inTrash && visible.length > 0 && (
            <div className="v-note">
              <Undo2 size={14} />
              <span>
                รูปที่นี่ยังไม่ถูกลบจริง — <b>ลิงก์เดิมยังใช้งานได้ปกติ</b> และกู้คืนได้ตลอด
                จะหายจริงก็ต่อเมื่อกด “ลบถาวร” เท่านั้น
              </span>
            </div>
          )}

          {marquee && (
            <div
              className="marquee"
              style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }}
            />
          )}

          {visible.length === 0 && pendingCount === 0 ? (
            <div className="empty">
              <span className="empty-orb">
                {query ? <ImageOff size={30} /> : inTrash ? <Trash2 size={30} /> : active === UNFILED ? <Inbox size={30} /> : <Sparkles size={30} />}
              </span>
              <h2>
                {query ? "ไม่พบรูปที่ค้นหา" : inTrash ? "ถังขยะว่างเปล่า" : `${title} — ยังไม่มีรูป`}
              </h2>
              <p>
                {query
                  ? "ลองเปลี่ยนคำค้น หรือดูที่ “รูปทั้งหมด”"
                  : inTrash
                    ? "รูปที่ลบจะมาพักที่นี่ก่อน กู้คืนได้ตลอด จนกว่าจะกดลบถาวร"
                    : <>ลากไฟล์มาวางตรงไหนก็ได้ กด <span className="kbd">Ctrl</span><span className="kbd">V</span> วางจากคลิปบอร์ด หรือกดปุ่มอัปโหลดด้านบน</>}
              </p>
            </div>
          ) : (
            <>
              {/* Skeletons for files still encoding, so the grid never looks
                  empty mid-batch. They sit in their own grid so they cannot
                  shift the row arithmetic the virtualiser depends on. */}
              {pendingCount > 0 && (
                <div className="grid" style={{ marginBottom: "var(--gap, 16px)" }}>
                  {Array.from({ length: pendingCount }, (_, i) => (
                    <figure className="tile tile--ghost" key={`ghost-${i}`}>
                      <div className="tile-img" />
                      <div className="tile-meta">
                        <div className="tile-name" style={{ color: "var(--ink-4)" }}>กำลังอัปโหลด…</div>
                        <div className="tile-sub">&nbsp;</div>
                      </div>
                    </figure>
                  ))}
                </div>
              )}

              <div
                ref={gridRef}
                className="grid"
                style={win.active ? { paddingTop: win.padTop, paddingBottom: win.padBottom } : undefined}
              >
                {visible.slice(win.start, win.end).map((img, i) => (
                  <Tile
                    key={img.id}
                    image={img}
                    index={win.start + i}
                    animate={!win.active}
                    selected={selected.has(img.id)}
                    dragging={dragTiles?.includes(img.id) ?? false}
                    onCopy={() => void copyOne(img)}
                    onToggle={(range) => (range ? selectRange(img.id) : toggle(img.id))}
                    onOpen={() => setViewerId(img.id)}
                    onMenu={(e) => openTileMenu(e, img)}
                    onDragStart={() => setDragTiles(selected.has(img.id) ? [...selected] : [img.id])}
                    onDragEnd={() => setDragTiles(null)}
                  />
                ))}
              </div>
            </>
          )}

          </>}
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
          {inTrash ? (
            <>
              <button type="button" className="btn btn--sm" onClick={() => void doRestore(selectedImages.map((i) => i.id))}>
                <Undo2 size={13} /> กู้คืน
              </button>
              <button type="button" className="btn btn--sm btn--danger" onClick={() => askPurge(selectedImages)}>
                <Trash2 size={13} /> ลบถาวร
              </button>
            </>
          ) : (
            <>
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
              <button type="button" className="btn btn--sm btn--danger" onClick={() => askDelete(selectedImages)} title="ย้ายไปถังขยะ">
                <Trash2 size={13} />
              </button>
            </>
          )}
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
              onClick={() => { setSort(s.key); closeMenu(); resetScroll(); }}
            />
          ))}
        </Menu>
      )}

      {menu?.kind === "month" && (
        <Menu anchor={menu.anchor} onClose={closeMenu}>
          <div className="menu-label">เดือน</div>
          {(captureMonths.includes(monthKey(Date.now()))
            ? captureMonths
            : [monthKey(Date.now()), ...captureMonths]).map((m) => (
            <MenuItem
              key={m}
              icon={captureMonth === m ? <Check size={14} color="var(--violet-hi)" /> : null}
              label={monthLabel(m)}
              onClick={() => {
                closeMenu();
                setCaptureMonth(m);
                resetScroll();
                // The month files are separate objects, so switching is a fetch.
                void loadCaptures(m)
                  .then((r) => {
                    setCaptures(r.captures);
                    // The delta cursor belongs to the month on screen.
                    newestSeen.current = Math.max(0, ...r.captures.map((c) => c.createdAt));
                    captureCount.current = r.captures.length;
                  })
                  .catch(() => say("โหลดหลักฐานเดือนนี้ไม่สำเร็จ", "error"));
              }}
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
          {albums.length > 0 && <div className="menu-sep" />}
          <MenuItem
            icon={<Plus size={14} />}
            label="สร้างคอลเลกชันใหม่…"
            onClick={() => { const ids = menu.ids; closeMenu(); askNewAlbum(ids); }}
          />
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

          {storage.canResize && (
            <>
              <div className="menu-sep" />
              <div className="menu-label">ลิงก์ย่อขนาด (ย่อที่ CDN)</div>
              {RESIZE_WIDTHS.map((w) => (
                <MenuItem
                  key={w}
                  icon={<Shrink size={14} />}
                  label={`กว้าง ${w}px`}
                  onClick={() => {
                    const targets = menuTargets;
                    closeMenu();
                    void (targets.length > 1
                      ? copyMany(targets, "direct", w)
                      : copyOne(targets[0], "direct", w));
                  }}
                />
              ))}
            </>
          )}

          <div className="menu-sep" />

          {inTrash && (
            <>
              <MenuItem
                icon={<Undo2 size={14} />}
                label={menuTargets.length > 1 ? `กู้คืน ${menuTargets.length} รูป` : "กู้คืนรูปนี้"}
                onClick={() => { const ids = menuTargets.map((i) => i.id); closeMenu(); void doRestore(ids); }}
              />
              <MenuItem
                icon={<Trash2 size={14} />}
                label={menuTargets.length > 1 ? `ลบถาวร ${menuTargets.length} รูป` : "ลบถาวร"}
                danger
                onClick={() => { const targets = menuTargets; closeMenu(); askPurge(targets); }}
              />
            </>
          )}

          {!inTrash && menuTargets.length === 1 && (
            <>
              <MenuItem
                icon={<ImageDown size={14} />}
                label="คัดลอกรูปภาพ"
                onClick={() => { const target = menuTargets[0]; closeMenu(); void copyImage(target); }}
              />
              <MenuItem
                icon={<Minimize2 size={14} />}
                label="ย่อขนาดรูป…"
                onClick={() => { const target = menuTargets[0]; closeMenu(); setResizing(target); }}
              />

              <div className="menu-sep" />

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

          {!inTrash && (
            <>
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
                label={menuTargets.length > 1 ? `ย้าย ${menuTargets.length} รูปไปถังขยะ` : "ย้ายไปถังขยะ"}
                danger
                onClick={() => { const targets = menuTargets; closeMenu(); askDelete(targets); }}
              />
            </>
          )}
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
          canResize={storage.canResize}
          onCopy={(format, width) => void copyOne(viewerImage, format, width)}
          onRename={() => askRename(viewerImage)}
          onDelete={() => (inTrash ? askPurge([viewerImage]) : askDelete([viewerImage]))}
          onPickAlbum={(e) => setMenu({ kind: "move", anchor: { x: e.clientX - 120, y: e.clientY + 10 }, ids: [viewerImage.id] })}
        />
      )}

      {resizing && (
        <ResizeDialog
          image={resizing}
          keepsUrl={storage.canPurge}
          onApply={(width) => void doResize(resizing.id, width)}
          onClose={() => setResizing(null)}
        />
      )}

      {staffOpen && (
        <StaffModal
          staff={staff}
          onClose={() => setStaffOpen(false)}
          onChanged={setStaff}
          say={say}
          ask={setPrompt}
          confirm={setConfirm}
        />
      )}

      {prompt && <PromptModal spec={prompt} onClose={() => setPrompt(null)} />}
      {confirm && <ConfirmModal spec={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
