/**
 * PIN hashing via the Web Crypto API (PBKDF2-SHA256) — no dependencies.
 * Stored verifier format: "iterations.saltHex.hashHex".
 *
 * NOTE: this gates the UI only. The meetings database is not encrypted at rest;
 * a privacy PIN prevents shoulder-surfing in-app, not disk-level access.
 */

const ITERATIONS = 150000;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function derive(
  pin: string,
  salt: Uint8Array,
  iterations: number,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(pin) as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return toHex(new Uint8Array(bits));
}

/** Hash a PIN into a storable verifier string. */
export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, ITERATIONS);
  return `${ITERATIONS}.${toHex(salt)}.${hash}`;
}

/** Verify a PIN against a stored verifier string. */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  try {
    const [iterStr, saltHex, hashHex] = stored.split(".");
    const iterations = parseInt(iterStr, 10);
    if (!iterations || !saltHex || !hashHex) return false;
    const hash = await derive(pin, fromHex(saltHex), iterations);
    if (hash.length !== hashHex.length) return false;
    let diff = 0;
    for (let i = 0; i < hash.length; i++) {
      diff |= hash.charCodeAt(i) ^ hashHex.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}
