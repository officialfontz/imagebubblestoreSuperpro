// ── Messages to customers, from templates ─────────────────────────────────────
// The same five messages go out all day: order confirmed, delivered, queue,
// review, sorry. A template holds the wording; {ช่อง} in it are filled from a
// short form; the date, the time and the polite ending fill themselves.

export type Template = { id: string; name: string; body: string };

export type TemplateSettings = {
  templates: Template[];
  activeId: string;
  /** What was typed into the fields last time, by field name. */
  values: Record<string, string>;
  /** ค่ะ or ครับ — fills {ค่ะ} and {คะ} in every template. */
  ending: "f" | "m";
};

const T = (id: string, name: string, body: string): Template => ({ id, name, body });

export const DEFAULT_TEMPLATES: Template[] = [
  T("confirm", "ยืนยันออเดอร์",
    "สวัสดี{ค่ะ}คุณ {ชื่อลูกค้า} 🫧\nยืนยันออเดอร์ {สินค้า} ราคา {ราคา} บาท{ค่ะ}\nโอนแล้วส่งสลิปมาได้เลยนะ{คะ} ทีมงานจะเริ่มดำเนินการทันที ⏱ ใช้เวลาประมาณ {เวลารอ}"),
  T("delivered", "ส่งของแล้ว",
    "ส่ง {สินค้า} ให้เรียบร้อยแล้ว{ค่ะ} ✅\nชื่อในเกม: {ชื่อในเกม}\nเช็กในเกมได้เลยนะ{คะ} ถ้ายังไม่ขึ้นลองออก-เข้าเกมใหม่ 1 รอบ\nขอบคุณที่อุดหนุน Bubble Shop {ค่ะ} 💜"),
  T("queue", "แจ้งรอคิว",
    "ตอนนี้มีคิวก่อนหน้า {จำนวนคิว} คิว{ค่ะ}\nคาดว่าจะได้รับภายใน {เวลารอ} ขอบคุณที่รอนะ{คะ} 🙏"),
  T("review", "ขอรีวิว",
    "ถ้าได้รับของครบแล้ว รบกวนรีวิวให้ร้านหน่อยนะ{คะ} 🌟\n{ลิงก์รีวิว}\nรีวิวแล้วรับส่วนลด {ส่วนลด} ในออเดอร์ถัดไป{ค่ะ}"),
  T("sorry", "แจ้งเลื่อน",
    "ขออภัย{ค่ะ}คุณ {ชื่อลูกค้า} 🙏\n{สินค้า} ติดปัญหา {สาเหตุ}\nทีมงานจะส่งให้ภายใน {เวลารอ} {ค่ะ} ขอบคุณที่เข้าใจนะ{คะ}"),
];

/** A fresh template with a greeting to start from. */
export const newTemplate = (): Template =>
  ({ id: Math.random().toString(36).slice(2), name: "ข้อความใหม่", body: "สวัสดี{ค่ะ}คุณ {ชื่อลูกค้า}\n" });

export const DEFAULT_TEMPLATE_SETTINGS: TemplateSettings = {
  templates: DEFAULT_TEMPLATES, activeId: "confirm", values: {}, ending: "f",
};

/** Fields that fill themselves; they never appear in the form. */
export const AUTO_FIELDS = ["ค่ะ", "คะ", "วันที่", "เวลา"] as const;

const FIELD_RE = /\{([^{}\n]{1,30})\}/g;

/** The fields a template asks for, in order of first appearance, no repeats. */
export function fieldsOf(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(FIELD_RE)) {
    const name = m[1].trim();
    if (!name || seen.has(name) || (AUTO_FIELDS as readonly string[]).includes(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

const thaiDate = (d: Date) => d.toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit", timeZone: "Asia/Bangkok" });
const thaiTime = (d: Date) => d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });

/** The template with every field filled; an empty field is left as {ช่อง} so it is seen. */
export function render(body: string, values: Record<string, string>, ending: "f" | "m", now = new Date()): string {
  const auto: Record<string, string> = {
    "ค่ะ": ending === "f" ? "ค่ะ" : "ครับ",
    "คะ": ending === "f" ? "คะ" : "ครับ",
    "วันที่": thaiDate(now),
    "เวลา": thaiTime(now),
  };
  return body.replace(FIELD_RE, (whole, raw: string) => {
    const name = raw.trim();
    if (name in auto) return auto[name];
    const v = values[name]?.trim();
    return v ? v : whole;
  });
}

/** True while some {ช่อง} is still unfilled. */
export const unfilled = (text: string) => FIELD_RE.test(text) && ((FIELD_RE.lastIndex = 0), true);
