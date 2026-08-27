"use client";

// ── Find & replace ────────────────────────────────────────────────────────────
// Paste text in, list the substitutions, apply them all at once, copy the
// result. Rules run top to bottom, so a later rule sees what the earlier ones
// produced — which is what makes chained edits (fix a price, then fix the
// wording around it) behave the way you'd expect.
//
// Entirely client-side: nothing here touches the vault or the network.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Replace, Plus, X, Copy, Check, RotateCcw, ArrowDown, CornerDownLeft,
} from "lucide-react";
import { copyText } from "./ui";

type Rule = { id: string; find: string; replace: string };

type Options = {
  caseSensitive: boolean;
  /** \b-based, so it works for Latin and digits but not Thai — see the label. */
  wholeWord: boolean;
};

const STORAGE_KEY = "bv.textTool.v1";

const newRule = (): Rule => ({
  id: Math.random().toString(36).slice(2),
  find: "",
  replace: "",
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Applies every rule in order, reporting how many times each one actually fired
 * against the text as it stood when that rule ran.
 */
function applyRules(input: string, rules: Rule[], opts: Options): { output: string; hits: number[] } {
  let text = input;
  const hits: number[] = [];

  for (const rule of rules) {
    if (!rule.find) { hits.push(0); continue; }

    const body = escapeRegExp(rule.find);
    const pattern = opts.wholeWord ? `\\b${body}\\b` : body;
    let re: RegExp;
    try {
      re = new RegExp(pattern, opts.caseSensitive ? "g" : "gi");
    } catch {
      hits.push(0);
      continue;
    }

    hits.push(text.match(re)?.length ?? 0);
    // A literal replacement, so "$1" or "$&" in the replacement text stays
    // literal instead of turning into a capture-group reference.
    text = text.replace(re, () => rule.replace);
  }

  return { output: text, hits };
}

/**
 * Reads the saved rules. Safe to call during render: this component only ever
 * mounts after the user clicks into the tool, which is necessarily after
 * hydration, so there is no server pass to disagree with.
 */
function loadSaved(): { rules: Rule[]; opts: Options } {
  const fallback = { rules: [newRule()], opts: { caseSensitive: false, wholeWord: false } };
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return fallback;
    const parsed = JSON.parse(saved) as { rules?: Rule[]; opts?: Options };
    return {
      rules: Array.isArray(parsed.rules) && parsed.rules.length ? parsed.rules : fallback.rules,
      opts: parsed.opts ?? fallback.opts,
    };
  } catch {
    return fallback; // corrupt or unavailable storage is not worth surfacing
  }
}

export default function TextTool() {
  const [input, setInput] = useState("");
  const [rules, setRules] = useState<Rule[]>(() => loadSaved().rules);
  const [opts, setOpts] = useState<Options>(() => loadSaved().opts);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ rules, opts }));
    } catch { /* private mode */ }
  }, [rules, opts]);

  // ── Derived ─────────────────────────────────────────────────────────────────
  const { output, hits } = useMemo(() => applyRules(input, rules, opts), [input, rules, opts]);
  const totalHits = hits.reduce((a, b) => a + b, 0);
  const changed = output !== input;

  const setRule = useCallback((id: string, patch: Partial<Rule>) => {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  const onCopy = useCallback(async () => {
    if (!output) return;
    const ok = await copyText(output);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }, [output]);

  return (
    <div className="tool">
      <div className="tool-head">
        <h2><Replace size={16} /> ค้นหา &amp; แทนที่</h2>
        <p>วางข้อความ ตั้งกฎการแทนที่ แล้วคัดลอกผลลัพธ์ไปใช้ — ทุกอย่างทำในเครื่องคุณ ไม่ส่งไปไหน</p>
      </div>

      {/* ── Rules ── */}
      <div className="tool-rules">
        {rules.map((rule, i) => (
          <div className="rule" key={rule.id}>
            <input
              className="field"
              value={rule.find}
              placeholder="ค้นหา…"
              aria-label={`ค้นหา กฎที่ ${i + 1}`}
              onChange={(e) => setRule(rule.id, { find: e.target.value })}
            />
            <CornerDownLeft size={14} className="rule-arrow" aria-hidden />
            <input
              className="field"
              value={rule.replace}
              placeholder="แทนด้วย… (เว้นว่าง = ลบทิ้ง)"
              aria-label={`แทนด้วย กฎที่ ${i + 1}`}
              onChange={(e) => setRule(rule.id, { replace: e.target.value })}
            />
            <span className="rule-hits tnum" data-on={hits[i] > 0}>
              {rule.find ? `${hits[i]} จุด` : "—"}
            </span>
            <button
              type="button"
              className="iconbtn"
              aria-label={`ลบกฎที่ ${i + 1}`}
              disabled={rules.length === 1}
              onClick={() => setRules((prev) => prev.filter((r) => r.id !== rule.id))}
            >
              <X size={15} />
            </button>
          </div>
        ))}

        <div className="tool-rulebar">
          <button type="button" className="btn btn--sm" onClick={() => setRules((prev) => [...prev, newRule()])}>
            <Plus size={13} /> เพิ่มกฎ
          </button>

          <label className="check">
            <input
              type="checkbox"
              checked={opts.caseSensitive}
              onChange={(e) => setOpts((o) => ({ ...o, caseSensitive: e.target.checked }))}
            />
            ตรงตัวพิมพ์เล็ก-ใหญ่
          </label>

          <label className="check" title="ใช้ได้กับอังกฤษและตัวเลข — ภาษาไทยไม่มีการเว้นคำ จึงไม่รองรับ">
            <input
              type="checkbox"
              checked={opts.wholeWord}
              onChange={(e) => setOpts((o) => ({ ...o, wholeWord: e.target.checked }))}
            />
            ทั้งคำเท่านั้น <span className="check-note">(อังกฤษ/ตัวเลข)</span>
          </label>

          <div style={{ flex: 1 }} />

          <button
            type="button"
            className="btn btn--sm btn--ghost"
            disabled={!input && rules.every((r) => !r.find)}
            onClick={() => { setInput(""); setRules([newRule()]); }}
          >
            <RotateCcw size={13} /> ล้างทั้งหมด
          </button>
        </div>
      </div>

      {/* ── Panes ── */}
      <div className="tool-panes">
        <div className="pane">
          <div className="pane-head">
            <span>ข้อความต้นฉบับ</span>
            <span className="pane-count tnum">{input.length.toLocaleString()} ตัวอักษร</span>
          </div>
          <textarea
            className="pane-body"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="วางข้อความตรงนี้…"
            spellCheck={false}
            aria-label="ข้อความต้นฉบับ"
          />
        </div>

        <div className="pane">
          <div className="pane-head">
            <span>
              ผลลัพธ์
              {input && (
                <em className="pane-badge" data-on={changed}>
                  {changed ? `แทนแล้ว ${totalHits} จุด` : "ไม่มีอะไรเปลี่ยน"}
                </em>
              )}
            </span>
            <span className="pane-count tnum">{output.length.toLocaleString()} ตัวอักษร</span>
          </div>
          <textarea
            className="pane-body"
            value={output}
            readOnly
            placeholder="ผลลัพธ์จะขึ้นตรงนี้อัตโนมัติ"
            spellCheck={false}
            aria-label="ผลลัพธ์"
          />
        </div>
      </div>

      <div className="tool-foot">
        <button
          type="button"
          className="btn"
          disabled={!changed}
          // Feeding the result back in makes a second pass with different rules
          // straightforward, instead of copy-pasting between the two panes.
          onClick={() => setInput(output)}
          title="เอาผลลัพธ์กลับไปเป็นต้นฉบับ เพื่อแทนต่ออีกรอบ"
        >
          <ArrowDown size={14} /> ใช้ผลลัพธ์เป็นต้นฉบับ
        </button>

        <div style={{ flex: 1 }} />

        <button type="button" className="btn btn--primary" disabled={!output} onClick={onCopy}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "คัดลอกแล้ว" : "คัดลอกผลลัพธ์"}
        </button>
      </div>
    </div>
  );
}
