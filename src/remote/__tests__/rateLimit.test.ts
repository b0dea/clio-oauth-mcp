import { describe, it, expect, vi } from "vitest";
import { enforcePublicRateLimit, type RateLimiter } from "../rateLimit.js";

function limiter(success: boolean, onCall?: (o: { key: string }) => void): RateLimiter {
  return {
    limit: async (o) => {
      onCall?.(o);
      return { success };
    },
  };
}

function req(path: string, ip?: string): Request {
  return new Request(`https://conn.example${path}`, { headers: ip ? { "CF-Connecting-IP": ip } : {} });
}

describe("enforcePublicRateLimit", () => {
  it("lets a request through when the limiter allows it", async () => {
    expect(await enforcePublicRateLimit(req("/authorize", "1.2.3.4"), limiter(true))).toBeNull();
  });

  it("returns 429 with Retry-After when the per-IP limit is exceeded", async () => {
    const res = await enforcePublicRateLimit(req("/token", "1.2.3.4"), limiter(false));
    expect(res?.status).toBe(429);
    expect(res?.headers.get("Retry-After")).toBe("60");
  });

  it("rate-limits all four public OAuth endpoints", async () => {
    for (const p of ["/authorize", "/token", "/register", "/clio/callback"]) {
      expect((await enforcePublicRateLimit(req(p, "1.2.3.4"), limiter(false)))?.status).toBe(429);
    }
  });

  it("never consults the limiter for non-public paths like /mcp", async () => {
    const onCall = vi.fn();
    expect(await enforcePublicRateLimit(req("/mcp", "1.2.3.4"), limiter(false, onCall))).toBeNull();
    expect(onCall).not.toHaveBeenCalled();
  });

  it("keys the limit by the client IP (CF-Connecting-IP)", async () => {
    const onCall = vi.fn();
    await enforcePublicRateLimit(req("/authorize", "9.9.9.9"), limiter(true, onCall));
    expect(onCall).toHaveBeenCalledWith({ key: "9.9.9.9" });
  });

  it("fails open when no limiter is bound (defense-in-depth, not a correctness gate)", async () => {
    expect(await enforcePublicRateLimit(req("/authorize", "1.2.3.4"), undefined)).toBeNull();
  });
});
