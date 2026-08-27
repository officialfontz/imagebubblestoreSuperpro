"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCw, LogIn } from "lucide-react";

// Catches anything a page or server action throws that the UI did not already
// handle — most often an expired session, which is why signing in again is
// offered right next to "try again".
export default function ErrorBoundary({
  error, reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => { console.error(error); }, [error]);

  return (
    <main className="auth">
      <div className="auth-card">
        <span className="brand-mark auth-mark" style={{ background: "rgba(251, 113, 133, 0.16)", boxShadow: "none" }}>
          <AlertTriangle size={22} color="var(--danger)" />
        </span>
        <h1>เกิดข้อผิดพลาด</h1>
        <p>ลองโหลดใหม่อีกครั้ง — ถ้ายังไม่หาย อาจเป็นเพราะเซสชันหมดอายุ</p>

        <div className="auth-form">
          <button type="button" className="btn btn--primary btn--block" onClick={reset}>
            <RotateCw size={15} />
            ลองใหม่
          </button>
          <a className="btn btn--ghost btn--block" href="/login">
            <LogIn size={15} />
            เข้าสู่ระบบอีกครั้ง
          </a>
        </div>
      </div>
    </main>
  );
}
