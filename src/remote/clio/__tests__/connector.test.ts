import { describe, it, expect } from "vitest";
import { clioConfigFromEnv, requireEncryptionKey } from "../connector.js";
import type { Env } from "../../env.js";

const baseEnv = {
  CLIO_REGION: "EU",
  CLIO_CLIENT_ID: "cid",
  CLIO_CLIENT_SECRET: "secret",
  ENCRYPTION_KEY: "key",
} as unknown as Env;

describe("clioConfigFromEnv", () => {
  it("maps env to a Clio OAuth config", () => {
    expect(clioConfigFromEnv(baseEnv)).toEqual({ region: "EU", clientId: "cid", clientSecret: "secret" });
  });

  it("throws when Clio client credentials are missing", () => {
    expect(() => clioConfigFromEnv({ ...baseEnv, CLIO_CLIENT_ID: undefined } as Env)).toThrow(/not configured/i);
    expect(() => clioConfigFromEnv({ ...baseEnv, CLIO_CLIENT_SECRET: undefined } as Env)).toThrow(/not configured/i);
  });
});

describe("requireEncryptionKey", () => {
  it("returns the key when present and throws when absent", () => {
    expect(requireEncryptionKey(baseEnv)).toBe("key");
    expect(() => requireEncryptionKey({ ...baseEnv, ENCRYPTION_KEY: undefined } as Env)).toThrow(/not configured/i);
  });
});
