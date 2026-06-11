# Operations — Clio Remote MCP Connector

Operator runbook. Pilot is deployed at `https://clio-oauth-mcp.beatech.workers.dev`
(CF account `Alex@beatech.dev`). To move it elsewhere, see `docs/migration.md`.

> Status: full two-leg OAuth + 21 multi-tenant Clio tools are live (M0–M6). Each user connects
> their own Clio account; per-user tokens are AES-256-GCM ciphertext at rest. Audit logging is
> present but **OFF by default** (see below). Live two-user acceptance is gated on a real Clio app
> (see "Register the Clio app").

## Deploy

```bash
npm install
npm run typecheck:worker
npx wrangler deploy            # -> https://clio-oauth-mcp.beatech.workers.dev
npx wrangler deploy --dry-run --outdir /tmp/wbuild   # validate without uploading
npx wrangler tail             # live logs
```

Bindings (in `wrangler.jsonc`): `OAUTH_KV`, `CLIO_TOKENS` (KV), `DB` (D1), `AUTH_RATE_LIMITER`
(Rate Limiting), vars `CLIO_REGION=EU` and `WORKER_BASE_URL` (the public origin — the Leg-2
redirect_uri is pinned to it; keep it equal to the host and to the URI registered on the Clio app).

## Secrets & key rotation

Set per environment (never commit; local dev uses `.dev.vars`):

```bash
wrangler secret put ENCRYPTION_KEY          # 32 bytes, base64 — AES-256-GCM master key
wrangler secret put CLIO_CLIENT_ID
wrangler secret put CLIO_CLIENT_SECRET
wrangler secret put COOKIE_ENCRYPTION_KEY   # signs the OAuth consent cookie
wrangler secret list
```

### Rotating each secret — what it forces

- **`ENCRYPTION_KEY` (AES-256-GCM master key for tokens at rest) — needs a re-encrypt migration; do NOT swap it in place.**
  Every `clio_tokens.ciphertext` row is decryptable only with the key that wrote it. Swapping the
  secret without re-encrypting makes every `decrypt()` fail closed (GCM auth-tag mismatch), so every
  user's next tool call errors and effectively all users are disconnected until they re-Connect.
  To rotate without disconnecting anyone, run a one-off migration **with both keys available**:
  1. Read all rows: `SELECT user_id, ciphertext FROM clio_tokens`.
  2. For each: `decrypt(OLD_KEY, ciphertext)` → `encrypt(NEW_KEY, plaintext)`.
  3. Write back the new ciphertext (`UPDATE clio_tokens SET ciphertext=?, updated_at=? WHERE user_id=?`).
  4. Only then `wrangler secret put ENCRYPTION_KEY` (the new key) and redeploy; invalidate the
     `CLIO_TOKENS` KV cache (it holds ciphertext — `wrangler kv key delete` the `clio-token:*` keys,
     or just let the ≤300s TTL expire) so no row is read back under the old key.
  `src/remote/storage/crypto.ts` exports `generateKeyBase64()` for the new 32-byte key, and
  `encrypt`/`decrypt` are the exact primitives the migration must use. Absent this pass, the only
  recovery is every user re-Connecting (re-runs Leg 2, writes fresh ciphertext under the new key).
- **`CLIO_CLIENT_SECRET` — no user re-auth.** Rotate in the Clio Developer Portal, then
  `wrangler secret put CLIO_CLIENT_SECRET`. Existing access/refresh tokens stay valid; only new code
  exchanges/refreshes use the new secret.
- **`CLIO_CLIENT_ID` — forces every user to re-Connect.** The client_id is baked into each user's
  grant; changing it (or registering a new Clio app) invalidates existing authorizations, so every
  attorney must reconnect from Claude. Treat it as a new-app event, not a rotation.
- **`COOKIE_ENCRYPTION_KEY` — safe anytime.** Invalidates only in-flight OAuth consent cookies (a
  user mid-connect retries); stored Clio tokens are unaffected.

## Register the Clio app (one-time)

One **private** app in the Clio Developer Portal (EU region) against the firm's Clio account:
- Redirect URI: `https://clio-oauth-mcp.beatech.workers.dev/clio/callback` (update if the host changes).
- Access permissions: read/write per `V1_WRITE_SCOPE=all`.
- Copy `client_id`/`client_secret` into the secrets above.
- Private app = single firm, no Clio review needed. (See `docs/build-notes.md` §0/§6.)

## Public-endpoint rate limiting

`/authorize`, `/token`, `/register`, and `/clio/callback` are rate-limited per client IP by the
`AUTH_RATE_LIMITER` binding (Workers native Rate Limiting — ephemeral edge counters, **no persistent
activity log**). Default: 60 requests / 60s per IP; over-limit gets `429` + `Retry-After: 60`. `/mcp`
is excluded (bearer-gated; Clio rate-limits per access token).

- The limit is keyed by IP. `/authorize` + `/clio/callback` carry the end user's browser IP;
  `/token` + `/register` come from the MCP client's (shared) egress IPs — so the limit is
  deliberately generous to avoid throttling legitimate shared-IP traffic. Raise `limit` (or set
  `period` to 10 for a tighter window) in `wrangler.jsonc` → `ratelimits` if real traffic ever trips.
- The Worker **fails open** if the binding is absent (a misconfig must not brick login). To verify
  enforcement after deploy, hammer one endpoint from one IP and watch for a `429`:
  `for i in $(seq 1 70); do curl -s -o /dev/null -w "%{http_code}\n" https://clio-oauth-mcp.beatech.workers.dev/register -X POST; done | sort | uniq -c`

## Audit / connection logging — OFF by default

The pilot persists **no** audit log or connection log unless explicitly enabled.

- The audit code (M5: an append-only D1 `audit_log`, one row per Clio tool call) is present but
  **disabled** — gated behind the `AUDIT_LOG_ENABLED` var (default unset = off). With it off, no writer
  is attached and nothing is written; the `audit_log` table is **not deployed** (migrations `0002`/`0003`
  exist in the repo but are not applied remotely — `wrangler deploy` never applies migrations).
- Workers `observability` is `false`: no request/connection logs stored in Cloudflare. `wrangler tail`
  still streams logs live for debugging (nothing retained server-side).
- The only persistent store is the per-user **OAuth token** D1 (`users`, `clio_tokens`, `pending_auth`)
  — credentials the connection needs, not activity logs. Tokens are AES-256-GCM ciphertext at rest.

### Enable audit logging (if/when wanted)

```bash
# 1. Create the audit_log table + its append-only triggers on the remote D1:
CLOUDFLARE_ACCOUNT_ID=<id> wrangler d1 migrations apply clio-oauth-mcp --remote
# 2. Turn the writer on (add to wrangler.jsonc "vars", or set in the dashboard), then redeploy:
#    "vars": { "CLIO_REGION": "EU", "AUDIT_LOG_ENABLED": "true" }
wrangler deploy
```

Then each Clio tool call writes one redacted, append-only row attributed to the authenticated user.
`args` is redacted JSON — secret-named keys (`access_token`, `refresh_token`, `client_secret`,
`password`, `token`, `encryption_key`) are masked at write time. The table is append-only at the DB
layer: triggers abort any `UPDATE`/`DELETE`. Export is **out-of-band only** — never an in-MCP tool
(every user holds an identical token shape, so an in-band export would read across tenants; PRD §7):

```bash
# One user's trail, oldest first (created_at is epoch ms):
wrangler d1 execute clio-oauth-mcp --remote --command \
  "SELECT datetime(created_at/1000,'unixepoch') AS ts_utc, tool, outcome, error_message, matter_id, result_count, args \
     FROM audit_log WHERE user_id = 'clio-<clioUserId>' ORDER BY created_at;"
```

To turn audit **off** again: unset `AUDIT_LOG_ENABLED` (or set it to anything but `"true"`) and redeploy.
Existing rows remain (the table is append-only); drop the table manually if you want them gone.

## Upstream sync runbook (keep pulling Clio fixes)

Cadence: check `oktopeak/clio-mcp` periodically (it last shipped v2.0.0, May 2026).

```bash
git fetch upstream
git merge upstream/main           # new code is under src/remote/ → conflicts should be rare
npm install                       # if upstream changed deps
npm run build                     # stdio baseline must stay green
npm run typecheck:worker
npm test
# (after M6) run the per-user isolation test + a smoke test
npx wrangler deploy
git tag upstream-sync/$(date +%Y-%m-%d)
git push origin main --tags
```

Record the merged upstream SHA + any resolved conflicts in `CHANGELOG.local.md`. If a conflict lands
in `tokenStorage.ts` / `auditLog.ts` / `oauth.ts` (the three rewritten files — see `docs/build-notes.md` §7),
re-apply our Workers internals while keeping the exported signatures identical.

## Data-flow note (for the firm's records)

Tool results reach Anthropic's models for inference, as with any Claude connector (Team/Enterprise =
no training on your data). Self-hosting this connector adds **no third-party processor beyond Anthropic** —
unlike a shared gateway, which would interpose its own identity and processor. Each attorney's data stays
isolated to their own Clio account and their own encrypted tokens.
