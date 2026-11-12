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

The work runs in jobs with their own names (`node checks`, `python (…)`, `e2e`). The
required names are gates that always run: `checks`, `python` and `preview`
pass when the suites they cover succeeded, or were skipped because the change
cannot affect them. They fail when the detection job failed, or when a suite that
should have run was skipped, failed or was cancelled. Renaming a gate still means
updating the ruleset.

## Preview limits and results

The optional walkthrough GIF step has a three-minute limit, including any ffmpeg
installation. A failed or timed-out GIF step may continue to the required storage
and login suites; their outcomes still determine `e2e`, and so `preview`. Full videos, traces,
screenshots and suite-count summaries remain available through the workflow's
existing artifact/summary steps when those steps can execute. The overall preview
job keeps its twenty-minute limit.
<!-- gate test: docs only -->
