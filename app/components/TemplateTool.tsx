"use client";

// ── Replies ───────────────────────────────────────────────────────────────────
// Laid out like a chat app: the list of replies on the left, the chosen one
// on the right as the bubble the customer will see, and one big copy button.
// Arrow keys walk the list, Enter copies, a digit copies that row outright.
// The whole notepad can be pasted in and becomes cards, one per paragraph.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, Plus, Trash2, RotateCcw, Pencil, ClipboardPaste, Search, X, Copy, ArrowUp, ArrowDown } from "lucide-react";
import {
  DEFAULT_REPLIES, DEFAULT_REPLY_SETTINGS, GROUPS, GROUP_LABEL, fieldsOf, matches, newReply, render, splitNotepad, unfilled, unshortcode,
  type Reply, type ReplyGroup, type ReplySettings,
} from "@/lib/templates";
import { settingsStore } from "@/lib/settings-store";
import { loadReplies, saveReplies } from "@/lib/capture-actions";
import { copyText } from "./ui";

const store = settingsStore<ReplySettings>("bv.replies.v2", DEFAULT_REPLY_SETTINGS);
/** Set once this browser's own cards have been folded into the shared set. */
const MERGED_KEY = "bv.replies.merged.v1";

// The clock as an external store: {วันที่} and {เวลา} follow it.
const minuteNow = () => Math.floor(Date.now() / 60_000);
const tick = (fn: () => void) => { const id = setInterval(fn, 15_000); return () => clearInterval(id); };
const useMinute = () => useSyncExternalStore(tick, minuteNow, () => 0);

type Filter = ReplyGroup | "all";

export default function TemplateTool({ isOwner = false }: { isOwner?: boolean }) {
  const s = store.use();
  const minute = useMinute();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selId, setSelId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [importText, setImportText] = useState<string | null>(null);
  const [importGroup, setImportGroup] = useState<ReplyGroup>("general");
  const search = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const say = (t: string) => { setNote(t); setTimeout(() => setNote((n) => (n === t ? null : n)), 2200); };
  const now = new Date(minute * 60_000);

  // ── The shared set ─────────────────────────────────────────────────────────
  // The messages live in the vault, so a card written on one machine is there
  // on every other. What stays in this browser is only what was typed into
  // the blanks, the polite ending, and the count of what gets used most.
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pushReplies = (replies: Reply[]) => {
    store.patch({ replies });
    if (!isOwner) return;
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      void saveReplies(replies).then((res) => { if (!res.ok) say(res.error); }).catch(() => say("บันทึกขึ้นคลังไม่สำเร็จ"));
    }, 600);
  };

  /** Cards on this machine that the vault has never seen, waiting to go up. */
  const [unsynced, setUnsynced] = useState<Reply[]>([]);

  const pull = useCallback(() => {
    void loadReplies().then((remote) => {
      const local = store.read().replies;
      // Same card, written on two machines, is one card: match on the id, and
      // failing that on what it actually says.
      const said = (r: Reply) => `${r.name.trim()}\u0000${r.body.trim()}`;
      const known = new Set([...remote.map((r) => r.id), ...remote.map(said)]);
      const extra = local.filter((r) => !known.has(r.id) && !known.has(said(r)));

      // The first sync on this browser keeps whatever was typed here before
      // the set moved into the vault. After that the vault is the truth, so
      // deleting a card on one machine really deletes it.
      const firstSync = (() => {
        try { return !localStorage.getItem(MERGED_KEY); } catch { return false; }
      })();

      if (remote.length === 0) {
        // Nothing up there yet: this machine's set becomes the shared one.
        if (local.length > 0 && isOwner) void saveReplies(local).catch(() => undefined);
        return;
      }

      if (firstSync && extra.length > 0) {
        const merged = [...extra, ...remote];
        store.patch({ replies: merged });
        if (isOwner) {
          void saveReplies(merged).then((res) => {
            if (res.ok) {
              try { localStorage.setItem(MERGED_KEY, "1"); } catch { /* private mode */ }
              setUnsynced([]);
              say(`รวมข้อความในเครื่องนี้ ${extra.length} ใบขึ้นคลังแล้ว`);
            } else {
              setUnsynced(extra);
            }
          }).catch(() => setUnsynced(extra));
        } else {
          // A staff session cannot write: keep them visible here and say so,
          // rather than dropping what someone typed.
          setUnsynced(extra);
        }
        return;
      }

      try { localStorage.setItem(MERGED_KEY, "1"); } catch { /* private mode */ }
      setUnsynced([]);
      if (JSON.stringify(remote) !== JSON.stringify(local)) store.patch({ replies: remote });
    }).catch(() => undefined);
  }, [isOwner]);

  useEffect(() => {
    pull();
    const onFocus = () => pull();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [pull]);

  const visible = s.replies.filter((r) => (filter === "all" || r.group === filter) && matches(r, q));
  // The selection follows the list: whatever is chosen if it is still on
  // screen, else the first row.
  const sel = visible.find((r) => r.id === selId) ?? visible[0] ?? null;
  const fields = sel ? fieldsOf(sel.body) : [];
  const text = sel ? render(sel.body, s.values, s.ending, now) : "";
  const missing = unfilled(text);

  const copy = async (r: Reply) => {
    const t = render(r.body, s.values, s.ending, now);
    if (!(await copyText(t))) { say("คัดลอกไม่ได้"); return; }
    store.patch({ uses: { ...(s.uses ?? {}), [r.id]: (s.uses?.[r.id] ?? 0) + 1 } });
    setSelId(r.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    say(unfilled(t) ? "คัดลอกแล้ว — ยังมีช่องที่ไม่ได้เติมนะ" : `คัดลอก “${r.name}” แล้ว — วางได้เลย`);
  };
  const pick = (r: Reply) => { setSelId(r.id); setEditing(false); };

  const step = (d: 1 | -1) => {
    if (!visible.length) return;
    const i = Math.max(0, visible.findIndex((r) => r.id === sel?.id));
    const n = visible[(i + d + visible.length) % visible.length];
    setSelId(n.id);
    listRef.current?.querySelector<HTMLElement>(`[data-id="${n.id}"]`)?.scrollIntoView({ block: "nearest" });
  };

  // Keys: ↑↓ walk, Enter copies the chosen one, 1–9 copy a row, Esc clears.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === "TEXTAREA" || t.tagName === "SELECT" || (t.tagName === "INPUT" && t !== search.current);
      if (typing || editing || importText !== null) return;
      if (e.key === "Escape") { setQ(""); search.current?.focus(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); step(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); step(-1); return; }
      if (e.key === "Enter" && sel) { e.preventDefault(); void copy(sel); return; }
      if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const r = visible[Number(e.key) - 1];
        if (r) { e.preventDefault(); void copy(r); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const patchReply = (id: string, patch: Partial<Reply>) => pushReplies(s.replies.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const add = () => {
    const r = newReply(filter === "all" ? "general" : filter);
    pushReplies([r, ...s.replies]);
    setQ(""); setSelId(r.id); setEditing(true);
  };
  const remove = (id: string) => { pushReplies(s.replies.filter((r) => r.id !== id)); setEditing(false); };
  const move = (id: string, dir: -1 | 1) => {
    const i = s.replies.findIndex((r) => r.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= s.replies.length) return;
    const next = [...s.replies];
    [next[i], next[j]] = [next[j], next[i]];
    pushReplies(next);
  };
  const doImport = () => {
    const cards = splitNotepad(importText ?? "", importGroup);
    if (!cards.length) { say("ไม่พบข้อความ — เว้นบรรทัดว่างระหว่างข้อความ"); return; }
    pushReplies([...cards, ...s.replies]);
    setImportText(null);
    setSelId(cards[0].id);
    say(`เพิ่ม ${cards.length} ข้อความจากโน้ตแล้ว`);
  };

  const firstLine = (r: Reply) => r.body.split("\n").find((l) => l.trim()) ?? "";

  return (
    <div className="rp">
      <aside className="rp-list">
        <label className="rp-search">
          <Search size={14} />
          <input ref={search} value={q} onChange={(e) => { setQ(e.target.value); setEditing(false); }} autoFocus placeholder="พิมพ์ค้นหา…" />
          {q && <button type="button" onClick={() => setQ("")} aria-label="ล้าง"><X size={13} /></button>}
        </label>
        <div className="rp-groups" role="radiogroup">
          {(["all", ...GROUPS] as Filter[]).map((g) => (
            <button key={g} type="button" data-on={filter === g} onClick={() => setFilter(g)}>
              {g === "all" ? "ทั้งหมด" : GROUP_LABEL[g]}
              <small className="tnum">{g === "all" ? s.replies.length : s.replies.filter((r) => r.group === g).length}</small>
            </button>
          ))}
        </div>
        {unsynced.length > 0 && (
          <div className="rp-unsynced">
            <b>{unsynced.length} ข้อความในเครื่องนี้ยังไม่ขึ้นคลัง</b>
            {isOwner ? (
              <button type="button" className="btn btn--sm btn--primary" onClick={() => {
                const merged = [...unsynced, ...s.replies.filter((r) => !unsynced.some((u) => u.id === r.id))];
                pushReplies(merged);
                try { localStorage.setItem(MERGED_KEY, "1"); } catch { /* private mode */ }
                setUnsynced([]);
                say("อัปขึ้นคลังแล้ว — เครื่องอื่นจะเห็นด้วย");
              }}>อัปขึ้นคลัง</button>
            ) : (
              <span>ให้เจ้าของร้านเปิดหน้านี้จากเครื่องนี้</span>
            )}
          </div>
        )}
        <div className="rp-rows" ref={listRef}>
          {visible.length === 0 && <p className="rp-empty">ไม่พบ “{q}”</p>}
          {visible.map((r, i) => (
            <button key={r.id} type="button" className="rp-row" data-id={r.id} data-on={r.id === sel?.id} data-group={r.group}
              onClick={() => pick(r)} onDoubleClick={() => void copy(r)}>
              <kbd>{i < 9 ? i + 1 : ""}</kbd>
              <span className="rp-row-text"><b>{r.name}</b><small>{firstLine(r)}</small></span>
              {fieldsOf(r.body).length > 0 && <i className="rp-dot" title="มีช่องให้เติม" />}
            </button>
          ))}
        </div>
        {isOwner ? (
          <div className="rp-list-foot">
            <button type="button" className="btn btn--sm" onClick={() => setImportText("")}><ClipboardPaste size={13} /> วางจากโน้ต</button>
            <button type="button" className="btn btn--sm" onClick={add}><Plus size={13} /> เพิ่ม</button>
          </div>
        ) : (
          <p className="rp-shared">ชุดข้อความของร้าน — เจ้าของร้านเป็นคนแก้</p>
        )}
      </aside>

      <section className="rp-pane">
        {importText !== null ? (
          <div className="rp-import">
            <b>วางทั้งโน้ตลงมาได้เลย</b>
            <span>เว้นบรรทัดว่างระหว่างข้อความ แต่ละก้อนจะกลายเป็นข้อความหนึ่งใบ · :purple_heart: แบบนี้จะแปลงเป็นอีโมจิให้</span>
            <textarea value={importText} onChange={(e) => setImportText(e.target.value)} rows={12} autoFocus placeholder="สวัสดีครับ Bubble Shop…&#10;&#10;📦รับออเดอร์แล้วครับ…" />
            <div className="rp-import-foot">
              <div className="seg seg--text" role="radiogroup">
                {GROUPS.map((g) => <button key={g} type="button" data-on={importGroup === g} onClick={() => setImportGroup(g)}>{GROUP_LABEL[g]}</button>)}
              </div>
              <span className="tnum">{splitNotepad(importText, importGroup).length} ข้อความ</span>
              <span style={{ flex: 1 }} />
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setImportText(null)}>ยกเลิก</button>
              <button type="button" className="btn btn--primary btn--sm" onClick={doImport}>เพิ่มเข้ารายการ</button>
            </div>
          </div>
        ) : !sel ? (
          <div className="rp-blank">
            <b>ยังไม่มีข้อความ</b>
            <span>{isOwner ? "กด “วางจากโน้ต” เพื่อย้ายทั้งชุดมาทีเดียว หรือ “เพิ่ม” ทีละใบ" : "เจ้าของร้านยังไม่ได้ใส่ข้อความ"}</span>
          </div>
        ) : editing ? (
          <div className="rp-edit">
            <div className="rp-edit-head">
              <input className="rp-name" value={sel.name} maxLength={28} onChange={(e) => patchReply(sel.id, { name: e.target.value })} placeholder="ชื่อข้อความ" autoFocus />
              <select value={sel.group} onChange={(e) => patchReply(sel.id, { group: e.target.value as ReplyGroup })}>
                {GROUPS.map((g) => <option key={g} value={g}>{GROUP_LABEL[g]}</option>)}
              </select>
            </div>
            <textarea value={sel.body} onChange={(e) => patchReply(sel.id, { body: unshortcode(e.target.value) })} spellCheck={false} placeholder="พิมพ์ข้อความ… ใส่ {ชื่อช่อง} ตรงไหนก็ได้จะกลายเป็นช่องให้เติม" />
            <p className="rp-hint">
              <code>{"{ราคา}"}</code> แบบนี้ = ช่องให้เติมก่อนคัดลอก · <code>{"{ค่ะ}"}</code> <code>{"{คะ}"}</code> เปลี่ยนตามคำลงท้าย · <code>{"{วันที่}"}</code> <code>{"{เวลา}"}</code> เติมเองอัตโนมัติ
            </p>
            <div className="rp-edit-foot">
              <button type="button" className="btn btn--sm" onClick={() => move(sel.id, -1)}><ArrowUp size={13} /> เลื่อนขึ้น</button>
              <button type="button" className="btn btn--sm" onClick={() => move(sel.id, 1)}><ArrowDown size={13} /> เลื่อนลง</button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => remove(sel.id)}><Trash2 size={13} /> ลบ</button>
              <span style={{ flex: 1 }} />
              <button type="button" className="btn btn--primary btn--sm" onClick={() => setEditing(false)}><Check size={13} /> เสร็จ</button>
            </div>
          </div>
        ) : (
          <>
            <header className="rp-pane-head">
              <b>{sel.name}</b>
              <span className="rp-chip" data-group={sel.group}>{GROUP_LABEL[sel.group]}</span>
              {(s.uses?.[sel.id] ?? 0) > 0 && <span className="rp-chip">ใช้ {s.uses![sel.id]} ครั้ง</span>}
              <span style={{ flex: 1 }} />
              {isOwner && <button type="button" className="btn btn--sm" onClick={() => setEditing(true)}><Pencil size={12} /> แก้ถ้อยคำ</button>}
            </header>

            {fields.length > 0 && (
              <div className="rp-fill">
                {fields.map((f, k) => (
                  <label key={f}>
                    <span>{f}</span>
                    <input className="field" value={s.values[f] ?? ""} placeholder={`เติม ${f}`} autoFocus={k === 0}
                      onChange={(e) => store.patch({ values: { ...s.values, [f]: e.target.value } })}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void copy(sel); } }} />
                  </label>
                ))}
              </div>
            )}

            <div className="rp-bubble" data-copied={copied}>{text}</div>

            <div className="rp-pane-foot">
              <button type="button" className="btn btn--primary btn--lg" onClick={() => void copy(sel)}>
                {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? "คัดลอกแล้ว" : "คัดลอก · Enter"}
              </button>
              {note && <span className="rp-note">{note}</span>}
              {!note && missing && <span className="rp-note rp-note--warn">ยังมีช่องว่าง — เติมด้านบนก่อน</span>}
              <span style={{ flex: 1 }} />
              <span className="rp-keys">↑↓ เลื่อน · Enter คัดลอก · 1–9 คัดลอกทันที · Esc ล้างค้นหา</span>
            </div>
            <div className="rp-pane-foot rp-pane-foot--dim">
              <div className="seg seg--text" role="radiogroup" title="คำลงท้ายสำหรับ {ค่ะ} {คะ}">
                <button type="button" data-on={s.ending === "m"} onClick={() => store.patch({ ending: "m" })}>ครับ</button>
                <button type="button" data-on={s.ending === "f"} onClick={() => store.patch({ ending: "f" })}>ค่ะ</button>
              </div>
              <span style={{ flex: 1 }} />
              {isOwner && (
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => { pushReplies(DEFAULT_REPLIES); say("กลับเป็นชุดเริ่มต้นแล้ว"); }}>
                  <RotateCcw size={13} /> ชุดเริ่มต้น
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
