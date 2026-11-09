-- Where a run came from (issue #82, step 2): who started it and from which
-- chat, the model, skill and tool versions, and the exact versions of the
-- files it read. Set by the agent when it starts a run and when it records
-- the results; the API shows it but doesn't take it, so it stays a record of
-- what happened rather than something anyone can edit.

ALTER TABLE experiments ADD COLUMN provenance jsonb NOT NULL DEFAULT '{}'
  CHECK (jsonb_typeof(provenance) = 'object');
