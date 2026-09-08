// ── Pairing codes ─────────────────────────────────────────────────────────────
// How a desktop install learns who it is: the owner presses "จับคู่อุปกรณ์" in
// the web app, reads out six characters, and the staff member types them once.
// The code is exchanged for a long-lived bearer token and immediately spent.
//
// The pending code lives on the staff record, not in a module-level Map. It has
// to: the code is issued by a server action and redeemed by a route handler,
// and Next does not guarantee those two share a module instance — an in-memory
// map really did hand out codes that /api/pair had never heard of. Putting it
// in the catalog also means a redeploy mid-pairing does not strand anyone.
//
// Only the digest is stored, for the same reason tokens are: the catalog should
// never contain a live credential.

import { createHash, randomInt } from "crypto";
import { loadVault, updateVault, bustVaultCache } from "./store";

// No 0/O or 1/I: the code is read aloud or typed from a chat message, and those
// pairs are where a six-character code actually goes wrong.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const TTL_MS = 10 * 60_000;

export function hashCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

/** Issues a code for one staff member, replacing any earlier unused one so a
 *  person never has two live codes floating around. */
export async function issuePairingCode(
  staffId: string,
): Promise<{ code: string; expiresAt: number } | { error: string }> {
  const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  const expiresAt = Date.now() + TTL_MS;

  const res = await updateVault<{ found: boolean }>((data) => {
    const staff = data.staff.find((s) => s.id === staffId);
    if (staff) staff.pairing = { hash: hashCode(code), expiresAt };
    return { next: data, result: { found: Boolean(staff) } };
  });

  if ("error" in res) return { error: res.error };
  if (!res.found) return { error: "ไม่พบทีมงานคนนี้" };
  return { code, expiresAt };
}

/**
 * Spends a code. One use only — a second attempt with the same code fails even
 * inside the window, so an overheard code is worth nothing once used.
 */
export async function consumePairingCode(input: string): Promise<string | null> {
  const code = String(input ?? "").trim().toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  const digest = hashCode(code);

  // The code was written by a different module instance, whose write this one's
  // read cache knows nothing about. Pairing happens a few times a year; paying
  // for a fresh read here is free in practice and the alternative is a code
  // that mysteriously does not work for the first thirty seconds.
  bustVaultCache();
  const vault = await loadVault();

  const match = vault.staff.find(
    (s) => s.pairing && s.pairing.hash === digest && Date.now() < s.pairing.expiresAt,
  );
  if (!match) return null;

  const res = await updateVault<{ ok: boolean }>((data) => {
    const staff = data.staff.find((s) => s.id === match.id);
    if (staff) delete staff.pairing;
    return { next: data, result: { ok: Boolean(staff) } };
  });
  if ("error" in res || !res.ok) return null;

  return match.id;
}

export async function revokePairingCodes(staffId: string): Promise<void> {
  await updateVault((data) => {
    const staff = data.staff.find((s) => s.id === staffId);
    if (staff) delete staff.pairing;
    return { next: data, result: { ok: true } };
  });
}
