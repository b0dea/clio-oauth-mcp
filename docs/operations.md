# Operations — Clio Remote MCP Connector

Operator runbook. Pilot is deployed at `https://clio-oauth-mcp.beatech.workers.dev`
(CF account `Alex@beatech.dev`). To move it elsewhere, see `docs/migration.md`.

> Status: the Worker is a **skeleton** (health check + 501 stubs). Sections marked
> _(after Mx)_ apply once that milestone lands. The deploy/secrets/upstream-sync parts work now.

## Deploy

```bash
npm install
npm run typecheck:worker
npx wrangler deploy            # -> https://clio-oauth-mcp.beatech.workers.dev
npx wrangler deploy --dry-run --outdir /tmp/wbuild   # validate without uploading
npx wrangler tail             # live logs
```

Bindings (in `wrangler.jsonc`): `OAUTH_KV`, `CLIO_TOKENS` (KV), `DB` (D1), var `CLIO_REGION=EU`.

## Secrets & key rotation

Set per environment (never commit; local dev uses `.dev.vars`):

```bash
wrangler secret put ENCRYPTION_KEY          # 32 bytes, base64 — AES-256-GCM master key
wrangler secret put CLIO_CLIENT_ID
wrangler secret put CLIO_CLIENT_SECRET
wrangler secret put COOKIE_ENCRYPTION_KEY   # signs the OAuth consent cookie
wrangler secret list
```

- **Rotate `CLIO_CLIENT_SECRET`:** rotate in the Clio Developer Portal, then `wrangler secret put`. Existing user tokens stay valid.
- **Rotate `ENCRYPTION_KEY`** _(after M3)_: tokens at rest are only decryptable with the key that wrote them. Plan a re-encrypt pass (decrypt-with-old → encrypt-with-new) or have users re-Connect. Don't rotate it casually.
- **Rotate `COOKIE_ENCRYPTION_KEY`:** invalidates in-flight consent cookies only; safe anytime.

## Register the Clio app (one-time)

One **private** app in the Clio Developer Portal (EU region) against the firm's Clio account:
- Redirect URI: `https://clio-oauth-mcp.beatech.workers.dev/clio/callback` (update if the host changes).
- Access permissions: read/write per `V1_WRITE_SCOPE=all`.
- Copy `client_id`/`client_secret` into the secrets above.
- Private app = single firm, no Clio review needed. (See `docs/build-notes.md` §0/§6.)

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
