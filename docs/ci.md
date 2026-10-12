# CI merge gates

GitHub Actions reports results; the repository ruleset determines which results
must pass before a PR can merge. Changing workflow YAML alone does not enforce
those merge gates.

## Required checks for main

An administrator should update the existing
[`main rule`](https://github.com/dnlintsm/knowledge-chatroom/settings/rules/24551761):

1. Enable **Require status checks to pass**.
2. Require `checks` (Quality: lint, both typechecks and service-free units) and
   `preview` (production build plus browser, storage and login E2E).
3. Select **GitHub Actions** as their source (app ID `15368`) and require branches
   to be up to date before merging.
4. Keep the existing PR, deletion and non-fast-forward rules. Review the existing
   integration bypass separately; requiring checks does not remove bypass access.

Both checks run for every PR, including documentation changes. Do not require the
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
`strict_required_status_checks_policy: true`. No matching result means this rule
does not enforce status checks. As of the 2026-10-12 review, the active rule has no
required status checks. The environment's integration token returned HTTP 403
when updating it; a GitHub App needs repository **Administration: write**, or an
administrator must apply the setting in the UI. This document does not apply it.

## Preview limits and results

The optional walkthrough GIF step has a three-minute limit, including any ffmpeg
installation. A failed or timed-out GIF step may continue to the required storage
and login suites; their outcomes still determine `preview`. Full videos, traces,
screenshots and suite-count summaries remain available through the workflow's
existing artifact/summary steps when those steps can execute. The overall preview
job keeps its twenty-minute limit.
