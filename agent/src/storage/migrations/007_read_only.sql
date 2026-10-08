-- Files that may never change once written, such as a run's generated
-- models/general_rules.md (issue #13). Writes and deletes are refused.
ALTER TABLE files ADD COLUMN read_only boolean NOT NULL DEFAULT false;
