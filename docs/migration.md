# Migration runbook — move the repo to a new GitHub org + Cloudflare account

This is a **pilot**, built in a personal GitHub account (`b0dea`) and personal Cloudflare
account (`Alex@beatech.dev`, `3699b6ddabe8729341468d6ebfe8a4ea`). The whole thing is designed
to move to a new org + account with **no source changes** — everything deploy-specific lives in
`wrangler.jsonc`, `wrangler secret`, and git remotes. This doc is the cutover checklist.

## What is pilot-specific today

| Thing | Pilot value | Where it lives |
|---|---|---|
| GitHub fork | `b0dea/clio-oauth-mcp` (fork of `oktopeak/clio-mcp`) | git remote `origin` |
| CF account | `Alex@beatech.dev` · `3699b6ddabe8729341468d6ebfe8a4ea` | `wrangler.jsonc` `account_id` |
| Worker URL | `https://clio-oauth-mcp.beatech.workers.dev` | `name` in `wrangler.jsonc` |
| D1 database | `clio-oauth-mcp` · `8ed13620-de9b-4cfd-8c41-b97633576612` (region EEUR/EU) | `wrangler.jsonc` `d1_databases` |
| KV `OAUTH_KV` | `198e446e34a24736a6cf60ae8427f5c6` | `wrangler.jsonc` `kv_namespaces` |
| KV `CLIO_TOKENS` | `486614165e2e4ce08aebadfe70d952cf` | `wrangler.jsonc` `kv_namespaces` |
| Secrets | `ENCRYPTION_KEY`, `CLIO_CLIENT_ID`, `CLIO_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY` | `wrangler secret` (never in repo) |
| Clio app | one **private** app, redirect URI `https://<host>/clio/callback` | Clio Developer Portal |
| Connector URL | `https://<host>/mcp` (added in Claude) | Claude Desktop / org settings |

## What does NOT change on migration
- **Source code** — nothing hardcodes the org, account, hostname, region, or client IDs.
- The **`upstream`** remote (`oktopeak/clio-mcp`) and the merge discipline.
- The **`CLIO_REGION`** var logic (still drives all Clio URLs).
- The **Clio app** itself, *if* you keep it and just add the new redirect URI (see below).

---

## Part A — GitHub org move

Nothing in code references the org, so this is just remotes + the §0 record.

1. Move the repo to the new org, either:
   - **Transfer** (simplest): GitHub repo → Settings → *Transfer ownership* to `<NEW_ORG>`. Keeps history/issues/PRs. Then on each clone: `git remote set-url origin https://github.com/<NEW_ORG>/clio-oauth-mcp.git`.
   - **Re-fork**: fork `oktopeak/clio-mcp` into `<NEW_ORG>`, then push this repo's `main` to it.
2. Leave `upstream` pointing at `oktopeak/clio-mcp` — `git fetch upstream && git merge upstream/main` keeps working.
3. Update `GITHUB_FORK_ORG` in `README.local.md`.
4. Update any Actions/CI/secrets that name the org (currently none).

---

## Part B — Cloudflare account move

1. **Authenticate to the new account:** `wrangler logout && wrangler login` (or set `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`). Verify with `wrangler whoami`.
2. **Point config at the new account:** set `account_id` in `wrangler.jsonc` to the new account ID (and change `name` if you want a different Worker/subdomain).
3. **Recreate the bindings in the new account** (IDs are account-scoped):
   ```bash
   wrangler d1 create clio-oauth-mcp                 # -> new database_id
   wrangler kv namespace create OAUTH_KV             # -> new id
   wrangler kv namespace create CLIO_TOKENS          # -> new id
   ```
   Paste the three new IDs into `wrangler.jsonc`.
4. **Recreate the D1 schema:** `wrangler d1 migrations apply clio-oauth-mcp --remote` applies `migrations/0001` (`users`, `clio_tokens`, `pending_auth`). It does **not** apply `0002`/`0003` (the `audit_log` table) unless you also enable audit logging — see `docs/operations.md`.
5. **Set secrets in the new account:**
   ```bash
   wrangler secret put ENCRYPTION_KEY            # generate FRESH on the new account — see the rule below
   wrangler secret put CLIO_CLIENT_ID
   wrangler secret put CLIO_CLIENT_SECRET
   # COOKIE_ENCRYPTION_KEY is currently unused (no local consent page) — skip unless a script needs it.
   ```
   Set the firm login gate (vars, not secrets) — **without it no one can connect (fail-closed):**
   ```bash
   # In wrangler.jsonc "vars" (preferred, reviewable) or via secret put:
   #   "ALLOWED_EMAIL_DOMAINS": "yourfirm.co.uk"   (or ALLOWED_CLIO_USER_IDS)
   ```
6. **Deploy:** `wrangler deploy` → new URL (or custom domain, step 9).
7. **Clio app redirect URI:** the app's redirect URI is `https://<WORKER_HOSTNAME>/clio/callback`. If the hostname changes:
   - **Keep the same Clio app** and *add* the new redirect URI in the Developer Portal → existing users' tokens stay valid (tokens bind to the Clio app, not the Worker).
   - Register a **new** Clio app → every user must re-authorize.
8. **Update the connector URL in Claude** (Desktop / org settings) from the old `…/mcp` to the new one — unless you use a stable custom domain (step 9), in which case nothing changes here.
9. **Custom domain (strongly recommended — see below):** add `routes` to `wrangler.jsonc` for the new account's zone and redeploy.
10. **Decommission the pilot** once verified: `wrangler delete` the old Worker, and delete the old D1 + KV in the old account.

### Data migration (only if preserving pilot users/tokens)
- **D1:** `wrangler d1 export clio-oauth-mcp --remote --output dump.sql` (old account), then `wrangler d1 execute clio-oauth-mcp --remote --file=dump.sql` (new account). Carries `users` + `audit_log` (+ token rows if stored in D1).
- **KV:** export/import via `wrangler kv bulk` if you cache tokens there.
- **`ENCRYPTION_KEY` rule:** encrypted Clio tokens are only decryptable with the key that wrote them. **Carry the same `ENCRYPTION_KEY`** to keep migrated tokens usable; a new key means re-encrypt or re-auth.
- **Simplest for a pilot→prod cutover:** don't migrate token data at all — have users click **Connect** again (re-OAuth). Optionally carry only `audit_log` for history. Avoids all key/ciphertext concerns.

---

## The one move that avoids almost all of this: a custom domain early

If you put the Worker behind a stable custom domain (e.g. `clio-mcp.<firm>.com`) **before onboarding
users**, then a Cloudflare-account move only needs that domain re-pointed — the **connector URL and the
Clio redirect URI never change**, so no user re-auth and no Claude reconfiguration. For a pilot that
becomes prod, this is the cheapest insurance. Set it up via `routes` + a `custom_domain: true` entry
in `wrangler.jsonc` once a domain is available.

## Cutover checklist

- [ ] New GitHub org repo exists; `origin` re-pointed; `upstream` unchanged; `GITHUB_FORK_ORG` updated.
- [ ] `wrangler whoami` shows the new account; `account_id` updated in `wrangler.jsonc`.
- [ ] New D1 + 2 KV namespaces created; IDs in `wrangler.jsonc`.
- [ ] D1 schema applied in the new account (`wrangler d1 migrations apply … --remote`).
- [ ] Secrets set in the new account (`ENCRYPTION_KEY`, `CLIO_CLIENT_ID`, `CLIO_CLIENT_SECRET`; ENCRYPTION_KEY decision made).
- [ ] **Firm allowlist set** (`ALLOWED_EMAIL_DOMAINS` and/or `ALLOWED_CLIO_USER_IDS`) — without it login is fail-closed.
- [ ] (Optional) Pilot data migrated, or decision made to have users re-Connect.
- [ ] Clio app redirect URI updated (or new app + users re-auth).
- [ ] `wrangler deploy` succeeds; `/health` returns `region` correct; `/mcp` reachable.
- [ ] Custom domain pointed (if used); connector URL updated in Claude (if host changed).
- [ ] Smoke test: a user connects, `clio_whoami` returns them, a read tool returns their data.
- [ ] Old pilot Worker + D1 + KV deleted.

## Deploy security checklist (before real client data)

- [ ] **Fresh `ENCRYPTION_KEY`** generated on the new account (`openssl rand -base64 32`). Do NOT reuse
      the pilot key or the dev key in `.dev.vars` — both have been visible in working trees.
- [ ] **Firm allowlist configured and verified.** Connect with a firm account (succeeds) and confirm a
      non-firm Clio account is rejected with 403 (or trust the fail-closed default until set).
- [ ] **`WORKER_BASE_URL` re-pinned** to the new host and **byte-identical** to the Clio app redirect URI.
- [ ] **Rate limiter present:** the `AUTH_RATE_LIMITER` binding exists (it fails *open* if absent —
      brute-force protection silently disappears). Verify with the loop in `docs/operations.md`.
- [ ] **Local secrets rotated:** the GitHub PAT + context7/context.dev keys in `.mcp.json` (gitignored,
      never committed, but live in the working tree) — rotate them.
- [ ] **Write scope:** the connector is **read-only by default** (no write tools advertised). Leave it
      that way for a read-only pilot. To enable writes, set `V1_WRITE_SCOPE=all` AND register the Clio
      app read/write — the app scope is the authoritative backstop.
- [ ] Consider a custom domain before onboarding (see above) so future moves need no user re-auth.
