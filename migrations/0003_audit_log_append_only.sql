-- M5: enforce audit_log append-only at the DB layer, not just by convention. audit_log is the
-- compliance system of record; the application seam (storage/auditStore.ts AuditRepo) only exposes
-- append(), but these triggers make UPDATE/DELETE impossible even from an ad-hoc `wrangler d1
-- execute` or a future careless call site. Any attempt aborts the statement.
CREATE TRIGGER IF NOT EXISTS audit_log_no_update
  BEFORE UPDATE ON audit_log
  BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
  END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
  BEFORE DELETE ON audit_log
  BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
  END;
