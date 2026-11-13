# CI merge gates

GitHub Actions reports results; the repository ruleset determines which results
must pass before a PR can merge. Changing workflow YAML alone does not enforce
those merge gates.

## Required checks for main

The [`main rule`](https://github.com/dnlintsm/knowledge-chatroom/settings/rules/24551761)
requires three checks from **GitHub Actions** (app ID `15368`), with branches up to date
before merging:

- `checks` (Quality: lint, typechecks and service-free units)
- `python` (Quality: Python lint, types, model check and tests on 3.12 and 3.14)
- `preview` (UI preview: production build plus browser, storage, login and Python agent E2E)

The rule also keeps the PR, deletion and non-fast-forward rules. All three checks report
on every PR, including documentation changes: they are gate jobs (see below). Do not
require the
Storage workflow's `test` context unconditionally: it is path-filtered and would
leave unrelated PRs waiting for a check that never starts. Storage/login E2E remain
covered by the always-running `preview` check; storage-related changes additionally
run the larger integration suite.

Verify the saved setting with an account that can read repository rules:

```bash
gh api repos/dnlintsm/knowledge-chatroom/rulesets/24551761 \
  --jq '.rules[] | select(.type == "required_status_checks")'
```

The result should list `checks`, `python` and `preview` with
`strict_required_status_checks_policy: true` (it did when last checked, on
2026-11-12). No matching result means the rule no longer enforces status checks.
Changing the rule needs a repository administrator, or a GitHub App with
**Administration: write**; editing workflow YAML doesn't change it. If a job is
renamed, update the required contexts too, or every PR waits for a check that never
reports.

## Which suites run for a change

[`scripts/ci-changes.mjs`](../scripts/ci-changes.mjs) maps the PR's changed paths
(the merge commit against its base, renames counted on both sides) to the suites
they can affect ([issue #192](https://github.com/dnlintsm/knowledge-chatroom/issues/192)):

| Changed paths | Node checks | Python | Browser E2E + preview images | Storage + login E2E | Python agent E2E |
| --- | :-: | :-: | :-: | :-: | :-: |
| `docs/**`, root `README.md`, `CHANGELOG.md`, `LICENSE` | | | | | |
| `services/lab-tools/**`, `services/papers-mcp/**`, `examples/python-agent/**`, `pyrefly-baseline.json` | | ✓ | | | |
| `services/api-py/**` | | ✓ | | ✓ | |
| `services/agent-py/**` | | ✓ | | | ✓ |
| `packages/knowledge-py/**`, `pyproject.toml`, `uv.lock`, `.python-version` | | ✓ | | ✓ | ✓ |
| Anything else | ✓ | ✓ | ✓ | ✓ | ✓ |

Pushes to `main`, manual runs and a diff that can't be computed run everything. A
new directory runs everything until it gets a narrower rule; add one in
`RULES` with a case in `tests/unit/ci-changes.spec.ts`.

The work runs in jobs with their own names (`node checks`, `python tests (…)`,
`e2e-browser`, `e2e-storage`, `e2e-python`). The
required names are gates that always run: `checks`, `python` and `preview`
pass when the suites they cover succeeded, or were skipped because the change
cannot affect them. They fail when the detection job failed, or when a suite that
should have run was skipped, failed or was cancelled. Renaming a gate still means
updating the ruleset.

## Preview limits and results

`ui-preview.yml` runs the E2E suites in parallel jobs, each on its own runner, so
each has its own database, S3, ports and output folders ([issue #219](https://github.com/dnlintsm/knowledge-chatroom/issues/219)):

- `e2e-browser`: the walkthrough and the other browser specs. No server storage.
- `e2e-storage`: storage E2E, then login E2E, in sequence on one Postgres/S3 pair,
  with api-py in front of the agent server.
- `e2e-python`: the chat on the Python agent. No server storage.

Each job builds the app itself (`.github/actions/e2e-setup`) and uploads its own
artifact (`ui-preview-<PR>-browser`, `-storage`, `-python`) with videos, traces,
screenshots and reports, and writes its suites' counts to its job summary. Those
two steps are diagnostics: they run `continue-on-error`, so a failed upload or
summary leaves the job, and `preview`, to the suite results. They still run inside
the job, so `preview` waits for them: the upload has to happen on the runner that
holds the files. In the runs measured for #219 it took 2–3 s per job.

`preview` waits only for those jobs. The walkthrough GIF, the images on the
`ui-previews` branch and the sticky comment come afterwards from `publish`, which
is not required, so a slow or failed GIF, image push or comment never holds up a
merge. `publish` is the only job with a write token, and it runs no code from the
PR: it reads the artifacts as data and takes `scripts/preview-gif.sh` from the base
branch, so a change to that script takes effect after it merges. Fork PRs skip
`publish` and keep the artifacts. The GIF step has a three-minute limit, including
any ffmpeg installation; each E2E job has a twenty-minute limit.

A newer push cancels the older run. `publish` does not start in a cancelled run,
and it pushes images and writes the comment only while its commit is still the
PR's head (checked before the push and again just before the comment), so an
older run cannot replace a newer run's preview.
<!-- gate test commit B -->
