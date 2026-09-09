// ── Robux to baht, the shop's way ─────────────────────────────────────────────
// A "rate" of 6 means six Robux to the baht: price = robux ÷ rate, rounded up
// to whole baht so 25.70 is quoted as 26. The rate moves with the market and
// is whatever was set last.

export type PriceItem = { id: string; name: string; robux: number | "" };

export type PriceSettings = {
  rate: number;
  roundUp: boolean;
  /** Whether the copied message lists items or just the total. */
  itemised: boolean;
};

export const DEFAULT_PRICE: PriceSettings = { rate: 6, roundUp: true, itemised: true };
export const RATE_CHIPS = [5, 5.5, 6, 6.5, 7];

export const newItem = (): PriceItem => ({ id: Math.random().toString(36).slice(2), name: "", robux: "" });

export function bahtOf(robux: number, s: PriceSettings): number {
  if (!s.rate || robux <= 0) return 0;
  const raw = robux / s.rate;
  return s.roundUp ? Math.ceil(raw - 1e-9) : Math.round(raw * 100) / 100;
}

export const robuxOf = (baht: number, s: PriceSettings) => (baht > 0 ? Math.floor(baht * s.rate) : 0);

const money = (n: number) => n.toLocaleString("th-TH", { maximumFractionDigits: 2 });

/** The message pasted back to the customer. */
export function quote(items: PriceItem[], s: PriceSettings): string {
  const live = items.filter((i) => typeof i.robux === "number" && i.robux > 0) as (PriceItem & { robux: number })[];
  if (live.length === 0) return "";
  const total = live.reduce((n, i) => n + bahtOf(i.robux, s), 0);
  const lines: string[] = [];
  if (s.itemised) {
    for (const i of live) lines.push(`• ${i.name.trim() || "Game Pass"} ${money(i.robux)} Robux → ${money(bahtOf(i.robux, s))} บาท`);
  }
  if (live.length > 1 || !s.itemised) lines.push(`รวม ${money(total)} บาท 🫧`);
  return lines.join("\n");
}
