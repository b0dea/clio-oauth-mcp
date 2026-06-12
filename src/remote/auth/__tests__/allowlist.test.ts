import { describe, it, expect } from "vitest";

import { parseAllowlist, isAllowlistConfigured, isIdentityAllowed } from "../allowlist.js";
import type { ClioIdentity } from "../../clio/oauth.js";

const id = (over: Partial<ClioIdentity> = {}): ClioIdentity => ({ id: "42", name: "Ada", email: "ada@firm.co.uk", ...over });

describe("parseAllowlist", () => {
  it("splits, trims, lowercases domains and strips a leading @", () => {
    const cfg = parseAllowlist({ ALLOWED_EMAIL_DOMAINS: " Firm.CO.uk , @other.com ", ALLOWED_CLIO_USER_IDS: " 1, 2 ,3 " });
    expect([...cfg.emailDomains]).toEqual(["firm.co.uk", "other.com"]);
    expect([...cfg.clioUserIds]).toEqual(["1", "2", "3"]);
  });

  it("treats unset/empty as an empty, unconfigured allowlist", () => {
    expect(isAllowlistConfigured(parseAllowlist({}))).toBe(false);
    expect(isAllowlistConfigured(parseAllowlist({ ALLOWED_EMAIL_DOMAINS: " , ", ALLOWED_CLIO_USER_IDS: "" }))).toBe(false);
  });
});

describe("isIdentityAllowed", () => {
  it("fails closed when nothing is configured — admits no one", () => {
    const d = isIdentityAllowed(id(), parseAllowlist({}));
    expect(d.allowed).toBe(false);
  });

  it("admits an email whose domain matches, case-insensitively", () => {
    const cfg = parseAllowlist({ ALLOWED_EMAIL_DOMAINS: "firm.co.uk" });
    expect(isIdentityAllowed(id({ email: "ADA@Firm.CO.uk" }), cfg).allowed).toBe(true);
  });

  it("rejects an email from a non-listed domain", () => {
    const cfg = parseAllowlist({ ALLOWED_EMAIL_DOMAINS: "firm.co.uk" });
    expect(isIdentityAllowed(id({ email: "attacker@evil.com" }), cfg).allowed).toBe(false);
  });

  it("matches the domain exactly — a subdomain is not a match (no suffix bypass)", () => {
    const cfg = parseAllowlist({ ALLOWED_EMAIL_DOMAINS: "firm.co.uk" });
    expect(isIdentityAllowed(id({ email: "ada@evil.firm.co.uk" }), cfg).allowed).toBe(false);
    expect(isIdentityAllowed(id({ email: "ada@firm.co.uk.evil.com" }), cfg).allowed).toBe(false);
  });

  it("admits an exact Clio user id even with no email", () => {
    const cfg = parseAllowlist({ ALLOWED_CLIO_USER_IDS: "42" });
    expect(isIdentityAllowed(id({ id: "42", email: undefined }), cfg).allowed).toBe(true);
    expect(isIdentityAllowed(id({ id: "43", email: undefined }), cfg).allowed).toBe(false);
  });

  it("rejects when the domain is configured but the identity has no email", () => {
    const cfg = parseAllowlist({ ALLOWED_EMAIL_DOMAINS: "firm.co.uk" });
    expect(isIdentityAllowed(id({ email: undefined }), cfg).allowed).toBe(false);
  });
});
