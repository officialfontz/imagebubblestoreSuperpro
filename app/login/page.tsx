import { redirect } from "next/navigation";
import { isSignedIn } from "@/lib/auth";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "เข้าสู่ระบบ — Bubble Vault",
  robots: { index: false, follow: false },
};

export default async function LoginPage() {
  // Coming back to /login with a live session is just a stale bookmark.
  if (await isSignedIn()) redirect("/");
  return <LoginForm />;
}
