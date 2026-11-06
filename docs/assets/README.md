# README screenshots

These PNGs are unmodified captures of the actual application using sample data
and deterministic mock chat. They are checked in so the README does not depend
on expiring workflow artifacts or preview folders removed when a PR closes.

| Asset | Original capture | What it shows |
| --- | --- | --- |
| `workspace.png` | `02-focus-run.png` (now `02-run.png`) | A run (captured before runs became experiments, #82): files, report, chat, skills status, and actions |
| `experiments.png` | `19-experiment-compare.png` | Knowledge tree, experiment details, and results comparison |
| `review-changes.png` | `21-review.png` | Proposed changes and file diffs before acceptance |

Source: [successful UI preview run](https://github.com/dnlintsm/knowledge-chatroom/actions/runs/38196162641)
for application commit `76814f3327848ca7c8f742a68ef3ce929f1bd5ee` (PR #34), captured
on 2026-10-12. The original PNGs also appear in the immutable
[preview commit](https://github.com/dnlintsm/knowledge-chatroom/tree/da1f473f4bb49f689dedafa748c74be14a944d23/pr-34/76814f3327848ca7c8f742a68ef3ce929f1bd5ee/screenshots).

To refresh after a UI change, follow [Testing](../testing.md) to run the storage E2E
suite (`npm run test:e2e:storage`) against disposable services. Runs need server
storage, so all three captures now come from it, in `preview/screenshots/`:
`02-run.png` (`e2e/runs.spec.ts`), `19-experiment-compare.png` and `21-review.png`
(`e2e/knowledge.spec.ts`). Copy them here under the asset names above, inspect them for
readability, and update this source reference. Use sample workspace data for
documentation captures.
