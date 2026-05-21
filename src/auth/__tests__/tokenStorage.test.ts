import { vi, describe, it, expect, beforeEach } from "vitest";

const { MockEntry, mockGetPassword, mockSetPassword } = vi.hoisted(() => {
  const mockGetPassword = vi.fn();
  const mockSetPassword = vi.fn();
  const MockEntry = vi.fn().mockImplementation(function () {
    return { getPassword: mockGetPassword, setPassword: mockSetPassword };
  });
  return { MockEntry, mockGetPassword, mockSetPassword };
});

vi.mock("@napi-rs/keyring", () => ({ Entry: MockEntry }));

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(""),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

// Keep real crypto but make randomBytes deterministic
vi.mock("crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("crypto")>();
  return {
    ...actual,
    randomBytes: vi.fn().mockReturnValue(Buffer.from("aa".repeat(32), "hex")),
  };
});

// Imports resolved after mocks are registered
import fs from "fs/promises";
import { getEncryptionKey } from "../tokenStorage.js";

const mockMkdir = vi.mocked(fs.mkdir);
const mockReadFile = vi.mocked(fs.readFile);
const mockWriteFile = vi.mocked(fs.writeFile);

const VALID_KEY_HEX = "ab".repeat(32); // 64 hex chars = 32 bytes
const ENOENT = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });

// Helper: make MockEntry throw on construction (simulates "keychain unavailable")
function makeKeychainUnavailable() {
  MockEntry.mockImplementationOnce(function () {
    throw new Error("keychain unavailable");
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ENCRYPTION_KEY;
  // Restore default Entry implementation after clearAllMocks resets mockImplementation
  MockEntry.mockImplementation(function () {
    return { getPassword: mockGetPassword, setPassword: mockSetPassword };
  });
  // Restore default fs/promises mock implementations
  mockMkdir.mockResolvedValue(undefined);
  mockReadFile.mockResolvedValue("" as any);
  mockWriteFile.mockResolvedValue(undefined);
});

// ─── Tier 1: ENCRYPTION_KEY env var ──────────────────────────────────────────

describe("Tier 1 — ENCRYPTION_KEY env var", () => {
  it("throws if ENCRYPTION_KEY is not 64 hex chars", async () => {
    process.env.ENCRYPTION_KEY = "tooshort";
    await expect(getEncryptionKey()).rejects.toThrow("64 hex chars");
  });

  it("returns the env key as a 32-byte Buffer", async () => {
    process.env.ENCRYPTION_KEY = VALID_KEY_HEX;
    mockGetPassword.mockReturnValue(VALID_KEY_HEX); // key already in keychain → no migration
    const key = await getEncryptionKey();
    expect(key).toEqual(Buffer.from(VALID_KEY_HEX, "hex"));
    expect(key.length).toBe(32);
  });

  it("migrates env key to keychain when keychain entry is empty", async () => {
    process.env.ENCRYPTION_KEY = VALID_KEY_HEX;
    mockGetPassword.mockReturnValue(null); // empty → trigger migration
    await getEncryptionKey();
    expect(mockSetPassword).toHaveBeenCalledWith(VALID_KEY_HEX);
  });

  it("logs and continues when keychain write fails during migration", async () => {
    process.env.ENCRYPTION_KEY = VALID_KEY_HEX;
    mockGetPassword.mockReturnValue(null);
    mockSetPassword.mockImplementationOnce(() => { throw new Error("keychain locked"); });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const key = await getEncryptionKey();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Keychain write skipped"));
    expect(key).toEqual(Buffer.from(VALID_KEY_HEX, "hex"));
  });
});

// ─── Tier 2: OS keychain ─────────────────────────────────────────────────────

describe("Tier 2 — OS keychain", () => {
  it("returns existing key from keychain without generating a new one", async () => {
    mockGetPassword.mockReturnValue(VALID_KEY_HEX);
    const key = await getEncryptionKey();
    expect(mockSetPassword).not.toHaveBeenCalled();
    expect(key).toEqual(Buffer.from(VALID_KEY_HEX, "hex"));
  });

  it("generates and saves a new key when keychain entry is empty", async () => {
    mockGetPassword.mockReturnValue(null);
    const key = await getEncryptionKey();
    expect(mockSetPassword).toHaveBeenCalledOnce();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });
});

// ─── Tier 3: File fallback ───────────────────────────────────────────────────

describe("Tier 3 — file fallback", () => {
  it("creates directory with mode 0o700 before accessing key file", async () => {
    makeKeychainUnavailable();
    mockReadFile.mockResolvedValue(VALID_KEY_HEX as any);
    await getEncryptionKey();
    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining(".clio-mcp"),
      { recursive: true, mode: 0o700 },
    );
  });

  it("reads and returns an existing key.hex file", async () => {
    makeKeychainUnavailable();
    mockReadFile.mockResolvedValue(VALID_KEY_HEX as any);
    const key = await getEncryptionKey();
    expect(key).toEqual(Buffer.from(VALID_KEY_HEX, "hex"));
  });

  it("generates and writes a new key.hex with mode 0o600 when none exists", async () => {
    makeKeychainUnavailable();
    mockReadFile.mockRejectedValueOnce(ENOENT);
    const key = await getEncryptionKey();
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("key.hex"),
      expect.any(String),
      { mode: 0o600 },
    );
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });
});
