# Discussion on Experiments (design)

Status: **proposed**, tracked in
[#267](https://github.com/dnlintsm/knowledge-chatroom/issues/267) (batch E), review
question 5 of [#178](https://github.com/dnlintsm/knowledge-chatroom/issues/178).

An Experiment's results are reviewed today outside the workspace: in a chat with Claude, in
a meeting, or in another tool. What people concluded is not kept beside the Runs it is
about, and the step from "we agree what this shows" to "the node's Knowledge says so" is a
proposal that carries no trace of the discussion behind it.

This batch adds **comments** on an Experiment and its Runs, and a way to **propose a
conclusion** from a discussion back into the node's Knowledge, through the proposals that
already exist.

## What exists today

| | Today | Gap |
| --- | --- | --- |
| Talking about results | Each person's chats with Claude, which belong to that person alone (docs/workspaces.md). | Nothing shared, and nothing kept with the Experiment. |
| Bringing results to Knowledge | `propose_experiment` and Propose in the Experiment panel offer its changed files as proposals on its node. Whoever can edit the node accepts or rejects them. | A proposal says what changes, not why, and links to no discussion. A conclusion that isn't a file of the Experiment can't be proposed from it. |
| Who may do what | Anyone who can view a node may propose there. A shared Experiment is visible to whoever can view its node; a draft only to its maintainer and collaborators. | No rule for who may comment. |
| Record | A finished Run is immutable evidence (docs/experiment-runs.md). | A comment must not be mistaken for evidence, or change it. |

## Decisions

1. **Comments belong to an Experiment.** A comment is on an Experiment, and may name one of
   its Runs. A thread is a comment and its replies, one level deep: a reply to a reply
   joins the same thread. Comments are Markdown, at most 10,000 characters, rendered as
   untrusted content (no raw HTML, links open in a new tab, no images loaded from
   outside).
2. **Who may comment: anyone who can see the Experiment** (chosen in review). On a shared
   Experiment that is everyone with Can view on its node, the same people who may already
   propose a change there. On a draft, it is its maintainer and collaborators. Owners and Admins comment only where
   they can see, and they never see drafts. The options not taken were "only those
   working on it" (readers see the discussion but don't take part) and a per-Experiment
   switch the maintainer turns on for readers.
3. **Discussion closes when an Experiment is archived.** Its comments stay readable to
   whoever can see it; nobody adds, edits or resolves one until it is restored. A deleted
   Experiment's comments go and come back with it.
4. **Comments are not evidence.** They live in their own table, not in a Run's record,
   files or provenance. Commenting on a finished Run never changes it, and a Run's export
   and compare views leave comments out. A comment may quote a result; the Run stays what
   it recorded.
5. **The author edits and deletes their own.** An edited comment says "edited" with the
   time, and keeps its earlier texts, which anyone who can see the comment may read. A
   deleted comment leaves "Comment deleted" in its thread, so replies keep their place,
   and its text is gone from the answer. Nobody else edits a comment.
6. **The maintainer moderates.** The Experiment's maintainer, and the workspace's Owners
   and Admins on a shared or archived Experiment they can see, may remove someone else's
   comment. It leaves "Removed by Alice" in the thread and an audit entry
   (`comment.remove`); the text is kept for the audit log's readers, the same as other
   audited content changes.
7. **Threads resolve.** The thread's author, the maintainer and collaborators may mark a
   thread resolved, and anyone who may comment may reopen it. A resolved thread folds to
   one line. Resolving is not concluding: it says the question is answered, not that
   Knowledge changes.
8. **Propose a conclusion.** From a thread, anyone who may comment and can view the node
   may **Propose as conclusion**:
   - It opens a form with the conclusion's text, drafted from the thread's first comment,
     and the file it goes to in the Experiment's node: by default a new file
     `conclusions/<Experiment title>.md`, or an existing Markdown file of the node, to
     which it is added as a section.
   - The file's text gains a footer with links to the Experiment, the Runs the thread
     names, and the thread, so Knowledge says where it came from.
   - It is sent as an ordinary proposal on that file (`base_version_id` set for an
     existing file), with `experiment_id` and a new `comment_id` naming the thread. Whoever
     can edit the node accepts or rejects it, as today: proposing never changes Knowledge
     on its own.
   - The thread shows the proposal and its state (open, accepted, rejected, withdrawn), and
     the proposal's review shows the thread. An Experiment at the workspace root proposes
     to the root's files.
9. **Claude reads discussion; it doesn't take part.**
   - A new tool, `list_comments`, gives Claude an Experiment's threads. Other people's
     comments are outside content: reading them counts towards `read_outside_content`, as
     search results do, so memory changes afterwards go to the inbox.
   - Claude doesn't post, edit, resolve or remove comments. It may draft a conclusion in
     the chat and send it with `propose_conclusion`, which makes the same proposal as the
     form, credited to Claude for its user, as its other proposals are.
   - Pipelines get no access to comments: they are not among a pipeline's operations, and
     their routes refuse keys.
10. **People find new comments.** The Experiment panel shows a count of threads that are
    open, and the change events (`GET /files?watch`) carry a `comment` change for the
    Experiment, filtered by `hears_experiment`, so an open panel updates. Notifications
    outside the app (email, mentions) are left for later.
11. **Leaving and access changes.** A comment's author who leaves the workspace shows as "a
    former member"; their comments stay. Someone who loses access to the node stops seeing
    the discussion with the Experiment. Restricting a node hides its Experiments'
    discussions with them, through `experiment_access`.

## Data changes

- `experiment_comments`: `id`, `workspace_id`, `experiment_id`, `run_id` (nullable),
  `thread_id` (null for a thread's first comment; its id otherwise), `author_id`, `body`,
  `created_at`, `edited_at`, `deleted_at`, `removed_by`, `removed_at`, `resolved_at` and
  `resolved_by` (on a thread's first comment).
- `experiment_comment_versions`: `comment_id`, `body`, `created_at`, one row per edit.
- Row security: whoever `experiment_access` lets see the Experiment reads its comments;
  inserting needs that, and an Experiment that isn't archived; updating needs the author,
  or the maintainer, Owner or Admin rule for removal and the resolve rule for
  `resolved_*`. The routes check the same through `Session`.
- `proposals.comment_id` (nullable), the thread a conclusion came from.
- Audit actions: `comment.remove` (with the text), `comment.resolve`, `comment.reopen`.
  Posting, editing and deleting your own comment are not audited: they are the content
  itself, with its times.

## API

| Route | Who | Does |
| --- | --- | --- |
| `GET /experiments/{id}/comments` | Whoever can see the Experiment | Threads, oldest first, each with its replies, the Run it names, its state, and its conclusion proposals |
| `POST /experiments/{id}/comments` `{body, runId?, threadId?}` | Whoever may comment (decision 2), unless archived | Adds a comment, or a reply to a thread |
| `PATCH /comments/{id}` `{body}` | Its author, unless archived | Edits it, keeping the earlier text |
| `GET /comments/{id}/versions` | Whoever can see it | Its earlier texts |
| `DELETE /comments/{id}` | Its author; the maintainer, Owners and Admins remove (decision 6) | Deletes or removes it |
| `POST /comments/{id}/resolve` and `/reopen` | Decision 7 | Resolves or reopens a thread |
| `POST /comments/{id}/conclusion` `{text, path, mode: "new" \| "section"}` | Whoever may comment and can view the node | Makes the proposal (decision 8), answering it as `/proposals` does |

Comments are reached through `Session`, as files and proposals are: an Experiment someone
can't see is not found, and so are its comments. Claude's storage tokens may `GET`
comments and `POST .../conclusion`; every other comment route refuses them with 403
("Claude doesn't write comments"). Pipeline keys get 401 at these routes. The contract adds
the routes, `Comment`, `CommentThread` and the proposal's `commentId`, in `storage.yaml`,
the conformance suite and both generated models.

## Screens

- **Experiment panel, Discussion:** below Runs, the threads, newest activity first, with
  a box to start one. A thread names its Run when it has one ("on Run 3"), shows who wrote
  each comment and when, "edited", and the Resolve, Propose as conclusion, Edit and Delete
  actions each person may use. Resolved threads fold to one line. An archived Experiment
  says "Discussion is closed while this Experiment is archived."
- **Run view:** "Discuss this Run" starts a thread on that Run, and the Run shows how many
  threads name it, linking to them.
- **Propose as conclusion:** the form of decision 8, with a preview of the file as the
  reviewer will see it. After sending, the thread shows "Proposed to Etch ·
  conclusions/Overnight sweep.md · open".
- **Review (the editor's proposal view):** a conclusion proposal shows "From a discussion
  on Overnight sweep" with the thread, so the reviewer reads the reasoning before
  accepting.
- **Activity tab:** removed comments, and resolved and reopened threads, in its words.

## Settings

None. Discussion is on wherever Experiments are.

## Tests this batch asks for

- Who may comment, per decision 2: a Can view reader on a shared Experiment can; nobody
  but its maintainer and collaborators can on a draft, Owners and Admins included; nobody
  can on an archived one, and anyone who could can again once it is restored.
- Someone who loses Can view on the node, or whom a restriction leaves out, gets 404 for
  the Experiment's comments, and stops hearing `comment` changes.
- Edit keeps the earlier text and marks it edited; delete leaves "Comment deleted" with
  replies in place; only the author edits. Removal by the maintainer, an Owner or an Admin
  leaves "Removed by …" and a `comment.remove` audit entry; a collaborator can't remove.
- A reply to a reply joins the thread. A comment naming a Run of another Experiment is
  400.
- Commenting on a finished Run leaves the Run, its files, results and provenance
  unchanged, and compare and export show no comments.
- A conclusion becomes an open proposal on the node with `experiment_id` and `comment_id`,
  as a new file or a section of an existing one, with its footer; a reviewer accepts it as
  any proposal, and the thread shows it accepted. Proposing to a file someone changed
  since keeps the proposal's base, and accepting it follows today's conflict rule.
- Claude: `list_comments` marks the chat as having read outside content; Claude's token
  gets 403 posting a comment and can propose a conclusion, credited to Claude for its
  user. A pipeline key gets 401.
- Markdown in comments is rendered without raw HTML or outside images.
- E2E: two people discuss a Run, one resolves the thread, the other proposes a conclusion,
  an editor accepts it, and the node's file and the thread both show it.

## Rollout (#267, batch E)

1. This spec (docs only).
2. Backend: the tables and row security, the comment routes through `Session`, the
   conclusion proposal, change events, Claude's two tools, the contract and conformance.
3. Screens: Discussion in the Experiment panel, Discuss this Run, Propose as conclusion,
   the thread in the proposal review, and the Activity entries.

`docs/workspaces.md`'s operation matrix gains the comment rows in step 2, and
`SECURITY.md` says that comments are untrusted content for Claude.

## Open points for review

- **Where a conclusion goes.** By default a new file per Experiment under
  `conclusions/`. It could instead always be a section of one file per node, so a node's
  conclusions read in one place.
- **Mentions and notifications.** Left out of this batch: the app has no notifications
  yet, and mentions without them would promise more than they do.
- **Claude posting comments.** Left out: a comment is read by others as a person's words,
  and Claude's writes elsewhere are proposals. Claude could post marked as "Claude, for
  Alice" later, if people want summaries in the thread.
