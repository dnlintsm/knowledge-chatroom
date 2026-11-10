-- Read-only files that may still be deleted, such as a run's generated
-- models/general_rules.md: their content never changes, but an editor can
-- delete one so the run's Generate Rules action can write it afresh. Other
-- read-only files (an experiment's linked inputs, locked skill files) stay
-- undeletable. Like read_only, it is set only when a file is created.
ALTER TABLE files ADD COLUMN deletable boolean NOT NULL DEFAULT false;

-- Rules files generated before this migration. Linked inputs are copies
-- (forked_from is set), so they never match.
UPDATE files SET deletable = true
WHERE read_only AND forked_from IS NULL AND deleted_at IS NULL
  AND (path = 'models/general_rules.md' OR path LIKE '%/models/general_rules.md');
