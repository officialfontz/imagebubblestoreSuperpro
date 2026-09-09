"use client";

// ── The toolbox, laid out ─────────────────────────────────────────────────────
// Every tool as a card, by category. The first is lit: it is the one people
// come for. Planned tools sit greyed with "เร็ว ๆ นี้" rather than hidden, so
// the shape of the thing is visible before it is finished.

import { CATEGORY_LABEL, TOOL_DEFS, toolKey, type ToolCategory } from "@/lib/tools";

const ORDER: ToolCategory[] = ["image", "text", "shop"];

export default function ToolsHub({ onOpen }: { onOpen: (key: string) => void }) {
  let n = 0;
  return (
    <div className="hub">
      <p className="hub-sub">ทำงานในเบราว์เซอร์ทั้งหมด ไม่ต้องอัปโหลด ไม่รกคลัง ทุกคนในทีมใช้ได้</p>
      {ORDER.map((cat) => (
        <section className="hub-cat" key={cat}>
          <h2>{CATEGORY_LABEL[cat]}</h2>
          <div className="hub-grid">
            {TOOL_DEFS.filter((t) => t.category === cat).map((t) => {
              const ready = Boolean(t.component);
              const hot = ready ? ++n : 0;
              return (
                <button
                  key={t.slug}
                  type="button"
                  className="hub-tool"
                  data-hero={t.slug === "shrink"}
                  data-soon={!ready}
                  disabled={!ready}
                  onClick={() => onOpen(toolKey(t.slug))}
                >
                  {ready && hot <= 9 && <kbd>{hot}</kbd>}
                  <span className="hub-ic"><t.Icon size={18} /></span>
                  <b>{t.name}</b>
                  <p>{ready ? t.blurb : "เร็ว ๆ นี้"}</p>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
