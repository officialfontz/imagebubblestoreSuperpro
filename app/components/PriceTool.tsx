"use client";

// ── Price ─────────────────────────────────────────────────────────────────────
// A customer sends a game pass, or three; the staff answers with baht. The
// rate is the shop's for the day; the answer rounds up to whole baht; the
// copied message is ready to paste. One box for a single quick number, rows
// for a list.

import { useState } from "react";
import { Copy, Check, Plus, X, ArrowLeftRight, Calculator } from "lucide-react";
import { DEFAULT_PRICE, RATE_CHIPS, bahtOf, newItem, quote, robuxOf, type PriceItem, type PriceSettings } from "@/lib/price";
import { settingsStore } from "@/lib/settings-store";
import { copyText } from "./ui";

const store = settingsStore<PriceSettings>("bv.price.v1", DEFAULT_PRICE);

const money = (n: number) => n.toLocaleString("th-TH", { maximumFractionDigits: 2 });

export default function PriceTool() {
  const s = store.use();
  const [items, setItems] = useState<PriceItem[]>(() => [newItem()]);
  const [reverse, setReverse] = useState<number | "">("");
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const say = (t: string) => { setNote(t); setTimeout(() => setNote((n) => (n === t ? null : n)), 2500); };

  const patchItem = (id: string, patch: Partial<PriceItem>) => setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const addItem = () => setItems((prev) => [...prev, newItem()]);
  const removeItem = (id: string) => setItems((prev) => (prev.length > 1 ? prev.filter((i) => i.id !== id) : [newItem()]));

  const live = items.filter((i) => typeof i.robux === "number" && i.robux > 0);
  const total = live.reduce((n, i) => n + bahtOf(i.robux as number, s), 0);
  const text = quote(items, s);

  const copy = async () => {
    if (!text) return;
    if (!(await copyText(text))) { say("คัดลอกไม่ได้"); return; }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
    say("คัดลอกแล้ว — วางในแชตได้เลย");
  };

  return (
    <div className="shrink price">
      <div className="price-main">
        <div className="price-hero">
          <span className="f-lbl">เรตวันนี้ · Robux ÷ เรต = บาท</span>
          <div className="price-rate">
            <input
              type="number" min={1} max={20} step={0.1} value={s.rate}
              onChange={(e) => store.patch({ rate: Math.max(0.1, Number(e.target.value) || 0) })}
              aria-label="เรต"
            />
            <small>Robux ต่อ 1 บาท</small>
          </div>
          <div className="shrink-chips">
            {RATE_CHIPS.map((r) => (
              <button key={r} type="button" data-on={s.rate === r} onClick={() => store.patch({ rate: r })}>เรต {r}</button>
            ))}
          </div>
          <label className="check" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={s.roundUp} onChange={(e) => store.patch({ roundUp: e.target.checked })} />
            ปัดขึ้นเป็นบาทเต็ม <span className="check-note">25.70 → 26</span>
          </label>
        </div>

        <div className="price-list">
          <span className="f-lbl">รายการ</span>
          {items.map((it, idx) => {
            const baht = typeof it.robux === "number" ? bahtOf(it.robux, s) : 0;
            return (
              <div className="price-row" key={it.id}>
                <input
                  className="field" placeholder={`ชื่อสินค้า / Game Pass ${idx + 1}`} value={it.name}
                  onChange={(e) => patchItem(it.id, { name: e.target.value })}
                />
                <input
                  className="field tnum" type="number" min={0} inputMode="numeric" placeholder="Robux"
                  value={it.robux}
                  onChange={(e) => patchItem(it.id, { robux: e.target.value === "" ? "" : Math.max(0, Number(e.target.value)) })}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (idx === items.length - 1) addItem(); } }}
                />
                <b className="price-baht tnum" data-on={baht > 0}>{baht > 0 ? `${money(baht)} ฿` : "—"}</b>
                <button type="button" className="iconbtn" onClick={() => removeItem(it.id)} title="เอาออก" aria-label="เอาออก"><X size={14} /></button>
              </div>
            );
          })}
          <button type="button" className="shrink-more" onClick={addItem}><Plus size={13} /> เพิ่มรายการ · หรือกด Enter ในช่อง Robux</button>
        </div>

        <div className="price-reverse">
          <ArrowLeftRight size={14} />
          <span>กลับด้าน:</span>
          <input
            className="field tnum" type="number" min={0} placeholder="บาท" value={reverse}
            onChange={(e) => setReverse(e.target.value === "" ? "" : Math.max(0, Number(e.target.value)))}
          />
          <b className="tnum">{typeof reverse === "number" && reverse > 0 ? `= ${money(robuxOf(reverse, s))} Robux` : "= … Robux"}</b>
        </div>
      </div>

      <div className="shrink-side">
        <div className="price-total">
          <span className="f-lbl">รวม</span>
          <b className="tnum">{money(total)} <small>บาท</small></b>
          <span>{live.length} รายการ · เรต {s.rate}{s.roundUp ? " · ปัดขึ้น" : ""}</span>
        </div>

        <div>
          <span className="f-lbl">ข้อความให้ลูกค้า</span>
          <div className="seg seg--full" role="radiogroup">
            <button type="button" data-on={s.itemised} onClick={() => store.patch({ itemised: true })}>แยกรายการ</button>
            <button type="button" data-on={!s.itemised} onClick={() => store.patch({ itemised: false })}>ยอดรวมอย่างเดียว</button>
          </div>
          <textarea className="price-out" value={text} readOnly placeholder="ใส่ Robux ในรายการ ข้อความจะขึ้นตรงนี้" onFocus={(e) => e.currentTarget.select()} />
        </div>

        <div className="shrink-foot">
          {note && <p className="shrink-note">{note}</p>}
          <button type="button" className="btn btn--primary btn--lg" disabled={!text} onClick={() => void copy()}>
            {copied ? <Check size={16} /> : <Copy size={16} />} คัดลอกข้อความ · วางได้เลย
          </button>
          <button type="button" className="btn" onClick={() => { setItems([newItem()]); setReverse(""); }}><Calculator size={15} /> เริ่มใหม่</button>
        </div>
      </div>
    </div>
  );
}
