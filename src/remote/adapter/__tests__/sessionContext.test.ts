import { describe, it, expect, vi } from "vitest";
import { buildClioSessionContext } from "../sessionContext.js";

describe("buildClioSessionContext", () => {
  it("resolves the access token through the injected resolver", async () => {
    const ctx = buildClioSessionContext("clio-42", async () => "tok-123");
    expect(await ctx.getAccessToken()).toBe("tok-123");
  });

  it("memoizes the token so it resolves once per request even across many tool calls", async () => {
    const resolve = vi.fn(async () => "tok-123");
    const ctx = buildClioSessionContext("clio-42", resolve);
    await Promise.all([ctx.getAccessToken(), ctx.getAccessToken(), ctx.getAccessToken()]);
    await ctx.getAccessToken();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed resolution — the next call retries", async () => {
    let n = 0;
    const resolve = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("transient D1 error");
      return "tok-ok";
    });
    const ctx = buildClioSessionContext("clio-42", resolve);
    await expect(ctx.getAccessToken()).rejects.toThrow("transient");
    expect(await ctx.getAccessToken()).toBe("tok-ok");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("exposes the userId as the sessionId", () => {
    expect(buildClioSessionContext("clio-42", async () => "t").sessionId).toBe("clio-42");
  });

  it("throws on the stdio-only token members (they must never be reached on the Worker)", () => {
    const ctx = buildClioSessionContext("clio-42", async () => "t");
    expect(() => ctx.storeTokens({} as never)).toThrow(/multi-tenant|not available/i);
    expect(() => ctx.getTokens()).toThrow(/multi-tenant|not available/i);
    expect(() => ctx.clearTokens()).toThrow(/multi-tenant|not available/i);
    expect(() => ctx.setPendingNonce("n")).toThrow(/multi-tenant|not available/i);
  });
});
