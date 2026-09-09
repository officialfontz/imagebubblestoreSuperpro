"use client";

// ── Shrink ────────────────────────────────────────────────────────────────────
// Throw pictures in; get small ones out; copy them straight into a chat.
//
// Built around how it is actually used: shrink, copy, paste, done. Download is
// the second path. Nothing is kept — this is not the vault's front door, and a
// day of resized chat pictures in the library would bury the real ones.
//
// One choice, not five: a size ceiling, or a quality, or a longest edge. The
// last choice is remembered, so the second time it is throw, copy, paste.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Clipboard, Download, Trash2, Check, Loader2, ImagePlus, X } from "lucide-react";
import {
  DEFAULT_SHRINK, asPng, extOf, renamed, shrink, zipOf,
  type ShrinkFormat, type ShrinkMode, type ShrinkResult, type ShrinkSettings,
} from "@/lib/shrink";
import { formatBytes } from "./ui";

type Job = {
  id: string;
  file: File;
  url: string;
  state: "queued" | "working" | "done" | "failed";
  result?: ShrinkResult;
  error?: string;
  copied?: boolean;
};

const STORAGE_KEY = "bv.shrink.v1";
const KB_CHIPS = [200, 500, 1024, 2048];
const WIDTH_CHIPS = [800, 1280, 1920, 2560];

// The settings live in localStorage and are read through useSyncExternalStore,
// so the server renders the defaults, the first client paint agrees, and the
// saved values arrive without a state update inside an effect.
let current: ShrinkSettings | null = null;
const listeners = new Set<() => void>();
function readSettings(): ShrinkSettings {
  if (current) return current;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    current = raw ? { ...DEFAULT_SHRINK, ...(JSON.parse(raw) as Partial<ShrinkSettings>) } : DEFAULT_SHRINK;
  } catch {
    current = DEFAULT_SHRINK;
  }
  return current;
}
function writeSettings(next: ShrinkSettings) {
  current = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  listeners.forEach((fn) => fn());
}
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export default function ShrinkTool() {
  const settings = useSyncExternalStore(subscribe, readSettings, () => DEFAULT_SHRINK);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [over, setOver] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** Jobs whose shrink is in flight, so a double pump never runs one twice. */
  const inFlight = useRef<Set<string>>(new Set());

  const change = (patch: Partial<ShrinkSettings>) => writeSettings({ ...readSettings(), ...patch });

  const say = (text: string) => {
    setNote(text);
    setTimeout(() => setNote((n) => (n === text ? null : n)), 2500);
  };

  // ── Working through the queue, one at a time ───────────────────────────────
  // Serial on purpose: decoding six phone photos at once is six 50 MB bitmaps
  // in memory, which is how a browser tab dies on a laptop. The pump is called
  // wherever the queue changes and picks up the next waiting job, if nothing
  // is already running.
  // A plain function, hoisted, so it can hand itself to the job's finally
  // without a ref dance. It closes over nothing that changes: setJobs is
  // stable, inFlight is a ref, and the settings are read from the store.
  function pump() {
    setJobs((prev) => {
      if (prev.some((j) => j.state === "working")) return prev;
      const next = prev.find((j) => j.state === "queued");
      if (!next) return prev;
      const id = next.id;
      // StrictMode calls an updater twice. Both calls return the same state;
      // only the first starts the work.
      if (!inFlight.current.has(id)) {
        inFlight.current.add(id);
        const file = next.file;
        void shrink(file, readSettings())
        .then((result) => setJobs((cur) => cur.map((j) => (j.id === id ? { ...j, state: "done", result } : j))))
        .catch(() => setJobs((cur) => cur.map((j) => (j.id === id ? { ...j, state: "failed", error: "เปิดรูปนี้ไม่ได้" } : j))))
          .finally(() => { inFlight.current.delete(id); pump(); });
      }
      return prev.map((j) => (j.id === id ? { ...j, state: "working" } : j));
    });
  }

  // ── Taking pictures in ─────────────────────────────────────────────────────
  const add = useCallback((files: FileList | File[]) => {
    const fresh: Job[] = Array.from(files)
      .filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name))
      .map((file) => ({ id: Math.random().toString(36).slice(2), file, url: URL.createObjectURL(file), state: "queued" }));
    if (fresh.length === 0) { say("ไม่พบรูปในสิ่งที่วาง"); return; }
    setJobs((prev) => [...prev, ...fresh]);
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length) { e.preventDefault(); add(files); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [add]);

  // A settings change re-does everything: the point of a setting is the result.
  const redoAll = (patch: Partial<ShrinkSettings>) => {
    change(patch);
    setJobs((prev) => prev.map((j) => (j.state === "failed" || j.state === "working" ? j : { ...j, state: "queued", result: undefined, copied: false })));
    pump();
  };

  const remove = (id: string) => setJobs((prev) => {
    const gone = prev.find((j) => j.id === id);
    if (gone) URL.revokeObjectURL(gone.url);
    return prev.filter((j) => j.id !== id);
  });
  const clear = () => { jobs.forEach((j) => URL.revokeObjectURL(j.url)); setJobs([]); };
  useEffect(() => () => { jobs.forEach((j) => URL.revokeObjectURL(j.url)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Out ────────────────────────────────────────────────────────────────────
  const copyOne = async (job: Job) => {
    if (!job.result) return;
    try {
      // The clipboard takes PNG; browsers refuse WebP there. The picture is
      // re-encoded losslessly for the trip, so what is pasted looks the same.
      const png = await asPng(job.result.blob);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, copied: true } : j)));
      say("คัดลอกแล้ว — วางในแชตได้เลย");
    } catch {
      say("เบราว์เซอร์นี้คัดลอกรูปไม่ได้ — ใช้ดาวน์โหลดแทน");
    }
  };

  const downloadOne = (job: Job) => {
    if (!job.result) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(job.result.blob);
    a.download = renamed(job.file.name, job.result.blob.type);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const downloadAll = async () => {
    const done = jobs.filter((j) => j.result);
    if (done.length === 1) { downloadOne(done[0]); return; }
    const zip = await zipOf(done.map((j) => ({ name: renamed(j.file.name, j.result!.blob.type), blob: j.result!.blob })));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(zip);
    a.download = `ย่อรูป-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const done = jobs.filter((j) => j.result);
  const before = done.reduce((n, j) => n + j.result!.from.bytes, 0);
  const after = done.reduce((n, j) => n + j.result!.blob.size, 0);
  const latest = [...done].reverse()[0];

  return (
    <div
      className="shrink"
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
    >
      <div className="shrink-drop" data-over={over} onClick={() => jobs.length === 0 && fileInput.current?.click()}>
        {jobs.length === 0 ? (
          <div className="shrink-empty">
            <span className="empty-orb"><ImagePlus size={30} /></span>
            <b>โยนรูปเข้ามาได้เลย</b>
            <span>ลากวาง · Ctrl+V · หรือกดตรงนี้เพื่อเลือกไฟล์</span>
            <small>ทำในเบราว์เซอร์ทั้งหมด ไม่มีอะไรถูกอัปโหลด</small>
          </div>
        ) : (
          <>
            {jobs.map((job) => (
              <div className="shrink-row" key={job.id} data-state={job.state}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="shrink-thumb" src={job.url} alt="" />
                <div className="shrink-meta">
                  <b title={job.file.name}>{job.file.name}</b>
                  {job.result ? (
                    <small className="tnum">
                      {job.result.from.width}×{job.result.from.height} · {formatBytes(job.result.from.bytes)}
                      {" → "}
                      {job.result.width}×{job.result.height} · <b className="shrink-size">{formatBytes(job.result.blob.size)}</b>
                    </small>
                  ) : (
                    <small>{job.state === "failed" ? job.error : job.state === "working" ? "กำลังย่อ…" : "รอคิว"}</small>
                  )}
                  <div className="shrink-bar"><i data-state={job.state} /></div>
                </div>
                {job.result && (
                  <span className="shrink-pct tnum">
                    −{Math.max(0, Math.round((1 - job.result.blob.size / job.result.from.bytes) * 100))}%
                    <small>{extOf(job.result.blob.type)}</small>
                  </span>
                )}
                {job.state === "working" && <Loader2 size={16} className="spin" style={{ color: "var(--violet-hi)" }} />}
                <div className="shrink-act">
                  {job.result && (
                    <>
                      <button type="button" onClick={() => void copyOne(job)} title="คัดลอก" aria-label="คัดลอก">
                        {job.copied ? <Check size={14} /> : <Clipboard size={14} />}
                      </button>
                      <button type="button" onClick={() => downloadOne(job)} title="ดาวน์โหลด" aria-label="ดาวน์โหลด"><Download size={14} /></button>
                    </>
                  )}
                  <button type="button" onClick={() => remove(job.id)} title="เอาออก" aria-label="เอาออก"><X size={14} /></button>
                </div>
              </div>
            ))}
            <button type="button" className="shrink-more" onClick={() => fileInput.current?.click()}>
              + วางเพิ่มได้เรื่อย ๆ · Ctrl+V · หรือกดเพื่อเลือกไฟล์
            </button>
          </>
        )}
        <input
          ref={fileInput} type="file" accept="image/*,.heic,.heif" multiple hidden
          onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ""; }}
        />
      </div>

      <div className="shrink-side">
        <div>
          <span className="f-lbl">เอาแบบไหน</span>
          <div className="seg seg--full" role="radiogroup">
            {([["kb", "ไม่เกิน KB"], ["quality", "คุณภาพ"], ["width", "กว้างสุด"]] as [ShrinkMode, string][]).map(([m, label]) => (
              <button key={m} type="button" data-on={settings.mode === m} onClick={() => redoAll({ mode: m })}>{label}</button>
            ))}
          </div>

          {settings.mode === "kb" && (
            <>
              <label className="shrink-big">
                <input
                  type="number" min={50} max={20_000} step={50} value={settings.maxKb}
                  onChange={(e) => change({ maxKb: Math.max(50, Number(e.target.value) || 500) })}
                  onBlur={() => redoAll({})}
                />
                <small>KB ต่อรูป</small>
              </label>
              <div className="shrink-chips">
                {KB_CHIPS.map((kb) => (
                  <button key={kb} type="button" data-on={settings.maxKb === kb} onClick={() => redoAll({ maxKb: kb })}>
                    {kb >= 1024 ? `${kb / 1024} MB` : kb}
                  </button>
                ))}
              </div>
            </>
          )}
          {settings.mode === "quality" && (
            <label className="shrink-slider">
              <span className="tnum">{Math.round(settings.quality * 100)}%</span>
              <input
                type="range" min={0.3} max={0.95} step={0.05} value={settings.quality}
                onChange={(e) => change({ quality: Number(e.target.value) })} onMouseUp={() => redoAll({})} onTouchEnd={() => redoAll({})}
              />
            </label>
          )}
          {settings.mode === "width" && (
            <div className="shrink-chips" style={{ marginTop: 10 }}>
              {WIDTH_CHIPS.map((w) => (
                <button key={w} type="button" data-on={settings.maxWidth === w} onClick={() => redoAll({ maxWidth: w })}>{w}px</button>
              ))}
            </div>
          )}
        </div>

        <div>
          <span className="f-lbl">รูปแบบไฟล์</span>
          <div className="seg seg--full" role="radiogroup">
            {([["image/webp", "WebP"], ["image/jpeg", "JPEG"], ["image/png", "PNG"]] as [ShrinkFormat, string][]).map(([f, label]) => (
              <button key={f} type="button" data-on={settings.format === f} onClick={() => redoAll({ format: f })}>{label}</button>
            ))}
          </div>
        </div>

        {done.length > 0 && (
          <div className="shrink-sum">
            ทั้งชุด {done.length} รูป
            <b className="tnum">{formatBytes(before)} → {formatBytes(after)}</b>
            <span>ประหยัด {Math.max(0, Math.round((1 - after / Math.max(1, before)) * 100))}% · จำค่านี้ไว้ให้ครั้งหน้า</span>
          </div>
        )}

        <div className="shrink-foot">
          {note && <p className="shrink-note">{note}</p>}
          <button
            type="button" className="btn btn--primary btn--lg" disabled={!latest}
            onClick={() => latest && void copyOne(latest)}
          >
            <Clipboard size={16} /> {done.length > 1 ? "คัดลอกรูปล่าสุด · วางได้เลย" : "คัดลอก · วางได้เลย"}
          </button>
          <div className="shrink-two">
            <button type="button" className="btn" disabled={done.length === 0} onClick={() => void downloadAll()}>
              <Download size={15} /> {done.length > 1 ? "ดาวน์โหลด ZIP" : "ดาวน์โหลด"}
            </button>
            <button type="button" className="btn" disabled={jobs.length === 0} onClick={clear}>
              <Trash2 size={15} /> ล้าง
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
