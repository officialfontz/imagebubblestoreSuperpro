// ── Session tokens ────────────────────────────────────────────────────────────
// A signed, stateless cookie: no session store to run, no database to keep in
// sync, and a token cannot be forged without HMAC_KEY.
//
//   token = "<expiresAt>.<role>.<hex signature>"
//   signature = HMAC-SHA256(HMAC_KEY, "bv2:<expiresAt>:<role>:<password>")
//
// The role is signed, not merely stored, so a staff member cannot promote their
// own cookie to owner by editing it. Tokens in the older two-part "bv1" shape
// still verify, as owner — a deploy should not sign everyone out.
//
// Binding the password into the signature means changing VAULT_PASSWORD
// invalidates every existing session — the expected behaviour when you rotate
// a credential because it leaked.
//
// Web Crypto (not node:crypto) so the exact same code runs in the edge proxy
// and in server actions.

export const SESSION_COOKIE = "bv_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * "owner" is the shop owner: the whole app, including deleting and managing the
 * team. "staff" is a delivery-proof reader — they can look up any customer's
 * proof but cannot change or destroy anything, which is what makes it safe to
 * hand the password to everyone on the team.
 */
export type VaultRole = "owner" | "staff";

/** The configured password for each role. A blank staff password disables that
 *  role entirely rather than granting access to everyone. */
export function vaultPasswords(): { owner: string | null; staff: string | null } {
  return {
    owner: process.env.VAULT_PASSWORD?.trim() || null,
    staff: process.env.VAULT_STAFF_PASSWORD?.trim() || null,
  };
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data)));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function getHmacKey(): string | null {
  const key = process.env.HMAC_KEY?.trim();
  if (key) return key;
  // Refusing to invent a key in production is deliberate: a predictable one
  // would let anyone mint their own session cookie.
  if (process.env.NODE_ENV !== "production") return "bubble-vault-dev-key";
  return null;
}

export async function createSessionToken(
  password: string,
  hmacKey: string,
  role: VaultRole = "owner",
): Promise<string> {
  const exp = Date.now() + SESSION_TTL_MS;
  return `${exp}.${role}.${await sign(hmacKey, `bv2:${exp}:${role}:${password}`)}`;
}

/**
 * Returns the role the token proves, or null. Checks the owner password first
 * so that if both passwords are ever set to the same string, the stronger role
 * wins.
 */
export async function readSessionRole(
  token: string | undefined,
  hmacKey: string,
): Promise<VaultRole | null> {
  if (!token) return null;
  const parts = token.split(".");
  const { owner, staff } = vaultPasswords();

  const exp = Number(parts[0]);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;

  // Legacy two-part token: owner only.
  if (parts.length === 2) {
    if (!owner) return null;
    return constantTimeEqual(parts[1], await sign(hmacKey, `bv1:${exp}:${owner}`)) ? "owner" : null;
  }

  if (parts.length !== 3) return null;
  const [, role, sig] = parts;
  if (role !== "owner" && role !== "staff") return null;

  const password = role === "owner" ? owner : staff;
  if (!password) return null;

  return constantTimeEqual(sig, await sign(hmacKey, `bv2:${exp}:${role}:${password}`)) ? role : null;
}

/** Constant-time password check for the sign-in form. */
export async function passwordMatches(supplied: string, expected: string, hmacKey: string): Promise<boolean> {
  // Hashing both sides first normalises them to a fixed length, so the compare
  // takes the same time no matter how short the guess was.
  const [a, b] = await Promise.all([sign(hmacKey, supplied), sign(hmacKey, expected)]);
  return constantTimeEqual(a, b);
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}
