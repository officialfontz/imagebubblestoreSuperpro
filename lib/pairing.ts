// ── Pairing codes ─────────────────────────────────────────────────────────────
// How a desktop install learns who it is: the owner presses "จับคู่อุปกรณ์" in
// the web app, reads out six characters, and the staff member types them once.
// The code is exchanged for a long-lived bearer token and immediately spent.
//
// Kept in memory deliberately. There is one container, codes live ten minutes,
// and the failure mode of a redeploy is "press the button again" — which is
// cheaper than the alternative of writing short-lived secrets into the catalog
// that outlives them.

import { randomInt } from "crypto";

// No 0/O or 1/I: the code is read aloud or typed from a chat message, and those
// pairs are where a six-character code actually goes wrong.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const TTL_MS = 10 * 60_000;

type Pending = { staffId: string; expiresAt: number };
const _codes = new Map<string, Pending>();

function sweep(now: number): void {
  for (const [code, entry] of _codes) if (now > entry.expiresAt) _codes.delete(code);
}

/** Issues a code for one staff member, replacing any earlier unused one so a
 *  person never has two live codes floating around. */
export function issuePairingCode(staffId: string): { code: string; expiresAt: number } {
  const now = Date.now();
  sweep(now);
  for (const [code, entry] of _codes) if (entry.staffId === staffId) _codes.delete(code);

  let code = "";
  do {
    code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  } while (_codes.has(code));

  const expiresAt = now + TTL_MS;
  _codes.set(code, { staffId, expiresAt });
  return { code, expiresAt };
}

/** Spends a code. One use only — a second attempt with the same code fails
 *  even inside the window, so an overheard code is worth nothing once used. */
export function consumePairingCode(input: string): string | null {
  const code = String(input ?? "").trim().toUpperCase();
  const entry = _codes.get(code);
  if (!entry) return null;
  _codes.delete(code);
  if (Date.now() > entry.expiresAt) return null;
  return entry.staffId;
}

export function revokePairingCodes(staffId: string): void {
  for (const [code, entry] of _codes) if (entry.staffId === staffId) _codes.delete(code);
}
