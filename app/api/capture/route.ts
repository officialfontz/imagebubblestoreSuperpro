// ── POST /api/capture ─────────────────────────────────────────────────────────
// One piece of delivery proof, from the Bubble Capture desktop app.
//
// The hard requirement here is that a flaky connection can never produce two
// copies of the same proof. The device generates a clientId once, at capture
// time, and reuses it on every retry; this endpoint treats a repeat as a
// success and hands back the record that already exists.

import type { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { authenticateStaff, isAuthFailure, readDeviceHeader, touchLastSeen } from "@/lib/staff-auth";
import { makeLimiter } from "@/lib/ratelimit";
import { checkMagicBytes } from "@/lib/security";
import { encodeImage, objectKey, withEncodeSlot } from "@/lib/encode";
import { deleteObject, putObject } from "@/lib/storage";
import {
  captureMonthFor, loadCaptureMonths, monthOf, putCaptureSidecar, recentMonths,
  staffTally, updateCaptureMonth,
} from "@/lib/captures";
import { scheduleCaptureSweep } from "@/lib/retention";
import { fail, ok, RATE_LIMITED } from "@/lib/api";
import type { VaultImage } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The app already downscales to 1920 px and encodes before sending, so a real
// capture is 200 KB - 2 MB. 8 MiB is generous headroom that still bounds what a
// single request can make this container decode.
const MAX_BYTES = 8 * 1024 * 1024;
const ACCEPTED: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
};

// Busy staff send a few an hour, not a few a second.
const limited = makeLimiter(60, 60_000);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  const auth = await authenticateStaff(req);
  if (isAuthFailure(auth)) return fail(401, auth.error, auth.message);
  const staff = auth.staff;

  if (limited(staff.id)) return RATE_LIMITED();

  // Checked before the body is read: on a 384 MB container, buffering a
  // hundred-megabyte upload only to reject it is the failure itself.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES + 64 * 1024) return fail(413, "too-large", "ไฟล์ใหญ่เกิน 8MB");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "bad-request", "ข้อมูลไม่ถูกต้อง");
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return fail(400, "no-file", "ไม่พบไฟล์");
  if (file.size > MAX_BYTES) return fail(413, "too-large", "ไฟล์ใหญ่เกิน 8MB");

  const ext = ACCEPTED[file.type];
  if (!ext) return fail(400, "bad-mime", "รองรับเฉพาะ WebP / PNG / JPG");

  const input = new Uint8Array(await file.arrayBuffer());
  if (!checkMagicBytes(input, ext)) return fail(400, "bad-magic", "เนื้อไฟล์ไม่ตรงกับชนิดที่แจ้ง");

  // A self-test exercises this whole path — auth, size limits, multipart,
  // sharp — and stores nothing, so a staff member can verify a fresh install
  // without leaving a fake customer in the record.
  if (form.get("selftest")) {
    const probe = await withEncodeSlot(() => encodeImage(input, ext, file.type));
    return ok({
      selftest: true,
      encoded: { width: probe.width, height: probe.height, bytes: probe.data.length },
    });
  }

  const customer = String(form.get("customer") ?? "").trim().slice(0, 60);
  if (!customer) return fail(400, "no-customer", "ใส่ชื่อลูกค้าก่อน");

  const clientId = String(form.get("clientId") ?? "").trim();
  if (!UUID_RE.test(clientId)) return fail(400, "bad-client-id", "clientId ไม่ถูกต้อง");

  const capturedAtRaw = Number(form.get("capturedAt"));
  const capturedAt = Number.isFinite(capturedAtRaw) && capturedAtRaw > 0 ? capturedAtRaw : Date.now();
  const month = captureMonthFor(capturedAt);

  const tally = async () =>
    staffTally(await loadCaptureMonths([monthOf(Date.now()), recentMonths(Date.now(), 2)[1]]), staff.id);

  // Fast path for a retry: answer without touching R2 at all.
  const existing = (await loadCaptureMonths([month])).find(
    (c) => c.uploader === staff.id && c.clientId === clientId,
  );
  if (existing) {
    return ok({ capture: existing, duplicate: true, month, ...(await tally()) });
  }

  const encoded = await withEncodeSlot(() => encodeImage(input, ext, file.type));
  const { key, url } = await putObject(objectKey("cap", encoded.ext, capturedAt), encoded.data, encoded.mime);

  const capture: VaultImage = {
    id: randomUUID(),
    key,
    url,
    // name mirrors customer so anything already keyed off name — search, the
    // viewer heading, the copy menu — shows the right thing unchanged.
    name: customer,
    albumId: null,
    width: encoded.width,
    height: encoded.height,
    bytes: encoded.data.length,
    mime: encoded.mime,
    createdAt: Date.now(),
    kind: "capture",
    uploader: staff.id,
    customer,
    capturedAt,
    clientId,
    ...(encoded.blur ? { blur: encoded.blur } : {}),
  };

  // Re-checked inside the write queue: two retries can race past the fast path
  // above, and only one of them may end up in the file.
  const res = await updateCaptureMonth<{ stored: VaultImage; duplicate: boolean }>(month, (data) => {
    const dupe = data.captures.find((c) => c.uploader === staff.id && c.clientId === clientId);
    if (dupe) return { next: data, result: { stored: dupe, duplicate: true } };
    data.captures.unshift(capture);
    return { next: data, result: { stored: capture, duplicate: false } };
  });

  if ("error" in res) {
    await deleteObject(key).catch(() => undefined);
    return fail(507, "storage", res.error);
  }

  if (res.duplicate) {
    // Lost the race — drop the object this request uploaded rather than leaving
    // it in the bucket with nothing pointing at it.
    await deleteObject(key).catch(() => undefined);
  } else {
    // Metadata beside the bytes, so a lost month file can be rebuilt.
    await putCaptureSidecar(capture).catch((e) => console.error("sidecar write failed:", e));
  }

  void touchLastSeen(staff.id, readDeviceHeader(req)).catch(() => undefined);
  scheduleCaptureSweep();

  return ok({ capture: res.stored, duplicate: res.duplicate, month, ...(await tally()) });
}
