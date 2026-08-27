"use client";

// ── Shared primitives ─────────────────────────────────────────────────────────

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, AlertTriangle } from "lucide-react";

// ── Formatting ────────────────────────────────────────────────────────────────

export function formatBytes(n: number): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

/** Relative time in Thai, falling back to an absolute date past a month. */
export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < MINUTE) return "เมื่อครู่";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} นาทีที่แล้ว`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} ชั่วโมงที่แล้ว`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} วันที่แล้ว`;
  return new Date(ts).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" });
}

/** Copies text, falling back to a hidden textarea where the async Clipboard API
 *  is unavailable (insecure origin, older Safari, denied permission). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// ── Toasts ────────────────────────────────────────────────────────────────────

export type Toast = { id: number; text: string; kind: "ok" | "error" };

export function ToastStack({ toasts, raised }: { toasts: Toast[]; raised: boolean }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" data-raised={raised} role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast" data-kind={t.kind} key={t.id}>
          {t.kind === "ok" ? <Check size={15} /> : <AlertTriangle size={15} />}
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ── Popup menu ────────────────────────────────────────────────────────────────

export type MenuAnchor = { x: number; y: number };

export function Menu({
  anchor, onClose, children,
}: {
  anchor: MenuAnchor; onClose: () => void; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });

  // Measured before paint so the menu never flashes at the un-clamped point.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(anchor.x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(anchor.y, window.innerHeight - r.height - 8)),
    });
  }, [anchor.x, anchor.y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // Capture phase, so the menu closes before whatever is underneath reacts.
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="menu" style={pos} role="menu">
      {children}
    </div>
  );
}

export function MenuItem({
  icon, label, shortcut, danger, onClick,
}: {
  icon?: React.ReactNode; label: string; shortcut?: string; danger?: boolean; onClick: () => void;
}) {
  return (
    <button type="button" role="menuitem" className="menu-item" data-danger={danger} onClick={onClick}>
      {icon && <span style={{ display: "grid", placeItems: "center", width: 15 }}>{icon}</span>}
      {label}
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
}

// ── Modals ────────────────────────────────────────────────────────────────────

function Scrim({ onClose, children, label }: { onClose: () => void; children: React.ReactNode; label: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

export type PromptSpec = {
  title: string;
  value: string;
  /** Present ⇒ an emoji field is shown alongside the text field. */
  emoji?: string;
  placeholder?: string;
  confirm: string;
  onConfirm: (value: string, emoji: string) => void;
};

export function PromptModal({ spec, onClose }: { spec: PromptSpec; onClose: () => void }) {
  const [value, setValue] = useState(spec.value);
  const [emoji, setEmoji] = useState(spec.emoji ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.select(); }, []);

  const submit = () => {
    const v = value.trim();
    if (!v) return;
    spec.onConfirm(v, emoji.trim() || "📁");
    onClose();
  };

  return (
    <Scrim onClose={onClose} label={spec.title}>
      <h2>{spec.title}</h2>
      <div className="modal-body">
        {spec.emoji !== undefined && (
          <input
            className="field field--emoji"
            value={emoji}
            maxLength={4}
            aria-label="อีโมจิ"
            onChange={(e) => setEmoji(e.target.value)}
          />
        )}
        <input
          ref={inputRef}
          className="field"
          value={value}
          maxLength={120}
          placeholder={spec.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
      </div>
      <div className="modal-foot">
        <button type="button" className="btn btn--ghost" onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn--primary" onClick={submit} disabled={!value.trim()}>
          {spec.confirm}
        </button>
      </div>
    </Scrim>
  );
}

export type ConfirmSpec = {
  title: string;
  body: string;
  confirm: string;
  tone?: "danger" | "info";
  onConfirm: () => void;
};

export function ConfirmModal({ spec, onClose }: { spec: ConfirmSpec; onClose: () => void }) {
  const info = spec.tone === "info";
  return (
    <Scrim onClose={onClose} label={spec.title}>
      <h2>{spec.title}</h2>
      <p>{spec.body}</p>
      <div className="modal-foot">
        {!info && <button type="button" className="btn btn--ghost" onClick={onClose}>ยกเลิก</button>}
        <button
          type="button"
          className={`btn ${info ? "btn--primary" : "btn--danger"}`}
          onClick={() => { spec.onConfirm(); onClose(); }}
        >
          {spec.confirm}
        </button>
      </div>
    </Scrim>
  );
}
