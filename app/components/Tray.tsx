"use client";

// ── Upload tray ───────────────────────────────────────────────────────────────

import { Loader2, Check, AlertTriangle, X } from "lucide-react";

export type UploadJob = {
  id: string;
  name: string;
  status: "queued" | "running" | "done" | "error";
  error?: string;
};

export default function Tray({ jobs, onDismiss }: { jobs: UploadJob[]; onDismiss: () => void }) {
  if (jobs.length === 0) return null;

  const done = jobs.filter((j) => j.status === "done").length;
  const failed = jobs.filter((j) => j.status === "error");
  const active = jobs.some((j) => j.status === "queued" || j.status === "running");
  const settled = done + failed.length;

  return (
    <div className="tray">
      <div className="tray-head">
        {active
          ? <Loader2 size={16} className="spin" color="var(--violet-hi)" />
          : failed.length
            ? <AlertTriangle size={16} color="var(--danger)" />
            : <Check size={16} color="var(--ok)" />}
        <span className="tray-head-text">
          <b>{active ? "กำลังอัปโหลด" : failed.length ? "อัปโหลดเสร็จ มีบางไฟล์ไม่สำเร็จ" : "อัปโหลดเสร็จแล้ว"}</b>
          <small className="tnum">{settled}/{jobs.length} ไฟล์</small>
        </span>
        {!active && (
          <button type="button" className="iconbtn" style={{ width: 26, height: 26 }} onClick={onDismiss} aria-label="ปิด">
            <X size={14} />
          </button>
        )}
      </div>

      <div className="tray-track">
        <div className="tray-fill" style={{ width: `${Math.round((settled / jobs.length) * 100)}%` }} />
      </div>

      {/* While running, show what is in flight. Once settled, only the failures
          matter — a wall of green ticks for 60 files is noise. */}
      <div className="tray-list">
        {(active ? jobs.filter((j) => j.status !== "done") : failed).slice(0, 30).map((job) => (
          <div className="tray-row" key={job.id}>
            {job.status === "running" && <Loader2 size={12} className="spin" color="var(--violet-hi)" />}
            {job.status === "queued"  && <span style={{ width: 12, textAlign: "center", color: "var(--ink-4)" }}>·</span>}
            {job.status === "error"   && <AlertTriangle size={12} color="var(--danger)" />}
            <span title={job.name}>{job.name}</span>
            {job.error && <em>{job.error}</em>}
          </div>
        ))}
      </div>
    </div>
  );
}
