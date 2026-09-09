"use client";

// ── Team ──────────────────────────────────────────────────────────────────────
// Who may send delivery proof, and how their machine proves it is theirs.
//
// Pairing is deliberately a code read out loud rather than a password typed
// into an app: the code is worthless ten minutes later and cannot be reused,
// so sending it over chat is fine in a way that sending a token never is.

import { useEffect, useRef, useState } from "react";
import {
  Users, Plus, MoreHorizontal, Copy, RefreshCw, Check, Smartphone, FileText, X, Pencil, Ban, Trash2,
} from "lucide-react";
import type { VaultStaff } from "@/lib/types";
import {
  createStaff, updateStaff, revokeStaff, deleteStaff, createPairingCode,
} from "@/lib/capture-actions";
import {
  Scrim, Menu, MenuItem, copyText, timeAgo, nowMs,
  type MenuAnchor, type PromptSpec, type ConfirmSpec,
} from "./ui";

type Props = {
  staff: VaultStaff[];
  onClose: () => void;
  onChanged: (staff: VaultStaff[]) => void;
  say: (text: string, kind?: "ok" | "error") => void;
  ask: (spec: PromptSpec) => void;
  confirm: (spec: ConfirmSpec) => void;
};

type Pairing = { staffId: string; code: string; expiresAt: number };

function statusOf(member: VaultStaff): { label: string; className: string } {
  if (member.revokedAt) return { label: "ยกเลิกแล้ว", className: "chip chip--off" };
  if (member.tokenHash) return { label: "จับคู่แล้ว", className: "chip chip--live" };
  return { label: "ยังไม่จับคู่", className: "chip chip--local" };
}

export default function StaffModal({ staff, onClose, onChanged, say, ask, confirm }: Props) {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; member: VaultStaff } | null>(null);
  const [report, setReport] = useState<VaultStaff | null>(null);
  const [now, setNow] = useState(0);
  const issuedAt = useRef(0);

  // The countdown is the whole point of the code panel: it tells the owner
  // whether to read it out or press "สร้างใหม่".
  useEffect(() => {
    if (!pairing) return;
    const id = setInterval(() => setNow(nowMs()), 1000);
    return () => clearInterval(id);
  }, [pairing]);

  // `now` is 0 until the first tick, which reads as "not expired yet" — the
  // right guess for a code issued a moment ago.
  const secondsLeft = pairing && now ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 600;
  const expired = Boolean(pairing) && now > 0 && secondsLeft === 0;

  const patch = (id: string, change: Partial<VaultStaff> | null) =>
    onChanged(
      change === null
        ? staff.filter((s) => s.id !== id)
        : staff.map((s) => (s.id === id ? { ...s, ...change } : s)),
    );

  const askAdd = () =>
    ask({
      title: "เพิ่มทีมงาน",
      value: "",
      placeholder: "ชื่อที่จะแสดงบนหลักฐาน เช่น มิ้นท์",
      emoji: "🧑‍💻",
      confirm: "เพิ่ม",
      onConfirm: (name, emoji) => {
        void createStaff(name, emoji).then((res) => {
          if (!res.ok) { say(res.error, "error"); return; }
          onChanged([...staff, res.staff]);
          say(`เพิ่ม ${res.staff.name} แล้ว`);
        });
      },
    });

  const askRename = (member: VaultStaff) =>
    ask({
      title: "แก้ชื่อทีมงาน",
      value: member.name,
      emoji: member.emoji,
      confirm: "บันทึก",
      onConfirm: (name, emoji) => {
        void updateStaff(member.id, name, emoji).then((res) => {
          if (!res.ok) { say(res.error, "error"); return; }
          patch(member.id, { name, emoji });
        });
      },
    });

  const pair = async (member: VaultStaff) => {
    const res = await createPairingCode(member.id);
    if (!res.ok) { say(res.error, "error"); return; }
    issuedAt.current = nowMs();
    setPairing({ staffId: member.id, code: res.code, expiresAt: res.expiresAt });
    setNow(issuedAt.current);
  };

  const askRevoke = (member: VaultStaff) =>
    confirm({
      title: `ยกเลิกสิทธิ์ ${member.name}?`,
      body: "อุปกรณ์ที่จับคู่ไว้จะส่งหลักฐานไม่ได้ทันที หลักฐานที่ส่งไปแล้วยังอยู่ครบทุกรูป",
      confirm: "ยกเลิกสิทธิ์",
      tone: "danger",
      onConfirm: () => {
        void revokeStaff(member.id).then((res) => {
          if (!res.ok) { say(res.error, "error"); return; }
          patch(member.id, { revokedAt: nowMs(), tokenHash: undefined });
          if (pairing?.staffId === member.id) setPairing(null);
          say(`ยกเลิกสิทธิ์ ${member.name} แล้ว`);
        });
      },
    });

  const askDelete = (member: VaultStaff) =>
    confirm({
      title: `ลบ ${member.name} ออกจากทีม?`,
      body: "ทำได้เฉพาะคนที่ยังไม่มีหลักฐานในระบบ ถ้ามีแล้วให้ใช้ยกเลิกสิทธิ์แทน",
      confirm: "ลบออก",
      tone: "danger",
      onConfirm: () => {
        void deleteStaff(member.id).then((res) => {
          if (!res.ok) { say(res.error, "error"); return; }
          patch(member.id, null);
          say(`ลบ ${member.name} แล้ว`);
        });
      },
    });

  return (
    <Scrim onClose={onClose} label="ทีมงาน" wide>
        <h2>
          <Users size={17} />
          ทีมงาน
          <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 500, color: "var(--ink-3)" }}>
            {staff.length} คน · จับคู่แล้ว {staff.filter((s) => s.tokenHash && !s.revokedAt).length}
          </span>
        </h2>
        <p>ทุกคนเห็นหลักฐานของกันและกัน ยกเลิกสิทธิ์ได้รายคน หลักฐานเดิมยังอยู่ครบ</p>

        <div className="staff-list">
          {staff.length === 0 && (
            <p style={{ padding: "18px 2px", color: "var(--ink-3)", fontSize: 13 }}>
              ยังไม่มีใครในทีม — เพิ่มคนแรกแล้วส่งรหัสจับคู่ให้ เพื่อเริ่มส่งหลักฐานจากโปรแกรม
            </p>
          )}

          {staff.map((member) => {
            const status = statusOf(member);
            const test = member.lastSelfTest;
            return (
              <div className="staff-row" key={member.id}>
                <span className="staff-emoji" aria-hidden>{member.emoji}</span>

                <div className="staff-body">
                  <div className="staff-head">
                    <span className="staff-name">{member.name}</span>
                    <span className={status.className}><span className="chip-dot" />{status.label}</span>
                  </div>
                  <span className="staff-meta">
                    {member.deviceName
                      ? [member.deviceName, member.platform === "windows" ? "Windows" : member.platform === "macos" ? "macOS" : null,
                         member.appVersion ? `v${member.appVersion}` : null].filter(Boolean).join(" · ")
                      : "ยังไม่มีเครื่องที่จับคู่"}
                  </span>
                </div>

                <div className="staff-side">
                  <span>{member.lastSeenAt ? `เห็นล่าสุด${timeAgo(member.lastSeenAt)}` : "—"}</span>
                  {member.queue && (member.queue.failed > 0 || member.queue.pending > 0) && (
                    <span className={`chip ${member.queue.failed > 0 ? "chip--off" : "chip--local"}`} title="รูปที่ยังอยู่ในเครื่องของคนนี้ ยังไม่ถึง Vault">
                      {member.queue.failed > 0 ? `ส่งไม่ผ่าน ${member.queue.failed}` : `ค้างส่ง ${member.queue.pending}`}
                      {member.queue.failed > 0 && member.queue.pending > 0 ? ` · ค้าง ${member.queue.pending}` : ""}
                    </span>
                  )}
                  {test ? (
                    <button
                      type="button"
                      className="staff-test"
                      data-pass={test.passed === test.total}
                      onClick={() => setReport(member)}
                    >
                      ทดสอบ {test.passed}/{test.total} · {timeAgo(test.at).trim()}
                    </button>
                  ) : (
                    <span style={{ color: "var(--ink-4)" }}>ยังไม่ทดสอบ</span>
                  )}
                </div>

                <button
                  type="button"
                  className="iconbtn"
                  aria-label={`ตัวเลือกของ ${member.name}`}
                  onClick={(e) => setMenu({ anchor: { x: e.clientX - 180, y: e.clientY + 10 }, member })}
                >
                  <MoreHorizontal size={16} />
                </button>
              </div>
            );
          })}
        </div>

        {pairing && (
          <div className="pair-panel">
            <div className="pair-head">
              <span>
                รหัสจับคู่ของ{" "}
                <b>{staff.find((s) => s.id === pairing.staffId)?.name ?? "ทีมงาน"}</b>
              </span>
              <span className="tnum" style={{ color: expired ? "var(--danger)" : "var(--ink-3)" }}>
                {expired ? "หมดอายุแล้ว" : `หมดอายุใน ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`}
              </span>
            </div>

            <div className="pair-code" data-expired={expired}>{pairing.code}</div>

            <div className="pair-foot">
              <span>ส่งให้ทางแชต แล้วให้กรอกในโปรแกรมครั้งเดียว · ใช้ได้ครั้งเดียว</span>
              <span style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={async () => {
                    const copied = await copyText(pairing.code);
                    say(copied ? "คัดลอกรหัสแล้ว" : "คัดลอกไม่สำเร็จ", copied ? "ok" : "error");
                  }}
                >
                  <Copy size={13} /> คัดลอก
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => {
                    const member = staff.find((s) => s.id === pairing.staffId);
                    if (member) void pair(member);
                  }}
                >
                  <RefreshCw size={13} /> สร้างใหม่
                </button>
                <button type="button" className="iconbtn" onClick={() => setPairing(null)} aria-label="ปิดรหัส">
                  <X size={15} />
                </button>
              </span>
            </div>
          </div>
        )}

        {report?.lastReport && (
          <div className="pair-panel">
            <div className="pair-head">
              <span><FileText size={13} /> รายงานจาก <b>{report.name}</b> · {timeAgo(report.lastReport.at)}</span>
              <button type="button" className="iconbtn" onClick={() => setReport(null)} aria-label="ปิดรายงาน">
                <X size={15} />
              </button>
            </div>
            <pre className="staff-log">{report.lastReport.text}</pre>
          </div>
        )}

        {report && !report.lastReport && report.lastSelfTest && (
          <div className="pair-panel">
            <div className="pair-head">
              <span><Check size={13} /> ผลทดสอบของ <b>{report.name}</b></span>
              <button type="button" className="iconbtn" onClick={() => setReport(null)} aria-label="ปิดผลทดสอบ">
                <X size={15} />
              </button>
            </div>
            <pre className="staff-log">{report.lastSelfTest.report || "ไม่มีรายละเอียด"}</pre>
          </div>
        )}

        <div className="modal-foot">
          <button type="button" className="btn" onClick={askAdd}>
            <Plus size={14} /> เพิ่มทีมงาน
          </button>
          <button type="button" className="btn btn--primary" onClick={onClose}>เสร็จ</button>
        </div>

      {menu && (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)}>
          <MenuItem
            icon={<Smartphone size={15} />}
            label={menu.member.tokenHash ? "จับคู่อุปกรณ์ใหม่" : "จับคู่อุปกรณ์"}
            onClick={() => { const m = menu.member; setMenu(null); void pair(m); }}
          />
          <MenuItem
            icon={<Pencil size={15} />}
            label="แก้ชื่อ / อีโมจิ"
            onClick={() => { const m = menu.member; setMenu(null); askRename(m); }}
          />
          {menu.member.lastReport && (
            <MenuItem
              icon={<FileText size={15} />}
              label="อ่านรายงานปัญหา"
              onClick={() => { const m = menu.member; setMenu(null); setReport(m); }}
            />
          )}
          <div className="menu-sep" />
          {!menu.member.revokedAt && (
            <MenuItem
              icon={<Ban size={15} />}
              label="ยกเลิกสิทธิ์"
              danger
              onClick={() => { const m = menu.member; setMenu(null); askRevoke(m); }}
            />
          )}
          <MenuItem
            icon={<Trash2 size={15} />}
            label="ลบออกจากทีม"
            danger
            onClick={() => { const m = menu.member; setMenu(null); askDelete(m); }}
          />
        </Menu>
      )}
    </Scrim>
  );
}
