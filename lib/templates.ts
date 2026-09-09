// ── Replies to customers ──────────────────────────────────────────────────────
// The shop answers the same twenty things all day, and until now they lived
// in a notepad. Here each one is a card: click, it is copied. A card may hold
// {ช่อง} blanks filled from a short form; the polite ending, the date and the
// time fill themselves. Cards are grouped — general, game pass, Robux — and
// found by typing.

export type ReplyGroup = "general" | "gamepass" | "robux";
export const GROUP_LABEL: Record<ReplyGroup, string> = { general: "ทั่วไป", gamepass: "เกมพาส", robux: "Robux" };
export const GROUPS: ReplyGroup[] = ["general", "gamepass", "robux"];

export type Reply = { id: string; name: string; body: string; group: ReplyGroup };

export type ReplySettings = {
  replies: Reply[];
  /** What was typed into the blanks last time, by blank name. */
  values: Record<string, string>;
  /** ค่ะ or ครับ — fills {ค่ะ} and {คะ}. */
  ending: "f" | "m";
  /** How many times each card was copied, by id — the busiest float up. */
  uses?: Record<string, number>;
};

const uid = () => Math.random().toString(36).slice(2);
const R = (name: string, group: ReplyGroup, body: string): Reply => ({ id: uid(), name, body, group });

// Slack/Discord :shortcodes: seen in the shop's notepad, to the emoji they
// mean — so a pasted card reads the same in LINE, Facebook and Discord.
const SHORTCODES: Record<string, string> = {
  eight_pointed_black_star: "✴️", busts_in_silhouette: "👥", small_orange_diamond: "🔸", small_blue_diamond: "🔹",
  purple_heart: "💜", heart: "❤️", two_hearts: "💕", sparkling_heart: "💖", eyes: "👀", package: "📦", sparkles: "✨",
  speech_left: "🗨️", speech_balloon: "💬", man_bowing: "🙇‍♂️", woman_bowing: "🙇‍♀️", bow: "🙇", receipt: "🧾", dizzy: "💫",
  tada: "🎉", star: "⭐", star2: "🌟", fire: "🔥", pray: "🙏", white_check_mark: "✅", warning: "⚠️", gift: "🎁",
  money_with_wings: "💸", moneybag: "💰", gem: "💎", crown: "👑", rocket: "🚀", hourglass: "⏳", alarm_clock: "⏰",
  point_right: "👉", point_down: "👇", ok_hand: "👌", thumbsup: "👍", "+1": "👍", smile: "😊", blush: "😊", wink: "😉",
  heart_eyes: "😍", cat: "🐱", bubbles: "🫧", cherry_blossom: "🌸", link: "🔗", bell: "🔔", clipboard: "📋",
};
export const unshortcode = (text: string) => text.replace(/:([a-z0-9_+-]+):/g, (m, k: string) => SHORTCODES[k] ?? m);

export const DEFAULT_REPLIES: Reply[] = [
  R("รับออเดอร์แล้ว", "general", "สวัสดีครั้บบ Bubble Shop มาให้บริการแล้ว 💜👀\n\n📦รับออเดอร์แล้วครับ\n✨รบกวนลูกค้ารอคิวสักครู่นะครับ~🙇‍♂️"),
  R("แอดเพื่อนแล้ว", "gamepass", "✴️แอดเพื่อนไปแล้วครับ👥MonkeyzV2\n🔸กดรับแอด แล้วกด Join ตามแอดมาได้เลย"),
  R("วิธีรับเกมพาส Blox Fruits", "gamepass", "วิธีรับเกมพาส Bloxfruit\nเข้าเกม > เปิด Shop > มุมซ้ายบนจะมีรูปกล่องของขวัญขึ้น > กดรับ\nหากไม่มีรูปกล่องขึ้น ให้ลองออกเกมแล้วเข้าใหม่ก่อนนะครับ"),
  R("ส่งสินค้าเรียบร้อย", "gamepass", "🙇‍♂️✨ส่งสินค้าเรียบร้อย กดเปิด Shop ในเกมแล้ว ไปรูป กล่องของขวัญเพื่อรับได้เลยนะครับ"),
  R("หาชื่อไม่เจอ", "gamepass", "เข้าลิ้งค์เซิฟตามมาได้ไหมครับเนื่องจากค้นหาชื่อในเกมไม่เจอ~"),
  R("เปิดคิวช่วงเที่ยง", "general", "🗨️วันนี้เกมพาสหน้าเพจแอดมินจะเปิดรับคิวช่วงเที่ยงเป็นต้นไปน้าา\nขออภัยในความไม่สะดวกด้วยครับลูกค้า🙇‍♂️"),
  R("เปิดคิวบ่ายโมง", "general", "ร้านเปิดรับคิวหน้าเพจ บ่าย 1 ตอนนั้นมาจัดได้ไหมคับบ แต่ถ้ารีบ ก็ไม่เป็นไรน้าาา ขออภัยด้วยนะครับ🙇‍♂️"),
  R("ช้าหน่อย ลูกค้าเยอะ", "general", "ยังไง จะได้ช้าหน่อยนะครับ\nพอดีวันนี้ลูกค้าเยอะมากกเลยครับลูกค้า\nแล้วสต๊อกหมด แบบหมดทั้งตลาด\nแต่ตอนนี้มาแล้วครับ ทีมงานกำลังเร่งจัดส่งให้เลยด่วนๆ\nขออภัยที่ให้รอนานด้วยนะครับคุณลูกค้า 🙇‍♂️💜\nขอบพระคุณที่เลือกใช้ Bubble Shop💕"),
  R("ช้าหน่อย เกมอัปเดต", "general", "ได้เลยครับบ รอพนักงานจัดส่งให้น้าาา อาจจะล่าช้าหน่อย\nเนื่องจาก เกมอัพเดททำให้ออเดอร์เข้ามาเยอะมากๆเลย\nยังงไงแอดมิน กับทีมงานเร่งมือพยายามเคลียร์ให้หมดในวันนี้ครับบ"),
  R("ใบเสร็จ", "general", "🧾ใบเสร็จการสั่งซื้อนะครับลูกค้า"),
  R("ขอบคุณ ปิดการขาย", "general", "🙇‍♂️แอดมินดีใจที่ได้ให้บริการลูกค้านะครับ\n🧾หากมีโอกาสเชิญใช้บริการอีกน้าา ><\nBubble Shop รอต้อนรับครับ!💜"),
  R("ของถึงมือแล้ว", "general", "💫 ของถึงมือแล้วค้าบ! ขอบคุณมาก ๆ ที่อุดหนุนกันตลอดเลยนะครับ 🎉"),
  R("ขออภัยบริการไม่ทัน", "general", "ขออภัยที่ไม่สามารถบริการได้ทันท่วงทีครับ🙇‍♂️✨"),
  R("ยืนยันออเดอร์ (มีช่อง)", "general", "ยืนยันออเดอร์ {สินค้า} ราคา {ราคา} บาทครับ\nโอนแล้วส่งสลิปมาได้เลยนะครับ ทีมงานจะเริ่มดำเนินการทันที ⏱"),
  R("ยืนยันเติม Robux (มีช่อง)", "robux", "💎ยืนยันเติม {จำนวน} Robux ราคา {ราคา} บาทครับ\nรบกวนส่งชื่อในเกม + สลิปมาได้เลยน้าา 🙇‍♂️"),
  R("Robux เข้าแล้ว", "robux", "💎Robux เข้าไอดีเรียบร้อยแล้วครับ เช็กยอดในเกมได้เลยน้าา\nขอบคุณที่อุดหนุน Bubble Shop 💜"),
];

export const DEFAULT_REPLY_SETTINGS: ReplySettings = { replies: DEFAULT_REPLIES, values: {}, ending: "m" };

export const newReply = (group: ReplyGroup = "general"): Reply => ({ id: uid(), name: "ข้อความใหม่", body: "", group });

/** A notepad pasted whole: blank lines separate cards; the first line names each. */
export function splitNotepad(text: string, group: ReplyGroup): Reply[] {
  return unshortcode(text.replace(/\r/g, ""))
    .split(/\n[ \t]*\n+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((body) => {
      const first = body.split("\n")[0].replace(/[\p{Extended_Pictographic}️‍~*_:>]/gu, "").trim();
      return { id: uid(), name: (first || "ข้อความ").slice(0, 28), body, group };
    });
}

/** Fields that fill themselves; they never appear in the form. */
export const AUTO_FIELDS = ["ค่ะ", "คะ", "วันที่", "เวลา"] as const;
const FIELD_RE = /\{([^{}\n]{1,30})\}/g;

/** The blanks a card asks for, in order of first appearance, no repeats. */
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

/** The card with every blank filled; an empty blank is left as {ช่อง} so it is seen. */
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

/** Case-insensitive match on name or body. */
export const matches = (r: Reply, q: string) => {
  const s = q.trim().toLowerCase();
  return !s || r.name.toLowerCase().includes(s) || r.body.toLowerCase().includes(s);
};
