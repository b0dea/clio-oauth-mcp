/**
 * AES-256-GCM at rest, via the WebCrypto `crypto.subtle` global (works on Workers and in the
 * Node test runtime — no `node:crypto`). This is the Workers rewrite of upstream's
 * `src/auth/tokenStorage.ts` (Node `crypto` + 16-byte IV + OS keychain/fs, all Workers-hostile).
 *
 * Record layout: base64( iv(12 bytes) ‖ ciphertext+GCM-tag ). A fresh random IV per record;
 * the 16-byte GCM tag authenticates the ciphertext, so tampering or a wrong key fails closed.
 * The key is the raw 32-byte `ENCRYPTION_KEY` secret (base64) imported directly — it is already
 * uniformly random, so no KDF is needed.
 */

const IV_BYTES = 12;
const KEY_BYTES = 32;

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

// Copy into a fresh ArrayBuffer. WebCrypto wants `BufferSource`; newer TS types a plain
// Uint8Array as `Uint8Array<ArrayBufferLike>`, which is not assignable to the ArrayBuffer-backed
// BufferSource the crypto lib expects. A small copy sidesteps that without `any` casts.
function toBuffer(u8: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}

async function importKey(secretB64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(secretB64);
  if (raw.length !== KEY_BYTES) {
    throw new Error(`ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (AES-256); got ${raw.length}.`);
  }
  return crypto.subtle.importKey("raw", toBuffer(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Encrypt a UTF-8 string; returns base64( iv ‖ ciphertext+tag ). */
export async function encrypt(secretB64: string, plaintext: string): Promise<string> {
  const key = await importKey(secretB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: toBuffer(iv) }, key, toBuffer(new TextEncoder().encode(plaintext))),
  );
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv, 0);
  combined.set(ct, iv.length);
  return bytesToBase64(combined);
}

/** Decrypt a base64( iv ‖ ciphertext+tag ) blob. Throws if the key is wrong or the blob was tampered. */
export async function decrypt(secretB64: string, blob: string): Promise<string> {
  const key = await importKey(secretB64);
  const combined = base64ToBytes(blob);
  const iv = combined.subarray(0, IV_BYTES);
  const ct = combined.subarray(IV_BYTES);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toBuffer(iv) }, key, toBuffer(ct));
  return new TextDecoder().decode(pt);
}

/** Generate a fresh 32-byte AES-256 key as base64 — for `wrangler secret put ENCRYPTION_KEY`. */
export function generateKeyBase64(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}
