// ── The toolbox ───────────────────────────────────────────────────────────────
// Every tool the vault offers, in one list. The rail, the hub page and the URL
// all read from here, so adding a tool is one entry — not three edits that
// drift apart.
//
// Tools run in the browser. Nothing in this list touches the server or the
// bucket; the vault is where pictures live, not where they are worked on.
//
// No "use client" here on purpose: the /tools/[slug] route looks a slug up on
// the server before rendering, and a client module cannot be called from it.

import type { ComponentType } from "react";
import { Minimize2, Replace, Stamp, Crop, MessageSquareText, Calculator, QrCode, Eraser } from "lucide-react";

export type ToolCategory = "image" | "text" | "shop";

export type ToolDef = {
  slug: string;
  name: string;
  blurb: string;
  category: ToolCategory;
  Icon: ComponentType<{ size?: number }>;
  /** Present once the tool exists; absent while it is only planned.
   *  Tools that keep shared state are told whether this session may write. */
  component?: ComponentType<{ isOwner?: boolean }>;
};

export const CATEGORY_LABEL: Record<ToolCategory, string> = { image: "ภาพ", text: "ข้อความ", shop: "ร้าน" };

/** Rail and URL key for a tool. */
export const toolKey = (slug: string) => `tool:${slug}`;
export const TOOLS_HUB = "__tools__";
export const isToolView = (active: string) => active === TOOLS_HUB || active.startsWith("tool:");
export const toolSlug = (active: string) => (active.startsWith("tool:") ? active.slice(5) : null);

// Components are attached in tools-registry.tsx so this file stays importable
// by the server (the rail's server-rendered labels) without pulling every
// tool's client code along.
export const TOOL_DEFS: ToolDef[] = [
  { slug: "shrink", name: "ย่อรูป", blurb: "โยนรูปเข้ามา เลือกขนาดไม่เกินกี่ KB คัดลอกวางได้เลย", category: "image", Icon: Minimize2 },
  { slug: "stamp", name: "ใส่โลโก้ร้าน", blurb: "ลายน้ำหลายรูปทีเดียว จำตำแหน่งและความจาง", category: "image", Icon: Stamp },
  { slug: "crop", name: "ครอปตามสัดส่วน", blurb: "1:1 · 4:5 · 16:9 ลากกรอบเอง สำหรับรูปสินค้าและโพสต์", category: "image", Icon: Crop },
  { slug: "bg", name: "ลบพื้นหลัง", blurb: "เร็ว ๆ นี้", category: "image", Icon: Eraser },
  { slug: "replace", name: "ค้นหา & แทนที่", blurb: "วางข้อความ ตั้งกฎหลายข้อ แทนที่ทีเดียว", category: "text", Icon: Replace },
  { slug: "template", name: "ข้อความตอบลูกค้า", blurb: "การ์ดข้อความประจำ คลิกเดียวคัดลอก แยกเกมพาส/Robux แทนโน้ตแพด", category: "text", Icon: MessageSquareText },
  { slug: "price", name: "คำนวณราคา", blurb: "Robux ÷ เรต ปัดขึ้นเป็นบาท พร้อมข้อความตอบลูกค้า", category: "shop", Icon: Calculator },
  { slug: "qr", name: "QR ลิงก์", blurb: "ลิงก์รูป หน้าร้าน หรืออะไรก็ได้ เป็น QR มีโลโก้ตรงกลาง", category: "shop", Icon: QrCode },
];

export const toolBySlug = (slug: string) => TOOL_DEFS.find((t) => t.slug === slug);
