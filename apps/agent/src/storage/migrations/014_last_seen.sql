-- When each user was last active, for the admin panel (#67). Set when the
-- agent sees a signed-in request (at most every few minutes per user); NULL
-- for users not seen since this column was added.

ALTER TABLE users ADD COLUMN last_seen_at timestamptz;

-- The admin panel filters the audit log by kind (group.*, grant.*).
CREATE INDEX audit_log_by_kind ON audit_log (workspace_id, split_part(action, '.', 1), at DESC);
