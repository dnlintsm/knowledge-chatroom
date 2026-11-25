-- Runs (docs/experiment-runs.md): an Experiment is the question, a Run one
-- execution of it. A Run has its own number in the Experiment, the parameters
-- it ran with, its results and state, its provenance, the Rules reads, and at
-- finish a record of every file of the Experiment as it was then (path,
-- version, sha256, size). Runs work in the Experiment's working files, so the
-- record, not a copy, is the evidence (docs/run-evidence.md, decision 1).
--
-- For one release the Experiment's own state, results and provenance stay,
-- as its latest live Run's, so the routes that predate Runs keep answering.

CREATE TABLE runs (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  number        integer NOT NULL CHECK (number > 0),
  label         text NOT NULL DEFAULT '' CHECK (char_length(label) <= 200),
  params        jsonb NOT NULL DEFAULT '{}',
  results       jsonb NOT NULL DEFAULT '{}',
  state         text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done', 'failed')),
  provenance    jsonb NOT NULL DEFAULT '{}',
  started_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  -- [{path, version, sha256, size}], taken when it finished; NULL while running.
  record        jsonb,
  -- 'finish', or 'migration' for one taken when Runs were split from
  -- Experiments, which can't say what changed after the run ended.
  record_taken  text CHECK (record_taken IN ('finish', 'migration')),
  archived_at   timestamptz,
  deleted_at    timestamptz,
  deleted_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (experiment_id, number),
  CHECK ((state = 'running') = (record IS NULL)),
  CHECK ((record IS NULL) = (record_taken IS NULL))
);

CREATE INDEX runs_experiment ON runs (experiment_id, number DESC);
-- One running Run per Experiment: they share its working files.
CREATE UNIQUE INDEX runs_one_running ON runs (experiment_id)
  WHERE state = 'running' AND deleted_at IS NULL;

-- A finished Run stays as it ended, for everyone and through any route. Its
-- label, archiving and deletion can still change.
CREATE FUNCTION runs_finished() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'running' AND (
       NEW.params IS DISTINCT FROM OLD.params
    OR NEW.results IS DISTINCT FROM OLD.results
    OR NEW.state IS DISTINCT FROM OLD.state
    OR NEW.provenance IS DISTINCT FROM OLD.provenance
    OR NEW.record IS DISTINCT FROM OLD.record
    OR NEW.record_taken IS DISTINCT FROM OLD.record_taken
    OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
    OR NEW.started_by IS DISTINCT FROM OLD.started_by
    OR NEW.number IS DISTINCT FROM OLD.number
    OR NEW.experiment_id IS DISTINCT FROM OLD.experiment_id
  ) THEN
    RAISE EXCEPTION 'This run already finished (%); a correction is a new run', OLD.state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER runs_finished BEFORE UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION runs_finished();

-- Row-level security (004_row_security.sql): whoever can see the Experiment
-- sees its Runs; its maintainer and collaborators start and change them while
-- it isn't archived.
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY runs_read ON runs FOR SELECT
  USING (experiment_access(app_user(), experiment_id) IS NOT NULL);
CREATE POLICY runs_add ON runs FOR INSERT
  WITH CHECK (experiment_access(app_user(), experiment_id) = 'writer');
CREATE POLICY runs_change ON runs FOR UPDATE
  USING (experiment_access(app_user(), experiment_id) = 'writer')
  WITH CHECK (experiment_access(app_user(), experiment_id) = 'writer');
-- knowledge_user gets SELECT, INSERT and UPDATE on runs at startup
-- (prepare_row_security in api-py).

-- The Rules reads belong to the Run that was running.
ALTER TABLE run_reads ADD COLUMN run_id uuid REFERENCES runs(id) ON DELETE CASCADE;

-- The record of an Experiment's live files as they are now.
CREATE FUNCTION experiment_file_record(exp uuid) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'path', f.path, 'version', v.id, 'sha256', v.blob_sha256, 'size', v.size)
         ORDER BY f.path), '[]'::jsonb)
  FROM files f JOIN file_versions v ON v.id = f.current_version_id
  WHERE f.experiment_id = exp AND f.deleted_at IS NULL
$$;

-- Moves Experiments that ran before Runs existed over: each one whose state
-- is running, done or failed gets Run 1 with its parameters, results, state,
-- provenance and Rules reads. A finished one's record is taken now and marked
-- so. A rerun's provenance also names the Run 1 of the Experiment it reran.
-- Experiments that already have a Run are left alone, so this can run again.
CREATE FUNCTION runs_backfill() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  added integer;
BEGIN
  WITH ran AS (
    SELECT gen_random_uuid() AS run_id, e.*
    FROM experiments e
    WHERE e.state IN ('running', 'done', 'failed')
      AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.experiment_id = e.id)
  ), firsts AS (
    SELECT experiment_id, id FROM runs WHERE number = 1
    UNION ALL
    SELECT id, run_id FROM ran
  )
  INSERT INTO runs (id, workspace_id, experiment_id, number, params, results, state, provenance,
                    started_by, started_at, finished_at, record, record_taken)
  SELECT e.run_id, e.workspace_id, e.id, 1, e.params, e.results, e.state,
         CASE WHEN src.id IS NOT NULL AND NOT (e.provenance->'rerunOf' ? 'run')
              THEN jsonb_set(e.provenance, '{rerunOf,run}', to_jsonb(src.id::text))
              ELSE e.provenance END,
         CASE WHEN (e.provenance->'startedBy'->>'id') ~* '^[0-9a-f-]{36}$'
                   AND EXISTS (SELECT 1 FROM users u WHERE u.id::text = lower(e.provenance->'startedBy'->>'id'))
              THEN (e.provenance->'startedBy'->>'id')::uuid ELSE e.author_id END,
         coalesce(CASE WHEN e.provenance->>'startedAt' ~ '^\d{4}-' THEN (e.provenance->>'startedAt')::timestamptz END,
                  e.forked_at),
         CASE WHEN e.state = 'running' THEN NULL
              ELSE coalesce(CASE WHEN e.provenance->>'finishedAt' ~ '^\d{4}-'
                                 THEN (e.provenance->>'finishedAt')::timestamptz END, e.updated_at) END,
         CASE WHEN e.state = 'running' THEN NULL ELSE experiment_file_record(e.id) END,
         CASE WHEN e.state = 'running' THEN NULL ELSE 'migration' END
  FROM ran e
  LEFT JOIN firsts src
    ON jsonb_typeof(e.provenance->'rerunOf') = 'object'
   AND src.experiment_id::text = lower(e.provenance->'rerunOf'->>'id');
  GET DIAGNOSTICS added = ROW_COUNT;

  UPDATE run_reads rr SET run_id = r.id
  FROM runs r
  WHERE rr.run_id IS NULL AND r.experiment_id = rr.experiment_id AND r.number = 1;
  RETURN added;
END $$;

SELECT runs_backfill();

-- Reads of Experiments that never ran can't be (a read needs a running run),
-- but are dropped rather than left without a Run.
DELETE FROM run_reads WHERE run_id IS NULL;
ALTER TABLE run_reads ALTER COLUMN run_id SET NOT NULL;
ALTER TABLE run_reads DROP CONSTRAINT run_reads_pkey;
ALTER TABLE run_reads ADD PRIMARY KEY (run_id, path, version_id);
