-- M3 (Leg 2): per-user Clio connections + transient OAuth state.
-- D1 is the source of truth for tokens (read-your-writes; KV's eventual consistency would
-- risk handing back a stale token right after a refresh). Tokens are stored only as
-- AES-256-GCM ciphertext (src/remote/storage/crypto.ts) — never plaintext.

-- One row per connected user. user_id is our stable Leg-1 subject ("clio-<clio_user_id>").
CREATE TABLE IF NOT EXISTS users (
  user_id      TEXT PRIMARY KEY,
  clio_user_id TEXT NOT NULL,
  clio_region  TEXT NOT NULL,          -- token is region-bound; route OAuth + API to this host
  name         TEXT,
  email        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Encrypted Clio access+refresh token set, keyed strictly by user_id (per-user isolation).
CREATE TABLE IF NOT EXISTS clio_tokens (
  user_id     TEXT PRIMARY KEY,
  ciphertext  TEXT NOT NULL,           -- AES-256-GCM( JSON ClioTokenSet )
  expires_at  INTEGER NOT NULL,        -- plaintext copy of access-token expiry (ms) for ops queries
  updated_at  INTEGER NOT NULL
);

-- Transient Leg-2 CSRF state: the Leg-1 AuthRequest stashed against a single-use random `state`
-- while the user logs in at Clio. Consumed (deleted) on /clio/callback; GC'd on expiry.
CREATE TABLE IF NOT EXISTS pending_auth (
  state      TEXT PRIMARY KEY,
  auth_req   TEXT NOT NULL,            -- JSON of the provider AuthRequest to resume
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_auth_expires ON pending_auth (expires_at);
