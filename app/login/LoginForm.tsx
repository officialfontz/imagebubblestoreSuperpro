"use client";

import { useActionState } from "react";
import { Layers, Lock, ArrowRight, Loader2, AlertTriangle } from "lucide-react";
import { signIn, type SignInState } from "@/lib/login-actions";

export default function LoginForm() {
  const [state, action, pending] = useActionState<SignInState, FormData>(signIn, {});

  return (
    <main className="auth">
      <div className="auth-card">
        <span className="brand-mark auth-mark"><Layers size={22} strokeWidth={2.2} /></span>
        <h1>Bubble Vault</h1>
        <p>คลังรูปส่วนตัว — ใส่รหัสผ่านเพื่อเข้าใช้งาน</p>

        <form action={action} className="auth-form">
          <div className="auth-field">
            <Lock size={15} color="var(--ink-4)" />
            <input
              type="password"
              name="password"
              placeholder="รหัสผ่าน"
              autoComplete="current-password"
              autoFocus
              required
              aria-label="รหัสผ่าน"
              aria-invalid={Boolean(state.error)}
            />
          </div>

          {state.error && (
            <p className="auth-error" role="alert">
              <AlertTriangle size={14} />
              {state.error}
            </p>
          )}

          <button type="submit" className="btn btn--primary btn--block" disabled={pending}>
            {pending ? <Loader2 size={15} className="spin" /> : <ArrowRight size={15} />}
            {pending ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}
          </button>
        </form>
      </div>

      <p className="auth-foot">ลิงก์รูปที่แชร์ไว้ยังเปิดได้ตามปกติโดยไม่ต้องเข้าสู่ระบบ</p>
    </main>
  );
}
