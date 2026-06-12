/**
 * Firm identity allowlist (Leg-2 gate). The connector serves a SINGLE firm, but a Clio Manage
 * private app is not firm-bound at Clio's side ("private" only means "not in the App Directory"),
 * so any Clio user who reaches /authorize could otherwise complete login. This restricts who may
 * connect to the firm's own people, checked against the Clio-attested who_am_i identity.
 *
 * Fail-closed: if neither allowlist var is set, NO identity is admitted. Logging in must require an
 * explicit entry — an unconfigured connector that silently let everyone in would defeat the gate.
 *
 * Config (comma-separated; set as wrangler `vars` or `wrangler secret put`):
 *   ALLOWED_EMAIL_DOMAINS  bare domains, e.g. "firm.co.uk,firm.com" — matched against the who_am_i
 *                          email domain, case-insensitive, exact (a subdomain is NOT a match).
 *   ALLOWED_CLIO_USER_IDS  exact Clio who_am_i ids, e.g. "12345,67890".
 */

import type { ClioIdentity } from "../clio/oauth.js";

export interface AllowlistConfig {
  /** Lowercased bare domains (no leading "@"). */
  emailDomains: Set<string>;
  /** Exact Clio who_am_i ids. */
  clioUserIds: Set<string>;
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseAllowlist(env: { ALLOWED_EMAIL_DOMAINS?: string; ALLOWED_CLIO_USER_IDS?: string }): AllowlistConfig {
  return {
    emailDomains: new Set(splitCsv(env.ALLOWED_EMAIL_DOMAINS).map((d) => d.toLowerCase().replace(/^@/, ""))),
    clioUserIds: new Set(splitCsv(env.ALLOWED_CLIO_USER_IDS)),
  };
}

export function isAllowlistConfigured(cfg: AllowlistConfig): boolean {
  return cfg.emailDomains.size > 0 || cfg.clioUserIds.size > 0;
}

export type AllowDecision = { allowed: true } | { allowed: false; reason: string };

/** Decide whether a Clio identity may connect. Fail-closed when no allowlist is configured. */
export function isIdentityAllowed(identity: ClioIdentity, cfg: AllowlistConfig): AllowDecision {
  if (!isAllowlistConfigured(cfg)) {
    return { allowed: false, reason: "no allowlist configured (set ALLOWED_EMAIL_DOMAINS or ALLOWED_CLIO_USER_IDS)" };
  }
  if (cfg.clioUserIds.has(identity.id)) {
    return { allowed: true };
  }
  const email = identity.email?.trim().toLowerCase();
  const at = email ? email.lastIndexOf("@") : -1;
  const domain = at >= 0 ? email!.slice(at + 1) : "";
  if (domain && cfg.emailDomains.has(domain)) {
    return { allowed: true };
  }
  return { allowed: false, reason: "identity is not on the firm allowlist" };
}
