import Link from "next/link";
import { FileQuestion } from "lucide-react";

export default function NotFound() {
  return (
    <main className="auth">
      <div className="auth-card">
        <span className="brand-mark auth-mark" style={{ background: "var(--card)", boxShadow: "none" }}>
          <FileQuestion size={22} color="var(--ink-3)" />
        </span>
        <h1>ไม่พบหน้านี้</h1>
        <p>ลิงก์อาจพิมพ์ผิด หรือรูปที่อ้างถึงถูกลบไปแล้ว</p>
        <div className="auth-form">
          <Link className="btn btn--primary btn--block" href="/">กลับไปที่คลังรูป</Link>
        </div>
      </div>
    </main>
  );
}
