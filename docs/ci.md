# CI merge gates

GitHub Actions reports results; the repository ruleset determines which results
must pass before a PR can merge. Changing workflow YAML alone does not enforce
those merge gates.

## Required checks for main

The [`main rule`](https://github.com/dnlintsm/knowledge-chatroom/settings/rules/24551761)
requires two checks from **GitHub Actions** (app ID `15368`), with branches up to date
before merging:

- `checks` (Quality: lint, typechecks and service-free units)
- `preview` (UI preview: production build plus browser, storage and login E2E)

The rule also keeps the PR, deletion and non-fast-forward rules. Both checks run for
every PR, including documentation changes. Do not require the
Storage workflow's `test` context unconditionally: it is path-filtered and would
leave unrelated PRs waiting for a check that never starts. Storage/login E2E remain
covered by the always-running `preview` check; storage-related changes additionally
run the larger integration suite.

Verify the saved setting with an account that can read repository rules:

```bash
gh api repos/dnlintsm/knowledge-chatroom/rulesets/24551761 \
  --jq '.rules[] | select(.type == "required_status_checks")'
```

The result should list `checks` and `preview` with
`strict_required_status_checks_policy: true` (it did when last checked, on
2026-11-06). No matching result means the rule no longer enforces status checks.
Changing the rule needs a repository administrator, or a GitHub App with
**Administration: write**; editing workflow YAML doesn't change it. If a job is
renamed, update the required contexts too, or every PR waits for a check that never
reports.

## Preview limits and results

The optional walkthrough GIF step has a three-minute limit, including any ffmpeg
installation. A failed or timed-out GIF step may continue to the required storage
and login suites; their outcomes still determine `preview`. Full videos, traces,
screenshots and suite-count summaries remain available through the workflow's
existing artifact/summary steps when those steps can execute. The overall preview
job keeps its twenty-minute limit.
