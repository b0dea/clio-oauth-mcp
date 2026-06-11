# Credentials & secrets

What each secret is, where it comes from, and what to ask for when someone else provisions it.
Set every secret with `wrangler secret put <NAME>` (prod) or in `.dev.vars` (local, gitignored).
Never commit them — `wrangler.jsonc` deliberately holds none.

## Two kinds of secret

| Kind | Vars | Who creates it |
|------|------|----------------|
| **Clio-issued** (you copy them) | `CLIO_CLIENT_ID`, `CLIO_CLIENT_SECRET` | Clio, when you register the developer app |
| **Self-generated** (you mint them) | `ENCRYPTION_KEY` | You — a random key, see below |

## CLIO_CLIENT_ID / CLIO_CLIENT_SECRET — your OAuth app identity

These are **your registered Clio application's** credentials, not any user's. They make the Worker a
*confidential OAuth 2.0 client* of Clio (Leg 2: us ↔ Clio).

- **`CLIO_CLIENT_ID`** — public identifier of the app. Sent on the `/authorize` redirect
  (`buildClioAuthorizeUrl`) so Clio knows which app is asking, and which redirect URI + scopes are allowed.
- **`CLIO_CLIENT_SECRET`** — the app's password. Sent **server-to-server only** at Clio's token endpoint to
  (a) exchange the auth code for tokens (`exchangeClioCode`) and (b) refresh expired access tokens
  (`refreshClioTokens`). It proves the call comes from your app, not from someone who only saw the public id.

Every firm user who connects authorizes through this **one** app; their per-user tokens are minted under it.
The app registration also pins:
- the **scopes** (app-level read-only vs. read/write per Clio resource — the connector-wide ceiling), and
- the allowed **redirect URI**, which must be exactly `https://clio-oauth-mcp.beatech.workers.dev/clio/callback`
  (derived from the request origin in `clio-handler.ts:callbackRedirectUri`; update both if the host changes).

You do **not** generate these — you register the app in the Clio Developer Portal and copy the values out.

## ENCRYPTION_KEY — the one you generate

AES-256-GCM key that encrypts every user's Clio tokens at rest in D1/KV (`storage/crypto.ts`).

- **Format:** 32 random bytes, base64-encoded (a 44-char string ending in `=`). It must decode to exactly
  32 bytes or `importKey` throws. No KDF — the raw bytes are the key, so they must be uniformly random.
- **Generate it** (any one):
  ```sh
  openssl rand -base64 32
  # or
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```
  The repo also ships `generateKeyBase64()` in `storage/crypto.ts`.
- **Rotation** re-encrypts the store: rotating this key invalidates all stored tokens, so every user must
  reconnect. Treat it as long-lived.

## COOKIE_ENCRYPTION_KEY — currently unused

Declared in `env.ts` and named in older docs, but **nothing in the codebase reads it**: the OAuth provider
library ships no cookie code, and this connector has no local consent screen (consent happens at Clio's own
login). It's a leftover from the Cloudflare template's approval-dialog pattern. Safe to skip; if you set it to
satisfy a script, any random string works, but it has no effect today.

## Setting them

```sh
wrangler secret put CLIO_CLIENT_ID
wrangler secret put CLIO_CLIENT_SECRET
wrangler secret put ENCRYPTION_KEY
```

Region (`CLIO_REGION`) is a plain var in `wrangler.jsonc` (`EU` for the pilot), not a secret.

## Asking someone else to provision these

**To the Clio account admin / developer-portal owner:**

> Please register a Clio **private** developer application against our firm's Clio account (region: **EU**)
> and send me its **Client ID** and **Client Secret**. Set the redirect URI to
> `https://clio-oauth-mcp.beatech.workers.dev/clio/callback`. Grant **[read-only | read/write]** access to:
> Matters, Contacts, Activities, Calendars, Tasks, Documents, Notes, Bills/Billing, and Users. It must be an
> OAuth 2.0 authorization-code app (confidential client) — not an API key.

**To an engineer, for the encryption key:**

> Generate a 32-byte random key, base64-encoded — `openssl rand -base64 32` — and send it over a secure
> channel. It's the AES-256 key for encrypting tokens at rest.
