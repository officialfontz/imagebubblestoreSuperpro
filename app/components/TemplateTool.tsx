"use client";

// ── Replies ───────────────────────────────────────────────────────────────────
// A board of cards. Click one and it is in the clipboard; type to find one;
// press its number to copy without the mouse. A card with {ช่อง} blanks
// opens a short form first. The whole notepad can be pasted in at once and
// becomes cards, one per paragraph.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, Plus, Trash2, RotateCcw, Pencil, ClipboardPaste, Search, X } from "lucide-react";
import {
  DEFAULT_REPLIES, DEFAULT_REPLY_SETTINGS, GROUPS, GROUP_LABEL, fieldsOf, matches, newReply, render, splitNotepad, unfilled, unshortcode,
  type Reply, type ReplyGroup, type ReplySettings,
} from "@/lib/templates";
import { settingsStore } from "@/lib/settings-store";
import { copyText } from "./ui";

const store = settingsStore<ReplySettings>("bv.replies.v2", DEFAULT_REPLY_SETTINGS);

// The clock as an external store: {วันที่} and {เวลา} follow it.
const minuteNow = () => Math.floor(Date.now() / 60_000);
const tick = (fn: () => void) => { const id = setInterval(fn, 15_000); return () => clearInterval(id); };
const useMinute = () => useSyncExternalStore(tick, minuteNow, () => 0);

type Filter = ReplyGroup | "all";

export default function TemplateTool() {
  const s = store.use();
  const minute = useMinute();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState<string | null>(null);       // card with its blanks form shown
  const [flash, setFlash] = useState<string | null>(null);     // card just copied
  const [note, setNote] = useState<string | null>(null);
  const [importText, setImportText] = useState<string | null>(null);
  const [importGroup, setImportGroup] = useState<ReplyGroup>("general");
  const search = useRef<HTMLInputElement>(null);

  const say = (t: string) => { setNote(t); setTimeout(() => setNote((n) => (n === t ? null : n)), 2200); };
  const now = new Date(minute * 60_000);

  const visible = s.replies.filter((r) => (filter === "all" || r.group === filter) && matches(r, q));

  const textOf = (r: Reply) => render(r.body, s.values, s.ending, now);

  const copy = async (r: Reply) => {
    const text = textOf(r);
    if (!(await copyText(text))) { say("คัดลอกไม่ได้"); return; }
    setFlash(r.id);
    setTimeout(() => setFlash((f) => (f === r.id ? null : f)), 1400);
    say(unfilled(text) ? "คัดลอกแล้ว — ยังมีช่องที่ไม่ได้เติมนะ" : `คัดลอก "${r.name}" แล้ว — วางได้เลย`);
  };
  // The one click: a plain card copies; a card with blanks opens its form.
  const tap = (r: Reply) => {
    if (editing) return;
    if (fieldsOf(r.body).length && open !== r.id) { setOpen(r.id); return; }
    void copy(r);
  };

  // Digits copy the nth card on screen; Enter copies the first; Esc clears.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && t !== search.current);
      if (typing || editing || importText !== null) return;
      if (e.key === "Escape") { setQ(""); setOpen(null); search.current?.focus(); return; }
      if (e.key === "Enter" && t === search.current && visible[0]) { e.preventDefault(); tap(visible[0]); return; }
      if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const r = visible[Number(e.key) - 1];
        if (r) { e.preventDefault(); tap(r); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const patchReply = (id: string, patch: Partial<Reply>) => store.patch({ replies: s.replies.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  const add = () => { store.patch({ replies: [newReply(filter === "all" ? "general" : filter), ...s.replies] }); setEditing(true); };
  const remove = (id: string) => store.patch({ replies: s.replies.filter((r) => r.id !== id) });
  const move = (id: string, dir: -1 | 1) => {
    const i = s.replies.findIndex((r) => r.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= s.replies.length) return;
    const next = [...s.replies];
    [next[i], next[j]] = [next[j], next[i]];
    store.patch({ replies: next });
  };
  const doImport = () => {
    const cards = splitNotepad(importText ?? "", importGroup);
    if (!cards.length) { say("ไม่พบข้อความ — เว้นบรรทัดว่างระหว่างข้อความ"); return; }
    store.patch({ replies: [...cards, ...s.replies] });
    setImportText(null);
    say(`เพิ่ม ${cards.length} การ์ดจากโน้ตแล้ว`);
  };

  return (
    <div className="tool rp">
      <div className="rp-bar">
        <label className="rp-search">
          <Search size={14} />
          <input
            ref={search} value={q} onChange={(e) => setQ(e.target.value)} autoFocus
            placeholder="พิมพ์ค้นหา… แล้วกด Enter หรือกดเลข 1–9 เพื่อคัดลอกทันที"
          />
          {q && <button type="button" onClick={() => setQ("")} aria-label="ล้าง"><X size={13} /></button>}
        </label>
        <div className="seg" role="radiogroup">
          {(["all", ...GROUPS] as Filter[]).map((g) => (
            <button key={g} type="button" data-on={filter === g} onClick={() => setFilter(g)}>
              {g === "all" ? "ทั้งหมด" : GROUP_LABEL[g]}
              <small className="tnum">{g === "all" ? s.replies.length : s.replies.filter((r) => r.group === g).length}</small>
            </button>
          ))}
        </div>
        <div className="rp-acts">
          <button type="button" className="btn btn--sm" onClick={() => setImportText("")}><ClipboardPaste size={13} /> วางจากโน้ต</button>
          <button type="button" className="btn btn--sm" onClick={add}><Plus size={13} /> เพิ่ม</button>
          <button type="button" className="btn btn--sm" data-on={editing} onClick={() => { setEditing((v) => !v); setOpen(null); }}>
            <Pencil size={13} /> {editing ? "เสร็จ" : "แก้ไข"}
          </button>
        </div>
      </div>

      {note && <p className="rp-note">{note}</p>}

      {importText !== null && (
        <div className="rp-import">
          <b>วางทั้งโน้ตลงมาได้เลย</b>
          <span>เว้นบรรทัดว่างระหว่างข้อความ แต่ละก้อนจะกลายเป็นการ์ด · :purple_heart: แบบนี้จะแปลงเป็นอีโมจิให้</span>
          <textarea value={importText} onChange={(e) => setImportText(e.target.value)} rows={8} autoFocus placeholder="สวัสดีครับ Bubble Shop…&#10;&#10;📦รับออเดอร์แล้วครับ…" />
          <div className="rp-import-foot">
            <div className="seg" role="radiogroup">
              {GROUPS.map((g) => <button key={g} type="button" data-on={importGroup === g} onClick={() => setImportGroup(g)}>{GROUP_LABEL[g]}</button>)}
            </div>
            <span className="tnum">{splitNotepad(importText, importGroup).length} การ์ด</span>
            <button type="button" className="btn btn--primary btn--sm" onClick={doImport}>เพิ่มเป็นการ์ด</button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setImportText(null)}>ยกเลิก</button>
          </div>
        </div>
      )}

      <div className="rp-grid">
        {visible.length === 0 && <p className="rp-empty">ไม่พบ “{q}” — กด “เพิ่ม” หรือ “วางจากโน้ต”</p>}
        {visible.map((r, i) => {
          const fields = fieldsOf(r.body);
          const isOpen = open === r.id;
          const text = textOf(r);
          return (
            <article
              key={r.id} className="rp-card" data-copied={flash === r.id} data-open={isOpen} data-edit={editing} data-group={r.group}
              role={editing ? undefined : "button"} tabIndex={editing ? -1 : 0}
              onClick={() => tap(r)}
              onKeyDown={(e) => { if (!editing && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); tap(r); } }}
            >
              {i < 9 && !editing && <kbd>{i + 1}</kbd>}
              {editing ? (
                <div className="rp-edit" onClick={(e) => e.stopPropagation()}>
                  <div className="rp-edit-head">
                    <input className="rp-name" value={r.name} maxLength={28} onChange={(e) => patchReply(r.id, { name: e.target.value })} />
                    <select value={r.group} onChange={(e) => patchReply(r.id, { group: e.target.value as ReplyGroup })}>
                      {GROUPS.map((g) => <option key={g} value={g}>{GROUP_LABEL[g]}</option>)}
                    </select>
                  </div>
                  <textarea value={r.body} onChange={(e) => patchReply(r.id, { body: unshortcode(e.target.value) })} rows={5} spellCheck={false} />
                  <div className="rp-edit-foot">
                    <button type="button" className="iconbtn" onClick={() => move(r.id, -1)} title="เลื่อนขึ้น">↑</button>
                    <button type="button" className="iconbtn" onClick={() => move(r.id, 1)} title="เลื่อนลง">↓</button>
                    <span style={{ flex: 1 }} />
                    <button type="button" className="iconbtn" onClick={() => remove(r.id)} title="ลบการ์ด" aria-label="ลบการ์ด"><Trash2 size={14} /></button>
                  </div>
                </div>
              ) : (
                <>
                  <header>
                    <b>{r.name}</b>
                    <span className="rp-chip">{GROUP_LABEL[r.group]}{fields.length ? ` · ${fields.length} ช่อง` : ""}</span>
                  </header>
                  <p>{isOpen ? text : r.body}</p>
                  {isOpen && (
                    <div className="rp-fill" onClick={(e) => e.stopPropagation()}>
                      {fields.map((f, k) => (
                        <label key={f}>
                          <span>{f}</span>
                          <input
                            className="field" value={s.values[f] ?? ""} placeholder={`เติม ${f}`} autoFocus={k === 0}
                            onChange={(e) => store.patch({ values: { ...s.values, [f]: e.target.value } })}
                            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void copy(r); } }}
                          />
                        </label>
                      ))}
                      <button type="button" className="btn btn--primary btn--sm" onClick={() => void copy(r)}>คัดลอก · Enter</button>
                    </div>
                  )}
                  <span className="rp-done"><Check size={14} /> คัดลอกแล้ว</span>
                </>
              )}
            </article>
          );
        })}
      </div>

      <div className="tool-foot rp-foot">
        <span className="rp-hint">คลิกการ์ด = คัดลอก · เลข 1–9 = คัดลอกใบนั้น · Esc = ล้างค้นหา</span>
        <span style={{ flex: 1 }} />
        <div className="seg" role="radiogroup" title="คำลงท้ายสำหรับ {ค่ะ} {คะ}">
          <button type="button" data-on={s.ending === "m"} onClick={() => store.patch({ ending: "m" })}>ครับ</button>
          <button type="button" data-on={s.ending === "f"} onClick={() => store.patch({ ending: "f" })}>ค่ะ</button>
        </div>
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => { store.patch({ replies: DEFAULT_REPLIES }); say("กลับเป็นชุดเริ่มต้นแล้ว"); }}>
          <RotateCcw size={13} /> ชุดเริ่มต้น
        </button>
      </div>
    </div>
  );
}
