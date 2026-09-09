"use client";

// ── Templates ─────────────────────────────────────────────────────────────────
// Pick a message, fill the two or three blanks, copy, paste in the chat. The
// wording lives in the template and is edited in place; the blanks are
// whatever {ช่อง} the wording contains, so a new blank is typed, not
// configured. The polite ending follows whoever is at the keyboard.

import { useState, useSyncExternalStore } from "react";
import { Copy, Check, Plus, Trash2, RotateCcw, MessageSquareText, Pencil } from "lucide-react";
import {
  DEFAULT_TEMPLATES, DEFAULT_TEMPLATE_SETTINGS, fieldsOf, newTemplate, render, unfilled,
  type Template, type TemplateSettings,
} from "@/lib/templates";
import { settingsStore } from "@/lib/settings-store";
import { copyText } from "./ui";

const store = settingsStore<TemplateSettings>("bv.templates.v1", DEFAULT_TEMPLATE_SETTINGS);

// The clock, as an external store: {วันที่} and {เวลา} follow it, one tick a
// minute. Reading Date in render would be impure; reading it through a store
// snapshot is the sanctioned way.
const minuteNow = () => Math.floor(Date.now() / 60_000);
const tickEveryMinute = (fn: () => void) => { const id = setInterval(fn, 15_000); return () => clearInterval(id); };
const useMinute = () => useSyncExternalStore(tickEveryMinute, minuteNow, () => 0);

export default function TemplateTool() {
  const s = store.use();
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const minute = useMinute();

  const active = s.templates.find((t) => t.id === s.activeId) ?? s.templates[0];
  const fields = active ? fieldsOf(active.body) : [];
  const text = active ? render(active.body, s.values, s.ending, new Date(minute * 60_000)) : "";
  const missing = unfilled(text);

  const say = (t: string) => { setNote(t); setTimeout(() => setNote((n) => (n === t ? null : n)), 2500); };

  const patchTemplate = (patch: Partial<Template>) =>
    store.patch({ templates: s.templates.map((t) => (t.id === active.id ? { ...t, ...patch } : t)) });

  const addTemplate = () => {
    const t = newTemplate();
    store.patch({ templates: [...s.templates, t], activeId: t.id });
    setEditing(true);
  };
  const removeTemplate = () => {
    if (s.templates.length <= 1) { say("ต้องเหลืออย่างน้อย 1 ข้อความ"); return; }
    const rest = s.templates.filter((t) => t.id !== active.id);
    store.patch({ templates: rest, activeId: rest[0].id });
    setEditing(false);
  };
  const restoreDefaults = () => { store.patch({ templates: DEFAULT_TEMPLATES, activeId: DEFAULT_TEMPLATES[0].id }); setEditing(false); say("กลับเป็นชุดเริ่มต้นแล้ว"); };

  const copy = async () => {
    if (!text) return;
    const ok = await copyText(text);
    if (!ok) { say("คัดลอกไม่ได้ — เลือกข้อความแล้วกด Ctrl+C แทน"); return; }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
    say(missing ? "คัดลอกแล้ว — ยังมีช่องที่ไม่ได้เติมนะ" : "คัดลอกแล้ว — วางในแชตได้เลย");
  };

  if (!active) return null;

  return (
    <div className="tool tpl">
      <div className="tpl-tabs" role="tablist">
        {s.templates.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === active.id} data-on={t.id === active.id}
            onClick={() => { store.patch({ activeId: t.id }); setEditing(false); }}>
            {t.name}
          </button>
        ))}
        <button type="button" className="tpl-add" onClick={addTemplate} title="เพิ่มข้อความ"><Plus size={14} /> เพิ่ม</button>
      </div>

      <div className="tool-panes">
        <section className="pane">
          <div className="pane-head">
            <span>
              {editing
                ? <input className="tpl-name" value={active.name} maxLength={30} onChange={(e) => patchTemplate({ name: e.target.value })} aria-label="ชื่อข้อความ" />
                : <><MessageSquareText size={14} /> {active.name}</>}
              <i className="pane-badge" data-on={editing}>{editing ? "กำลังแก้" : "ต้นฉบับ"}</i>
            </span>
            <span className="tpl-headacts">
              {editing && <button type="button" className="iconbtn" onClick={removeTemplate} title="ลบข้อความนี้" aria-label="ลบข้อความนี้"><Trash2 size={14} /></button>}
              <button type="button" className="btn btn--sm" onClick={() => setEditing((v) => !v)}>
                <Pencil size={12} /> {editing ? "เสร็จ" : "แก้ถ้อยคำ"}
              </button>
            </span>
          </div>
          {editing ? (
            <>
              <textarea className="pane-body" value={active.body} onChange={(e) => patchTemplate({ body: e.target.value })} spellCheck={false} />
              <p className="tpl-hint">พิมพ์ <code>{"{ชื่อช่อง}"}</code> ตรงไหนก็ได้ จะกลายเป็นช่องให้เติม · <code>{"{ค่ะ}"}</code> <code>{"{คะ}"}</code> เปลี่ยนตามคำลงท้าย · <code>{"{วันที่}"}</code> <code>{"{เวลา}"}</code> เติมเองอัตโนมัติ</p>
            </>
          ) : (
            <div className="tpl-form">
              {fields.length === 0 && <p className="tpl-hint">ข้อความนี้ไม่มีช่องให้เติม คัดลอกได้เลย</p>}
              {fields.map((f) => (
                <label key={f} className="tpl-field">
                  <span>{f}</span>
                  <input
                    className="field" value={s.values[f] ?? ""} placeholder={`เติม ${f}`}
                    onChange={(e) => store.patch({ values: { ...s.values, [f]: e.target.value } })}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void copy(); } }}
                  />
                </label>
              ))}
              <div className="tpl-ending">
                <span className="f-lbl">คำลงท้าย</span>
                <div className="seg" role="radiogroup">
                  <button type="button" data-on={s.ending === "f"} onClick={() => store.patch({ ending: "f" })}>ค่ะ</button>
                  <button type="button" data-on={s.ending === "m"} onClick={() => store.patch({ ending: "m" })}>ครับ</button>
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="pane">
          <div className="pane-head">
            <span>ข้อความที่จะส่ง <span className="pane-count tnum">{text.length} ตัวอักษร</span></span>
            <i className="pane-badge" data-on={!missing}>{missing ? "ยังมีช่องว่าง" : "พร้อมส่ง"}</i>
          </div>
          <textarea className="pane-body tpl-out" value={text} readOnly onFocus={(e) => e.currentTarget.select()} />
        </section>
      </div>

      <div className="tool-foot">
        <button type="button" className="btn btn--primary" onClick={() => void copy()} disabled={!text}>
          {copied ? <Check size={15} /> : <Copy size={15} />} คัดลอกข้อความ
        </button>
        <button type="button" className="btn btn--sm" onClick={() => store.patch({ values: {} })} disabled={Object.keys(s.values).length === 0}>
          <RotateCcw size={13} /> ล้างช่อง
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={restoreDefaults}>ชุดเริ่มต้น</button>
        {note && <span className="shrink-note" style={{ marginLeft: "auto" }}>{note}</span>}
      </div>
    </div>
  );
}
