"use client";

// ── Stamp ─────────────────────────────────────────────────────────────────────
// The shop's logo on a picture, or on thirty of them, in a corner that is
// remembered. Product shots and promo pictures go out with the mark; a
// picture lifted from a chat still says whose it is.
//
// Same shape as shrink: throw pictures in, copy the result, paste. Nothing is
// kept. The live preview at the top is the latest picture with the mark on
// it, so a change of corner or opacity is seen before anything is downloaded.

import { useCallback, useEffect, useRef, useState } from "react";
import { Clipboard, Download, Trash2, Check, Loader2, ImagePlus, X } from "lucide-react";
import { DEFAULT_WATERMARK, watermark, type Corner, type WatermarkSettings } from "@/lib/watermark";
import { asPng, extOf, zipOf } from "@/lib/shrink";
import { settingsStore } from "@/lib/settings-store";
import { formatBytes } from "./ui";

type Result = { blob: Blob; url: string; width: number; height: number };
type Job = {
  id: string;
  file: File;
  state: "queued" | "working" | "done" | "failed";
  result?: Result;
  error?: string;
  copied?: boolean;
};

const store = settingsStore<WatermarkSettings>("bv.stamp.v1", DEFAULT_WATERMARK);

const CORNERS: { id: Corner; label: string }[] = [
  { id: "tl", label: "บนซ้าย" }, { id: "tr", label: "บนขวา" },
  { id: "c", label: "กลาง" },
  { id: "bl", label: "ล่างซ้าย" }, { id: "br", label: "ล่างขวา" },
];

const stampedName = (name: string, type: string) => name.replace(/\.[^.]+$/, "") + "-logo." + extOf(type);

export default function StampTool() {
  const settings = store.use();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [over, setOver] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef<Set<string>>(new Set());

  const say = (text: string) => {
    setNote(text);
    setTimeout(() => setNote((n) => (n === text ? null : n)), 2500);
  };

  // Serial, like shrink: one decoded photo in memory at a time.
  function pump() {
    setJobs((prev) => {
      if (prev.some((j) => j.state === "working")) return prev;
      const next = prev.find((j) => j.state === "queued");
      if (!next) return prev;
      const id = next.id;
      if (!inFlight.current.has(id)) {
        inFlight.current.add(id);
        void watermark(next.file, store.read())
          .then(({ blob, width, height }) => setJobs((cur) => cur.map((j) => {
            if (j.id !== id) return j;
            if (j.result) URL.revokeObjectURL(j.result.url);
            return { ...j, state: "done", result: { blob, width, height, url: URL.createObjectURL(blob) } };
          })))
          .catch(() => setJobs((cur) => cur.map((j) => (j.id === id ? { ...j, state: "failed", error: "เปิดรูปนี้ไม่ได้" } : j))))
          .finally(() => { inFlight.current.delete(id); pump(); });
      }
      return prev.map((j) => (j.id === id ? { ...j, state: "working" } : j));
    });
  }

  const add = useCallback((files: FileList | File[]) => {
    const fresh: Job[] = Array.from(files)
      .filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name))
      .map((file) => ({ id: Math.random().toString(36).slice(2), file, state: "queued" }));
    if (fresh.length === 0) { say("ไม่พบรูปในสิ่งที่วาง"); return; }
    setJobs((prev) => [...prev, ...fresh]);
    setShown(fresh[fresh.length - 1].id);
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

  // Every setting is about where and how the mark sits, so a change redoes
  // the lot. Drawing one logo is milliseconds; this is not the shrink search.
  const redoAll = (patch: Partial<WatermarkSettings>) => {
    store.patch(patch);
    setJobs((prev) => prev.map((j) => (j.state === "failed" || j.state === "working" ? j : { ...j, state: "queued", copied: false })));
    pump();
  };

  const revoke = (j: Job) => { if (j.result) URL.revokeObjectURL(j.result.url); };
  const remove = (id: string) => setJobs((prev) => { prev.filter((j) => j.id === id).forEach(revoke); return prev.filter((j) => j.id !== id); });
  const clear = () => { jobs.forEach(revoke); setJobs([]); };
  useEffect(() => () => { jobs.forEach(revoke); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const copyOne = async (job: Job) => {
    if (!job.result) return;
    try {
      const png = await asPng(job.result.blob);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, copied: true } : j)));
      say("คัดลอกแล้ว — วางในแชตได้เลย");
    } catch {
      say("เบราว์เซอร์นี้คัดลอกรูปไม่ได้ — ใช้ดาวน์โหลดแทน");
    }
  };

  const save = (blob: Blob, name: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const downloadOne = (job: Job) => job.result && save(job.result.blob, stampedName(job.file.name, job.result.blob.type));
  const downloadAll = async () => {
    const done = jobs.filter((j) => j.result);
    if (done.length === 1) { downloadOne(done[0]); return; }
    const zip = await zipOf(done.map((j) => ({ name: stampedName(j.file.name, j.result!.blob.type), blob: j.result!.blob })));
    save(zip, `ใส่โลโก้-${new Date().toISOString().slice(0, 10)}.zip`);
  };

  const done = jobs.filter((j) => j.result);
  const latest = [...done].reverse()[0];
  const preview = jobs.find((j) => j.id === shown && j.result) ?? latest;

  return (
    <div
      className="shrink stamp"
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
    >
      <div className="shrink-drop" data-over={over} onClick={() => jobs.length === 0 && fileInput.current?.click()}>
        {jobs.length === 0 ? (
          <div className="shrink-empty">
            <span className="empty-orb"><ImagePlus size={30} /></span>
            <b>โยนรูปสินค้าเข้ามาได้เลย</b>
            <span>ลากวาง · Ctrl+V · หรือกดตรงนี้เพื่อเลือกไฟล์ · ใส่โลโก้ให้ทุกใบ</span>
            <small>ทำในเบราว์เซอร์ทั้งหมด ไม่มีอะไรถูกอัปโหลด</small>
          </div>
        ) : (
          <>
            {preview?.result && (
              <figure className="wm-preview">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={preview.result.url} alt="" />
                <figcaption className="tnum">{preview.result.width}×{preview.result.height} · {formatBytes(preview.result.blob.size)} · ตัวอย่างจริงตามที่จะได้</figcaption>
              </figure>
            )}
            {jobs.map((job) => (
              <div
                className="shrink-row" key={job.id} data-state={job.state} data-on={job.id === preview?.id}
                onClick={() => job.result && setShown(job.id)}
              >
                {job.result
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img className="shrink-thumb" src={job.result.url} alt="" />
                  : <span className="shrink-thumb" />}
                <div className="shrink-meta">
                  <b title={job.file.name}>{job.file.name}</b>
                  <small className="tnum">
                    {job.result
                      ? `${job.result.width}×${job.result.height} · ${formatBytes(job.result.blob.size)} · ${extOf(job.result.blob.type)}`
                      : job.state === "failed" ? job.error : job.state === "working" ? "กำลังใส่โลโก้…" : "รอคิว"}
                  </small>
                </div>
                {job.state === "working" && <Loader2 size={16} className="spin" style={{ color: "var(--violet-hi)" }} />}
                <div className="shrink-act" onClick={(e) => e.stopPropagation()}>
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
          <span className="f-lbl">วางโลโก้ตรงไหน</span>
          <div className="wm-pos" role="radiogroup" aria-label="ตำแหน่งโลโก้">
            {CORNERS.map((c) => (
              <button
                key={c.id} type="button" data-pos={c.id} data-on={settings.corner === c.id}
                title={c.label} aria-label={c.label} onClick={() => redoAll({ corner: c.id })}
              >
                <i />
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="f-lbl">ขนาดโลโก้</span>
          <label className="shrink-slider">
            <span className="tnum">{Math.round(settings.size * 100)}%</span>
            <input
              type="range" min={0.08} max={0.4} step={0.01} value={settings.size}
              onChange={(e) => store.patch({ size: Number(e.target.value) })} onMouseUp={() => redoAll({})} onTouchEnd={() => redoAll({})}
            />
          </label>
        </div>

        <div>
          <span className="f-lbl">ความชัด</span>
          <label className="shrink-slider">
            <span className="tnum">{Math.round(settings.opacity * 100)}%</span>
            <input
              type="range" min={0.2} max={1} step={0.05} value={settings.opacity}
              onChange={(e) => store.patch({ opacity: Number(e.target.value) })} onMouseUp={() => redoAll({})} onTouchEnd={() => redoAll({})}
            />
          </label>
        </div>

        <div>
          <span className="f-lbl">ข้อความใต้โลโก้ <small>(ไม่ใส่ก็ได้)</small></span>
          <input
            className="wm-caption" type="text" maxLength={40} placeholder="เช่น @bubbleshop หรือ Line: bubble"
            value={settings.caption}
            onChange={(e) => store.patch({ caption: e.target.value })}
            onBlur={() => redoAll({})}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); redoAll({}); } }}
          />
        </div>

        <div>
          <span className="f-lbl">รูปแบบไฟล์</span>
          <div className="seg seg--full" role="radiogroup">
            {([["image/webp", "WebP"], ["image/jpeg", "JPEG"], ["image/png", "PNG"]] as [WatermarkSettings["format"], string][]).map(([f, label]) => (
              <button key={f} type="button" data-on={settings.format === f} onClick={() => redoAll({ format: f })}>{label}</button>
            ))}
          </div>
        </div>

        {done.length > 0 && (
          <div className="shrink-sum">
            ใส่โลโก้แล้ว {done.length} รูป
            <span>ตำแหน่ง · ขนาด · ความชัด จำไว้ให้ครั้งหน้า</span>
          </div>
        )}

        <div className="shrink-foot">
          {note && <p className="shrink-note">{note}</p>}
          <button
            type="button" className="btn btn--primary btn--lg" disabled={!preview?.result}
            onClick={() => preview && void copyOne(preview)}
          >
            <Clipboard size={16} /> {done.length > 1 ? "คัดลอกรูปที่เลือก · วางได้เลย" : "คัดลอก · วางได้เลย"}
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
