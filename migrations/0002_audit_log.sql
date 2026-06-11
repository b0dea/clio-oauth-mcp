-- M5: centralized append-only audit log (PRD §M5; "ABA Opinion 512" framing — build-notes §9).
-- One row per Clio tool call, attributed to the authenticated user. Append-only: the application
-- seam never UPDATEs/DELETEs it, and migrations/0003 installs triggers that abort any such attempt
-- at the DB layer — it is the compliance system of record. `args` is redacted JSON (secret-named
-- keys masked before write; src/remote/storage/auditStore.ts).
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT, -- monotonic, never reused (append-only)
  user_id       TEXT NOT NULL,                     -- our stable Leg-1 subject; from the token props, not the args
  clio_user_id  TEXT,                              -- Clio who_am_i id (from props; may be unset)
  session_id    TEXT NOT NULL,                     -- per-request session (= user_id on the Worker)
  tool          TEXT NOT NULL,                     -- upstream tool name, e.g. "list_matters" (the clio_ prefix is added at registration)
  args          TEXT NOT NULL,                     -- redacted JSON of the tool args
  outcome       TEXT NOT NULL,                     -- 'success' | 'error' | 'not_found'
  error_message TEXT,
  matter_id     INTEGER,
  result_count  INTEGER,
  created_at    INTEGER NOT NULL                   -- epoch ms (matches users/clio_tokens timestamps)
);

-- The export path pulls one user's trail in time order (docs/operations.md §audit export).
CREATE INDEX IF NOT EXISTS idx_audit_log_user_created ON audit_log (user_id, created_at);
