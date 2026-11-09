-- Hub trust (issue #7, step 4): what the publish-time scan found, admins'
-- verification and publishers' yanks per version, and reports on a skill.

ALTER TABLE hub_skill_versions
  -- [{kind, path, line, detail}] from scan.ts; NULL until the version is
  -- scanned (versions published before this migration are scanned on first read).
  ADD COLUMN flags        jsonb,
  ADD COLUMN verified_at  timestamptz,
  ADD COLUMN verified_by  uuid REFERENCES users(id),
  -- A yanked version can't be newly installed; installs of it keep working.
  ADD COLUMN yanked_at    timestamptz,
  ADD COLUMN yanked_by    uuid REFERENCES users(id),
  ADD COLUMN yank_reason  text CHECK (length(yank_reason) <= 500);

CREATE TABLE hub_skill_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hub_skill_id  uuid NOT NULL REFERENCES hub_skills(id) ON DELETE CASCADE,
  -- The version the reporter looked at, if they said.
  version       integer,
  reporter_id   uuid NOT NULL REFERENCES users(id),
  reason        text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  dismissed_at  timestamptz,
  dismissed_by  uuid REFERENCES users(id)
);

-- One open report per person and skill; reporting again updates it.
CREATE UNIQUE INDEX hub_skill_reports_open
  ON hub_skill_reports (hub_skill_id, reporter_id) WHERE dismissed_at IS NULL;
