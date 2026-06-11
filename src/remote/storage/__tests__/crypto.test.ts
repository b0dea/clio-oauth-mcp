import { describe, it, expect } from "vitest";
import { encrypt, decrypt, generateKeyBase64 } from "../crypto.js";

// Fixed 32-byte keys (base64) so tests are deterministic where they need to be.
const KEY = "weUyM4TL8z6AwAOQkAnA7y2kh9lTiZmdDhxUvFJ8Td0=";
const OTHER_KEY = "3+sZM1PthpHg60O4Kdyz8L1WQ9z6oH+5Qgidfnn8/Do=";

describe("AES-256-GCM token crypto (SubtleCrypto)", () => {
  it("round-trips a value: decrypt(encrypt(x)) === x", async () => {
    const secret = JSON.stringify({ access_token: "tok-abc", refresh_token: "ref-xyz", expires_at: 123 });
    const blob = await encrypt(KEY, secret);
    expect(await decrypt(KEY, blob)).toBe(secret);
  });

  it("does not leak plaintext into the ciphertext", async () => {
    const blob = await encrypt(KEY, "super-secret-clio-token");
    expect(blob).not.toContain("super-secret-clio-token");
  });

  it("uses a random IV per record (same plaintext -> different ciphertext)", async () => {
    const a = await encrypt(KEY, "same");
    const b = await encrypt(KEY, "same");
    expect(a).not.toBe(b);
    expect(await decrypt(KEY, a)).toBe("same");
    expect(await decrypt(KEY, b)).toBe("same");
  });

  it("fails to decrypt under a different key (GCM auth tag rejects tampering)", async () => {
    const blob = await encrypt(KEY, "secret");
    await expect(decrypt(OTHER_KEY, blob)).rejects.toThrow();
  });

  it("rejects a key that is not 32 bytes", async () => {
    await expect(encrypt("dG9vLXNob3J0", "x")).rejects.toThrow(/32 bytes/);
  });

  it("generateKeyBase64 produces an importable 32-byte key", async () => {
    const k = generateKeyBase64();
    const blob = await encrypt(k, "hello");
    expect(await decrypt(k, blob)).toBe("hello");
  });
});
