# Run evidence and recovery (design)

Status: **built**, tracked in
[#267](https://github.com/dnlintsm/knowledge-chatroom/issues/267) (batch A), the
execution-traceability follow-ups of
[#178](https://github.com/dnlintsm/knowledge-chatroom/issues/178#issuecomment-6817847479).

A run is still an Experiment with a report (see "Runs are experiments" in
[architecture.md](architecture.md#runs-are-experiments)). This batch doesn't split Experiment
from Run. It makes what a run already records visible and checkable, records the one thing
it doesn't (which Rules it read), and lets a deleted Experiment come back. The rules below
come from the conditions agreed in
[#178 (comment)](https://github.com/dnlintsm/knowledge-chatroom/issues/178#issuecomment-6763899011).

## What exists today

| | Today | Gap |
| --- | --- | --- |
| Inputs | A run's provenance records each input's original place, version id and `sha256`. The copy under `inputs/` is a new file version with the same bytes (`Session._resolve_inputs`, `experiments.create`). Reruns read the recorded content (#187). | The copy is an ordinary file. If someone edits it, nothing in the UI says so. |
| Past versions | `GET /files/{path}?versions` lists a live file's versions (id, `sha256`, size, author, time). | No route reads a past version's bytes, so "view the recorded input" can't exist yet. |
| Rules | Generate Rules writes `models/general_rules.md` into the run after it starts. It's an ordinary file since #175. | Nothing records which version of it Claude or a tool read, so nobody can tell which Rules a run followed. |
| Delete | `DELETE /experiments/{id}` sets `deleted_at` on the Experiment, and a trigger sets the same time on its live files (`experiments_drop_files`). History stays. | Nothing reads a deleted Experiment back. There is no undo. |

## Decisions

1. **No file locks come back.** Working files stay editable under the usual rules. Evidence
   is what the run records, never a frozen copy of the working file (#178).
2. **Compare content, not version ids.** The copy under `inputs/` has its own version id from
   the start, so drift compares the copy's current `sha256` with the recorded `sha256`.
3. **Reading a past version needs exactly what reading the file needs now**, in the same
   place. A version id only selects among that file's own versions. It never opens a file in
   another place, so it can't get around a node or Experiment you can't read.
4. **"Read" means what was read.** The run records a Rules version only when an agent or tool
   actually read it during the run. The UI says "read by Claude", "written", or "at finish",
   and never "the rules this run used" unless a read is recorded.
5. **Delete stays a soft delete, and becomes undoable.** Permanent deletion and a retention
   period stay out of scope, as #178 asks (a separate policy). Nothing is purged in this batch.
6. **This is api-py only.** Since the TypeScript server was removed (#264), every agent and
   tool reads files through api-py, so recording reads there sees all of them.

## Input drift

For each input in a run's provenance, the run panel compares the recorded `sha256` with the
`sha256` of the live file at the recorded `inputs/` path in the run.

| State | Shown on the input | Next step offered |
| --- | --- | --- |
| Same content | Nothing extra | Open |
| Different content | "Content differs from the recorded input" | Open (current), **View recorded** |
| No live file at that path (deleted or renamed) | "No longer in inputs/" | none |
| The record has no `sha256` (a legacy run) | "Not recorded" | Open (current) |

- Restoring identical bytes clears "differs", because it compares content.
- A newly linked, unchanged input never shows "differs", because its bytes are the recorded
  bytes.
- **View recorded** opens the recorded content read only, through the past-version read below,
  using the copy's own version that has the recorded `sha256` (the first version of the copy,
  unless someone wrote the same bytes again). Reading it needs read access to the run only,
  not to the input's original place. When the copy has no version with that `sha256` (it was
  deleted and made again), there's no link.
- Claude gets the same states with the run in `currentExperiment`, so it can say an input
  changed instead of reading the edited copy as if it were the evidence.
- The file list's data already has each file's `sha256` (`server-files.ts`), so this needs no
  new route. The list refreshes on file events, so drift appears as soon as someone saves.

## Reading a past version

`GET /files/{path}?version=<versionId>` with the usual `node` or `experiment` parameter
answers that version's bytes, with the same headers as a read of the live file
(`Content-Security-Policy: sandbox`, `nosniff`, the ETag is that version's `sha256`, a 302 to
the store for binary files when `S3_PUBLIC_URL` is set).

- It needs the same read access as reading the live file at that path in that place.
- The version has to belong to the live file at that path in that place. Any other id, a
  malformed one, or one from another place or workspace answers 404, the same as a missing
  file, so the answer never says whether the id exists elsewhere.
- A deleted file's versions aren't readable here (they aren't listed by `?versions` either).
  Restoring the Experiment brings them back (below).
- `versions` and `version` together are a 400.
- Agent tokens can use it like any read. The Python agent's `read_file` tool gains an optional
  `version`, so Claude can read the recorded input when it notices drift.

## Recording which Rules were read

While a run's state is `running`, api-py records each distinct version of the run's
`models/general_rules.md` that an agent or tool reads through a storage token
(`Principal.actor == "agent"`), when it acts for the run's maintainer or a collaborator.
Another viewer's Claude reading a shared run's Rules isn't the run reading them.

- **Stored** in a new table `run_reads` (`workspace_id, experiment_id, path, version_id,
  sha256, user_id, via, first_read_at`; `026_run_reads.sql`), one row per run, path and
  version, with RLS like `experiments`. It's a table rather than an append to `provenance`, so concurrent reads
  can't lose each other and provenance stays written only when the run starts and finishes.
- **Which files:** only `models/general_rules.md` for now, kept in one constant
  (`RECORDED_READS`) so other files can join later without a schema change.
- **Heard:** a new read sends an `experiment` event (change `update`), so a run panel that is
  open shows it without waiting for another change.
- **Not recorded:** reads by a person in the browser (viewing isn't executing), reads after the
  run finished, and reads of other files. A deployment without login has no storage tokens,
  so nothing is recorded there.
- **At finish**, the run adds `files: {"models/general_rules.md": {version, sha256} | null}`
  to provenance (the version present at completion, or null when there was none) and copies
  the recorded reads into `reads`, so the record and the report keep them. Callers can't set
  either key. This happens whichever way the run ends: `/finish`, or a PATCH of its state to
  done or failed from the run panel. It is read under the experiment row's lock, which file
  writes and recorded reads also hold, so a read or a Rules save racing the finish is either
  in the record or comes after it.
- **What the run panel shows** under Provenance, in a Rules row, from the file's own history
  and `run_reads`:
  - written: each version written during the run, with who wrote it and when;
  - read: each version an agent or tool read, with when, and "Claude" or the tool server's name;
  - at finish: the version present when the run finished, or "deleted".
  Each version is a short `sha256` and links to **View** through the past-version read while the
  file is live. When nothing was read, the row says "Not read during the run" and claims no
  more.
- The `report.md` front matter gains `rules_read: [<sha256>, …]` when the run finishes with
  Rules (or reads of them), so the report says the same thing as the panel.

## Recovering a deleted Experiment

| Operation | Maintainer | Collaborator | Owner or Admin |
| --- | --- | --- | --- |
| See it in Recently deleted | ✓ | ✗ | Shared or archived ones |
| Restore it | ✓ | ✗ | Shared or archived ones |

This follows the handover rules: drafts stay private to their maintainer, and Owners and
Admins can act on shared and archived Experiments. Everyone also needs membership and Can
view on the Experiment's node, as for every Experiment.

- `GET /experiments?deleted=1` lists the deleted Experiments the caller may restore, newest
  deletion first, with `deletedAt`, who deleted it (`deletedBy`, kept on the row from now on
  and taken from the audit log for earlier deletes; null for one deleted with its node), and
  `restorable` (false when its node is gone). `fileCount` there is the files a restore brings
  back.
- `POST /experiments/{id}/restore` clears `deleted_at` on the Experiment and on the files
  deleted with it: those whose `deleted_at` equals the Experiment's. Files deleted earlier stay
  deleted. It answers the Experiment, keeps its status (draft, shared, archived) and state,
  sends an `experiment` event with change `restore`, and is audited as `experiment.restore`.
- **Its node has to be live.** If the node was deleted (which deletes its Experiments), restore
  answers 409, "Its place was deleted, so it can't be restored." Restoring nodes is out of
  scope.
- **A departed maintainer.** If the maintainer is no longer a member, an Owner or Admin who
  restores it becomes its maintainer, as a handover would make them, audited with both
  people. The author doesn't change.
- **The UI:** deleting from the run panel asks nothing; a notice names the Experiment with
  Undo for eight seconds, and Undo calls restore and goes back into it. The Experiments view
  ends with a "Recently deleted" link, shown only when the list isn't empty, that lists them
  (when, where, who deleted it, how many files come back) with **Restore**. One whose node was
  deleted says "Its place was deleted" instead, and a departed maintainer's says that
  restoring makes it yours.
- **Agent tokens** can't list or restore deleted Experiments, as Claude never deletes them.

## Contract changes

- `GET /files/{path}`: the `version` query parameter.
- `GET /experiments`: the `deleted` query parameter; an Experiment answer gains `deletedAt`,
  `deletedBy` (`{id, name}`) and `restorable` only in that list.
- `POST /experiments/{id}/restore`.
- `GET /experiments/{id}/reads`: the run's `run_reads` rows (path, version, `sha256`, via,
  first read), for whoever can see the run.
- `ExperimentEvent.change` gains `restore`.
- Provenance gains `files` at finish.

## Tests this batch asks for

- Drift: a new unchanged input isn't marked; an edited one is; writing the original bytes back
  clears it; a deleted or renamed input shows "No longer in inputs/"; a legacy record without
  `sha256` shows "Not recorded".
- Past versions: reading an older version answers its bytes; a version id from another file,
  another place or another workspace answers 404; a viewer of the run can read the recorded
  input without access to the input's original node; `versions` with `version` is a 400.
- Rules reads: a storage-token read during a running run records one row; reading the same
  version again doesn't add one; a browser read and a read after finish record nothing; a
  rewrite then a read records the second version; `finish_run` records the version at finish,
  or null after a delete.
- Restore: the maintainer can list and restore their draft; an Admin can restore a shared one
  but doesn't see a draft; a collaborator can't; files deleted before the Experiment stay
  deleted; restoring under a deleted node is a 409; restoring a departed maintainer's
  Experiment makes the Owner or Admin its maintainer; an agent token gets 403.
- E2E: edit an input in the browser and see "Content differs", open the recorded version;
  delete an Experiment and Undo.

## Rollout (#267, batch A)

1. This spec (docs only).
2. Backend: the past-version read, `run_reads` and the Rules record at finish, `version` on
   the Python agent's `read_file` (api-py, agent-py, contract). Done.
3. Backend: Recently deleted and restore (migration, api-py, contract). Done.
4. Screens: input drift, View recorded, and the Rules row in Provenance. Done: the panel
   follows the versions the browser knows of the run's files (the store's `serverHash`), so
   drift shows as soon as a save lands, and Claude's `currentExperiment` lists the inputs with
   their state and, for a changed one, the copy's `recordedVersion`.
5. Screens: Undo after delete, and Recently deleted. Done.

## Open points for review

- **Which reads to record.** This spec records only `models/general_rules.md`. The other
  option is every file of the run outside `inputs/` that an agent reads while it runs, which
  would also catch parameter files and scripts, but lists files Claude only read to write
  the report.
- **Who may restore.** This spec lets Owners and Admins restore shared and archived ones. The
  stricter option is the maintainer only, which matches who may delete today but leaves a
  departed maintainer's deleted Experiments unrecoverable.
