# Experiments and Runs (design)

Status: **proposed**, tracked in
[#267](https://github.com/dnlintsm/knowledge-chatroom/issues/267) (batch C), the open
"consistent objects; folders stay distinguishable" criterion and the Experiment/Run question
of [#178](https://github.com/dnlintsm/knowledge-chatroom/issues/178).

Today a run is an Experiment with a report (see "Runs are experiments" in
[architecture.md](architecture.md#runs-are-experiments)). Running the same question again
makes a whole new Experiment, so an Experiment can't hold more than one execution. Runs of one
question can't be compared inside it, and one run can't be archived or deleted on its own.
#185 renamed what users see to "Experiment" and left the storage API's run names for this
batch. This batch makes a **Run** its own record under an Experiment, moves today's records
over, and adds "Import folder as Experiment".

## What exists today

| | Today | Gap |
| --- | --- | --- |
| Record | `experiments` holds the question (title, hypothesis, place, maintainer, collaborators, status) and one execution (params, results, state, provenance) in the same row. | One execution per Experiment. |
| Files | An Experiment's files are its working copy (`files.experiment_id`), forked from its node. A run links its inputs under `inputs/` at their versions, and writes `report.md`. | What a finished run produced is whatever the working files are now. |
| Reruns | `POST /experiments/runs` with `rerunOf` makes a new Experiment whose provenance names the old one (`rerun_of`). | A chain of reruns is many Experiments, linked one by one. |
| Evidence | Provenance (who, chat, model, skill, tool versions, inputs with `sha256`), the Rules reads (`run_reads`), input drift and past versions (batch A). A finished run can't be finished again with other results. | Outputs aren't recorded, only the working files. |
| Compare | The Compare tab has one row per Experiment. | Nothing compares the runs of one question. |
| Archive, delete | Whole Experiments only (batch A added restore). | No single run. |
| Import | `POST /experiments/upload` takes a multipart body of files from the browser and makes an Experiment, adding nodes on the way. | Files already in the workspace can't become an Experiment without downloading and uploading them again. |

## Decisions

1. **An Experiment is the question; a Run is one execution of it.** The Experiment keeps
   its title, hypothesis, place, maintainer, collaborators, status, working files and its
   planned parameters. A Run has its own id and number in the Experiment (Run 1, Run 2, ...),
   an optional label, the parameters it ran with, its results, its state (running, done,
   failed), its provenance, the Rules reads, and its **file record**.
2. **A Run's evidence is a record, not a copy** (batch A, decision 1). Runs work in the
   Experiment's working files, as today. When a Run starts it records its inputs; when it
   finishes it records every file of the Experiment as it was then: path, version id,
   `sha256` and size. File versions never change, so the record keeps pointing at what the
   run read and wrote, while the working files stay editable. Nothing is copied.
3. **A finished Run can't change.** Its parameters, results, state, provenance and file
   record are refused by a trigger once it is done or failed, for everyone, Owners included.
   A correction is a new Run.
4. **One running Run per Experiment.** Starting a Run while another one there is running
   answers 409 and names it. Runs share the working files, so two at once would write over
   each other's outputs. Runs of different Experiments run side by side as today.
5. **Who does what follows the Experiment.** Seeing an Experiment shows its Runs. Its
   maintainer and collaborators start, finish, archive, delete and restore its Runs while it
   isn't archived. Anyone who can see it can **Rerun as your own**: a new draft Experiment of
   theirs, with Run 1 recording which Run it reran, as reruns work today (#188).
6. **A Run can be archived or deleted on its own.** Archiving hides it from Compare by default
   and keeps it readable. Deleting is a soft delete with Undo and **Recently deleted**, like an
   Experiment's (batch A), and nothing is purged. Both are audited (`run.archive`,
   `run.delete`, `run.restore`). A running Run can't be deleted (409): finish it first.
   Deleting the last Run leaves the Experiment with none.
7. **Moving today's records over keeps every id and link working.** Each Experiment stays,
   with the same id. One whose state is running, done or failed gets Run 1 holding its
   parameters, results, state, provenance and Rules reads. One that is still ready has no Run,
   even with a `report.md`, since nothing says it ran.
   A finished one's file record is taken at migration and marked so ("recorded when runs
   were split, not at finish"), since nobody knows what changed after it finished. A running
   one keeps running as Run 1. A rerun's `rerunOf` keeps the old Experiment's id and adds its
   Run 1 (`{id, run}`).
8. **Rerun chains are not merged.** A `rerunOf` chain is evidence that one run followed
   another, not that they share a hypothesis (#267). Each Experiment in a chain stays its own,
   and its Run 1 says what it reran. Merging Experiments is not part of this batch.
9. **The storage API names the Run.** New routes act on Runs (see below). The old run routes
   (`POST /experiments/runs`, `/experiments/{id}/finish`, `/reads`, `/inputs`) keep working
   for one release, acting on the Experiment's latest Run, and are marked deprecated in
   `storage.yaml`. An Experiment's `results`, `state` and `provenance` fields stay for that
   release as its latest live Run's, and its `params` are its planned parameters. A `PATCH` of
   its state to done or failed with no Run running adds a finished Run, and so does an upload
   marked finished, so older clients still leave a record. Results typed into an Experiment
   before it ever ran become a finished Run 1, "Recorded by hand", when its first Run starts,
   so they aren't replaced by the new Run's.
   **A finish ends the Run it was meant for, never a later one.** A finish whose answer was
   lost may be retried after someone has started the next Run, so the old finish routes
   decide which Run they end with the Experiment's row locked:
   - `POST /experiments/{id}/finish` takes an optional `run` (the Run's id). With it, that Run
     ends; if it already ended exactly so, the call is answered without change, and otherwise
     it is refused. It never touches another Run.
   - Without `run`, a finish that repeats how the caller's latest finished Run ended is a
     retry of it, answered without change, while a newer Run keeps running. Otherwise it ends
     the running Run only when the caller started it. A Run someone else started is left
     running, and the call answers 409 with `running` naming it.
   - A `PATCH` of the state to done or failed follows the same rule, and
     `POST /runs/{id}/finish` always names its Run.
10. **Claude starts and finishes Runs.** `create_experiment` (a new Experiment with Run 1)
    stays. `start_run` starts another Run in an Experiment the user can work on, and
    `finish_run` records its results. `set_experiment_results` stays as an alias for a release,
    so saved chats and older skills still work. Claude still can't archive, delete or restore.
11. **A folder stays a folder until someone imports it.** A folder named `experiments/`, or
    anything else, is only files. **Import folder as Experiment** makes one from a folder
    already in the workspace (see below).

## Import folder as Experiment

- From a folder's menu in Files: **Import as Experiment**. A preview shows:
  - **Destination**: the node it goes to (default: the folder's node; the root at the root),
    with its full path. Changing it needs view access there.
  - **Classification**: the title (the folder's name), an optional hypothesis, and the
    planned parameters if the folder has a `params.json` or `params.yaml` at its top.
  - **Visibility**: draft (only you) by default, or shared.
  - **Files**: every file it will hold, with sizes, and a count of any it can't copy
    (too large, or a type storage refuses). Paths are kept relative to the folder.
- **A restriction travels with its content.** When the folder is inside a restricted node
  ([restricted-knowledge.md](restricted-knowledge.md)) and the destination is outside that
  node, importing needs Full access on the restricted node, since it opens the folder's
  content to whoever can see the destination. The preview says so, and names the node.
- **Copy by default.** The Experiment's files share the folder's stored bytes and start a new
  history, so the folder stays as it was. **Move** (needs Can edit where the folder is) also
  deletes the files it imported, in the same transaction, so their history stays. It deletes
  only those: a file the preview listed as left out (too large, or a type storage refuses)
  stays in the folder. A file that changed after the folder was listed stops the whole
  import (412, `changed`), so nothing is imported or deleted and the preview can be read
  again.
- **An optional pointer**: a `EXPERIMENT.md` in the source folder that links to the new
  Experiment. It needs Can edit where the folder is; without it, the checkbox is off and says
  why. It never replaces a file: when the folder has an `EXPERIMENT.md` of its own, Copy
  keeps that one and the checkbox is off, saying Move takes it into the Experiment. The pointer is an ordinary file and names only the Experiment's title and link, so
  people who can't see a draft Experiment learn nothing from it but its name.
- `POST /experiments/import {node, folder, destination?, title, hypothesis?, status?, move?,
  pointer?}` does it on the server, with the same checks and limits as
  `POST /experiments/upload`, reusing its code. Bytes aren't sent again, which is why this is
  a route of its own rather than the browser re-uploading the files. `?preview` answers the
  preview without changing anything.
- It is audited as `experiment.import` with the source place and folder, and refused to agent
  tokens like upload is.

## API

| Route | Does |
| --- | --- |
| `GET /experiments/{id}/runs` | Its Runs, newest first (`?archived=1`, `?deleted=1`). |
| `POST /experiments/{id}/runs` | Starts a Run: `{label?, params?, inputs?, provenance?}`. 409 while one is running, with the `running` Run's number. |
| `GET /runs/{id}` | One Run. |
| `POST /runs/{id}/finish` | `{results, state}`; the record is taken here. |
| `POST /runs/{id}/rerun` | `{experiment?}`: the Run's own Experiment for another Run there (needs work access), or `null` or nothing for a new one of yours. Any other Experiment is a 400. |
| `PATCH /runs/{id}` | `{label?, archived?}`. |
| `DELETE /runs/{id}`, `POST /runs/{id}/restore` | Soft delete and undo. |
| `GET /runs/{id}/reads` | The Rules reads, as today's `/experiments/{id}/reads`. |
| `GET /runs/{id}/files`, `GET /runs/{id}/files/{path}` | The file record, and a recorded file's bytes, with the checks of reading that Experiment's files. |
| `GET /runs?node=&descendants=&experiment=` | Runs to compare, with each one's Experiment. |
| `POST /experiments/import` | Import a folder (above). |

`RunEvent` (`op: "run"`, `change: create | finish | update | archive | delete | restore`, with
the Experiment's id and node) joins the event stream, with the same audience as its
Experiment's events, followed by the Experiment's own update event.

## Screens

- **The Experiment panel** gets a **Runs** list under the hypothesis: number, label, state,
  when, who started it, and its key results. **New run** (maintainer and collaborators)
  starts one with the planned parameters, editable first.
- **Opening a Run** shows its record: parameters, results, provenance, Rules reads, and its
  files as recorded, read only, with "differs from the working copy" where they do. From
  there: **Rerun**, **Rerun as your own**, **Archive**, **Delete**.
- **Compare** has one row per Run, grouped by Experiment, with the scope controls it has
  today, plus "this Experiment". Archived Runs are left out unless asked for.
- **Recently deleted** in an Experiment lists its deleted Runs.
- **Import as Experiment** in a folder's menu opens the preview above.
- Claude's tools and wording say Run for an execution and Experiment for the question.

## Tests this batch asks for

- A second Run in an Experiment; the first one's record still points at its versions after
  the working files change; a finished Run refuses changes through the API and through the
  trigger with the app's check skipped.
- 409 for a second running Run; Runs of two Experiments run side by side.
- Rerun into the same Experiment and as your own; a viewer can only do the second.
- Archive, delete, undo and restore one Run, audited; another collaborator sees it; someone
  who can't see the Experiment gets 404 for its Runs.
- Migration on a copy of today's records: an Experiment that never ran has no Run; a finished
  one has Run 1 with the same parameters, results, provenance and Rules reads, and a record
  marked as taken at migration; a running one finishes as Run 1; a rerun chain stays separate
  Experiments with `rerun_of` mapped to Run 1 ids; old links (`/?experiment_id=`) open.
- The deprecated routes and `set_experiment_results` still work and act on the latest Run.
- A retry of Run 1's finish through `POST /experiments/{id}/finish`, after a collaborator
  starts Run 2, leaves Run 2 running with no results; a different finish naming no Run gets
  409 with `running: 2`; naming Run 2 ends it.
- Import: preview changes nothing; copy keeps the folder; move removes what it imported and
  keeps its history, while a file left out of a mixed folder (one too large) stays in it; a
  file changed after the listing stops a move and leaves everything as it was; pointer needs Can edit; a viewer at the source can copy to where they can view;
  copying out of a restricted node needs Full access on it; limits as upload; agent tokens
  get 403.
- E2E: start two Runs, compare them, archive one; import a folder with the preview.

## Rollout (#267, batch C)

1. This spec (docs only).
2. Backend: the `runs` table and migration, the Run routes, the deprecated aliases, Claude's
   tools, contract.
3. Screens: Runs in the Experiment panel, the Run view, Compare by Run, archive and delete.
4. Import folder as Experiment: the route and its preview screen.

## Open points for review

- **One running Run per Experiment.** The other option gives each Run a folder of its own in
  the working files (`runs/2/`), so runs can overlap, at the cost of a less simple working
  copy.
- **How long the deprecated routes stay.** This spec says one release.
- **Importing out of a restricted node.** This spec asks for Full access on the restricted
  node. The other option treats it like any copy a reader can make, since they could download
  and upload the files.
- **Move as an option at all.** Copy is the default; Move could be left out, and done by
  deleting the folder afterwards.
