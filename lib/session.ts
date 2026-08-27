// ── Session tokens ────────────────────────────────────────────────────────────
// A signed, stateless cookie: no session store to run, no database to keep in
// sync, and a token cannot be forged without HMAC_KEY.
//
//   token = "<expiresAt>.<hex signature>"
//   signature = HMAC-SHA256(HMAC_KEY, "bv1:<expiresAt>:<password>")
//
// Binding the password into the signature means changing VAULT_PASSWORD
// invalidates every existing session — the expected behaviour when you rotate
// a credential because it leaked.
//
// Web Crypto (not node:crypto) so the exact same code runs in the edge proxy
// and in server actions.

export const SESSION_COOKIE = "bv_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

export async function createSessionToken(password: string, hmacKey: string): Promise<string> {
  const exp = Date.now() + SESSION_TTL_MS;
  return `${exp}.${await sign(hmacKey, `bv1:${exp}:${password}`)}`;
}

export async function verifySessionToken(
  token: string | undefined,
  password: string,
  hmacKey: string,
): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot === -1) return false;

  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || Date.now() > exp) return false;

  return constantTimeEqual(token.slice(dot + 1), await sign(hmacKey, `bv1:${exp}:${password}`));
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
