"""What one principal may do with the knowledge tree and access, as Session in apps/agent/src/storage/session.ts.

Every route goes through here, so access is checked and audited in one place.
A node the principal can't see at all is reported as not found, so its
existence doesn't leak. With row-level security, node queries also run as
the restricted database role for this principal (db.as_user), so Postgres
enforces the same rules if a check here is ever missed.
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from psycopg import AsyncConnection

from . import experiments, nodes, proposals
from .access import AccessService, ForbiddenError, Principal, Role, at_least, is_uuid, iso
from .db import as_user
from .experiments import ANYWHERE, ExperimentError, ExperimentExistsError, clean_input, same_json
from .files import FileService
from .nodes import NodeError, NodeNotFoundError
from .paths import js_trim, normalize_path
from .proposals import EVERYWHERE, ProposalError
from .run_report import REPORT_PATH, new_report, report_front_matter, with_front_matter
from .storage import Storage

# What a role lets you do, for refusals: "You can only view here; ...".
ROLE_VERB: dict[str, str] = {"viewer": "view", "editor": "edit", "owner": "manage"}
ARCHIVED = "This experiment is archived; restore it to change it"
# The node name an upload uses for a level its path leaves empty ("Etch/Module 3//").
EMPTY_LEVEL_NAME = "None"
# For rerun: no node given, so the earlier run's.
_SAME_PLACE = object()


def _now() -> str:
    return iso(datetime.now(UTC))  # type: ignore[return-value]


class Session:
    def __init__(self, storage: Storage, access: AccessService, principal: Principal) -> None:
        self.storage = storage
        self.access = access
        self.principal = principal

    @property
    def ws(self) -> str:
        return self.storage.workspace_id

    async def role(self, node_id: str | None) -> Role | None:
        return await self.access.role(self.principal.user_id, node_id)

    async def need(self, node_id: str | None, minimum: Role) -> Role:
        role = await self.role(node_id)
        if role is None:
            if node_id is not None:
                raise NodeNotFoundError("Node not found")
            raise ForbiddenError("You have no access to this workspace")
        if not at_least(role, minimum):
            raise ForbiddenError(f"You can only {ROLE_VERB[role]} here; this needs {minimum} access")
        return role

    @asynccontextmanager
    async def scoped(self) -> AsyncIterator[AsyncConnection]:
        """One transaction for this principal: as the restricted role when row security is on."""
        if self.storage.row_security:
            async with as_user(self.storage.pool, self.principal.user_id) as conn:
                yield conn
        else:
            async with self.storage.pool.connection() as conn, conn.transaction():
                yield conn

    def _audit(self, action: str, target: dict[str, Any]):
        async def record(conn: AsyncConnection) -> None:
            await self.access.audit(conn, self.principal, action, target)

        return record

    # The knowledge tree

    async def tree(self) -> dict[str, Any]:
        async with self.storage.pool.connection() as conn:
            levels = await nodes.types(conn, self.ws)
        async with self.scoped() as conn:
            every = await nodes.list_nodes(conn, self.ws)
        roles = await self.access.node_roles(self.principal.user_id)
        root_role = await self.role(None)
        by_id = {n["id"]: n for n in every}
        # Visible nodes, plus their ancestors so the path to them can be drawn.
        shown: set[str] = set()
        for node in every:
            if not roles.get(node["id"]):
                continue
            current: dict[str, Any] | None = node
            while current and current["id"] not in shown:
                shown.add(current["id"])
                current = by_id.get(current["parentId"] or "")
        visible = []
        for node in every:
            if node["id"] not in shown:
                continue
            role = roles.get(node["id"])
            visible.append({**node, "role": role, "fileCount": node["fileCount"] if role else 0})
        return {"types": levels, "rootRole": root_role, "nodes": visible}

    async def lineage(self, node_id: str) -> list[dict[str, Any]]:
        await self.need(node_id, "viewer")
        async with self.scoped() as conn:
            found = await nodes.lineage(conn, self.ws, node_id)
        if not found:
            raise NodeNotFoundError("Node not found")
        return found

    async def create_node(self, parent_id: str | None, name: str) -> dict[str, Any]:
        await self.need(parent_id, "editor")

        async def in_tx(conn: AsyncConnection, node_id: str) -> None:
            # Whoever adds a node owns it; with row security a trigger does this.
            if not self.storage.row_security:
                await self.access.own_new_node(conn, self.principal.user_id, node_id)
            await self._audit("node.create", {"node": node_id, "parent": parent_id, "name": name})(conn)

        async with self.scoped() as conn:
            return await nodes.create(conn, self.storage, parent_id, name, in_tx)

    async def rename_node(self, node_id: str, name: str) -> dict[str, Any] | None:
        await self.need(node_id, "editor")
        async with self.scoped() as conn:
            return await nodes.rename(
                conn, self.storage, node_id, name, self._audit("node.rename", {"node": node_id, "name": name})
            )

    async def delete_node(self, node_id: str) -> bool:
        await self.need(node_id, "owner")
        async with self.scoped() as conn:
            return await nodes.remove(conn, self.storage, node_id, self._audit("node.delete", {"node": node_id}))

    # Experiments: anyone who can view a node (or the workspace root) may start
    # their own experiment there; only its author changes it (see
    # 005_experiments.sql). An experiment with a report.md is a run.

    async def experiments(self, node_id: str | None | object = ANYWHERE) -> list[dict[str, Any]]:
        """Experiments you can see, on one node (None: at the root) or anywhere."""
        if node_id is not ANYWHERE:
            await self.need(node_id, "viewer")  # type: ignore[arg-type]
        async with self.scoped() as conn:
            return await experiments.list_experiments(conn, self.ws, self.principal.user_id, node_id)

    async def experiment(self, experiment_id: str) -> dict[str, Any]:
        async with self.scoped() as conn:
            found = await experiments.get(conn, self.ws, self.principal.user_id, experiment_id)
        if not found:
            raise NodeNotFoundError("Experiment not found")
        return found

    async def create_experiment(self, node_id: str | None, given: dict[str, Any]) -> dict[str, Any]:
        await self.need(node_id, "viewer")
        title = {"title": given["title"]} if "title" in given else {}

        async def in_tx(conn: AsyncConnection, new_id: str) -> None:
            await self._audit("experiment.create", {"experiment": new_id, "node": node_id, **title})(conn)

        async with self.scoped() as conn:
            return await experiments.create(conn, self.storage, self.principal.user_id, node_id, given, in_tx)

    async def upload_experiment(
        self, raw_id: str, path: list[str], given: dict[str, Any], files: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """
        Uploads an experiment made elsewhere (POST /experiments/upload): its id
        (chosen by the caller, so a retry can't make a second copy), the names
        of its place in the tree, one per level, its fields and its files
        ({path, bytes, mime?}). Nodes of the path that don't exist yet are
        added, which needs editor access where the first one goes; an existing
        path needs viewer access, as for create_experiment.

        The experiment starts with only the uploaded files, not a copy of the
        node's. The new nodes, the experiment and its files are written in one
        transaction, so a failure part way leaves nothing behind.
        """
        if not is_uuid(raw_id):
            raise ExperimentError("An experiment id must be a UUID, e.g. 0b8f6c2e-3d1a-4f5b-9c7e-2a4d6e8f0a1b")
        experiment_id = raw_id.lower()
        fields = clean_input(given)
        if not fields.get("title"):
            raise ExperimentError("An experiment needs a title")
        async with self.storage.pool.connection() as conn:
            levels = await nodes.types(conn, self.ws)
        if not levels:
            raise NodeError("No knowledge levels are set up")
        if len(path) != len(levels):
            raise ExperimentError(
                f"The path needs a name for each of the {len(levels)} levels "
                f"({'/'.join(level['name'] for level in levels)}), got {len(path)}; "
                f'leave a name empty for "{EMPTY_LEVEL_NAME}"'
            )
        names = [EMPTY_LEVEL_NAME if js_trim(name) == "" else name for name in path]
        uploads = [{**f, "path": normalize_path(f["path"])} for f in files]
        seen: set[str] = set()
        for f in uploads:
            if f["path"] in seen:
                raise ExperimentError(f"Two files would both be {f['path']}")
            seen.add(f["path"])

        # The part of the path that exists already. Looked up as the server, so
        # a node you can't see is found rather than added twice; need() below
        # then answers "not found" for it, as everywhere else.
        existing: list[dict[str, Any]] = []
        async with self.storage.pool.connection() as conn:
            if await experiments.id_taken(conn, experiment_id):
                raise ExperimentExistsError(experiment_id)
            for name in names:
                node = await nodes.find_child(conn, self.ws, existing[-1]["id"] if existing else None, name)
                if not node:
                    break
                existing.append(node)
        missing = names[len(existing) :]
        # Nodes added below one you edit are yours too, so one check covers them all.
        await self.need(existing[-1]["id"] if existing else None, "editor" if missing else "viewer")

        principal = self.principal
        created: list[dict[str, Any]] = []
        written: list[dict[str, Any]] = []
        async with self.scoped() as conn:
            node_id = existing[-1]["id"] if existing else None
            for name in missing:
                node, added = await self._find_or_add_node(conn, node_id, name)
                if added:
                    created.append(node)
                node_id = node["id"]
            target = {
                "experiment": experiment_id,
                "node": node_id,
                "title": fields["title"],
                "files": [f["path"] for f in uploads],
                "upload": True,
            }

            async def in_tx(tx: AsyncConnection, _new_id: str) -> None:
                await self._audit("experiment.create", target)(tx)

            await experiments.create(
                conn, self.storage, principal.user_id, node_id, fields, in_tx, chosen_id=experiment_id, fork=False
            )
            service = await FileService(self.storage).in_experiment(conn, experiment_id)
            assert service is not None
            for f in uploads:
                audit = self._audit("file.write", {"experiment": experiment_id, "path": f["path"], "size": len(f["bytes"])})
                info = await service.write(
                    conn,
                    f["path"],
                    f["bytes"],
                    mime=f.get("mime"),
                    create_only=True,
                    author=principal.actor,
                    author_id=principal.user_id,
                    in_tx=audit,
                )
                written.append(info)

        experiment = await self.experiment(experiment_id)
        lineage = await self.lineage(experiment["nodeId"]) if experiment["nodeId"] else []
        return {"experiment": experiment, "lineage": lineage, "created": created, "files": written}

    async def _find_or_add_node(
        self, conn: AsyncConnection, parent_id: str | None, name: str
    ) -> tuple[dict[str, Any], bool]:
        """
        The node `name` below `parent_id`, added when missing. Someone adding the
        same node at the same moment makes the insert fail on the unique name;
        theirs is then used.
        """
        found = await nodes.find_child(conn, self.ws, parent_id, name)
        if found:
            return found, False

        async def in_tx(tx: AsyncConnection, node_id: str) -> None:
            # With row security a trigger makes you its owner (013_node_creator_owns.sql).
            if not self.storage.row_security:
                await self.access.own_new_node(tx, self.principal.user_id, node_id)
            await self._audit("node.create", {"node": node_id, "parent": parent_id, "name": name})(tx)

        try:
            return await nodes.create(conn, self.storage, parent_id, name, in_tx), True
        except NodeError:
            raced = await nodes.find_child(conn, self.ws, parent_id, name)
            if raced:
                return raced, False
            raise

    async def start_run(
        self,
        node_id: str | None,
        given: dict[str, Any],
        inputs: list[dict[str, Any]] | None = None,
        provenance: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Starts a run for you (issue #82): a new draft experiment like
        create_experiment's, in state running unless `given` says otherwise,
        with each input file linked in read only under inputs/, and a report.md
        whose front matter holds the run's record. You need to be able to read
        every input. `provenance` is what the caller knows (chat, model, skill,
        tools); who started it, when, and the exact input versions are added here.
        """
        await self.need(node_id, "viewer")
        user_id = self.principal.user_id
        links, recorded = await self._resolve_inputs(inputs or [])
        who = await self.access.user(user_id)
        name = None if who is None else who["name"] if who["name"] is not None else who["email"]
        record = {**(provenance or {}), "startedBy": {"id": user_id, "name": name}, "startedAt": _now(),
                  "inputs": recorded}  # fmt: skip
        fields = {**given, "state": given["state"] if given.get("state") is not None else "running"}
        title = {"title": given["title"]} if "title" in given else {}

        async def in_tx(conn: AsyncConnection, new_id: str) -> None:
            target = {"experiment": new_id, "node": node_id, **title, "inputs": [link["path"] for link in links]}
            await self._audit("experiment.create", target)(conn)

        async with self.scoped() as conn:
            run = await experiments.create(
                conn, self.storage, user_id, node_id, fields, in_tx, inputs=links, provenance=record
            )
        files = await self.experiment_files(run["id"])
        if not await files.stat(REPORT_PATH):
            await files.write(REPORT_PATH, new_report(run).encode())
        return await self.experiment(run["id"])

    async def _resolve_inputs(
        self, inputs: list[dict[str, Any]], taken: list[Any] | None = None
    ) -> tuple[list[dict[str, str]], list[dict[str, Any]]]:
        """
        Each input's version to copy under inputs/, and what the run's provenance
        records about it: its current version, or for a pinned input (a rerun's,
        with "sha256") the version of it with the recorded content. `taken` are
        inputs/ paths the run already has.
        """
        links: list[dict[str, str]] = []
        recorded: list[dict[str, Any]] = []
        for source in inputs:
            origin = normalize_path(source["path"])
            place = (
                await self.experiment_files(source["experiment"])
                if source.get("experiment")
                else await self.files(source.get("node"))
            )
            versions = await place.history(origin) or []
            pinned = source.get("sha256")
            if pinned:
                current = next((v for v in versions if v["sha256"] == pinned), None)
            else:
                current = versions[0] if versions else None
            if not current and pinned and versions:
                raise ExperimentError(
                    f"{origin} in the earlier experiment no longer has the content it ran with; "
                    "pass inputs to rerun with other files or their current versions"
                )
            if not current:
                raise ExperimentError(
                    f"{origin} of the earlier experiment is gone; pass inputs to rerun with other files"
                    if pinned
                    else f"No file at {origin} to use as an input"
                )
            name = source["as"] if source.get("as") is not None else origin.split("/")[-1]
            path = normalize_path(f"inputs/{name}")
            if path in (taken or []):
                raise ExperimentError(f"The run already has an input at {path}; give this one another name")
            if any(link["path"] == path for link in links):
                raise ExperimentError(f"Two inputs would both be {path}; give one of them another name")
            links.append({"path": path, "versionId": current["id"]})
            recorded.append(
                {
                    "path": path,
                    "from": {"node": place.node_id, "experiment": place.experiment_id, "path": origin},
                    "version": current["id"],
                    "sha256": current["sha256"],
                    "size": current["size"],
                }
            )
        return links, recorded

    async def add_run_inputs(self, experiment_id: str, inputs: list[dict[str, Any]]) -> dict[str, Any]:
        """
        Adds input files to an existing run or experiment (issue #114): each is
        linked in read only under inputs/ at its current version and appended to
        the inputs its provenance records, so a rerun reads them too. Only its
        author can, while it isn't archived; a finished run stays as it ended.
        """
        current = await self.experiment(experiment_id)
        self._need_author(current)
        if current["status"] == "archived":
            raise ForbiddenError(ARCHIVED)
        if current["state"] in ("done", "failed"):
            raise ExperimentError(f"This run already finished ({current['state']}); start a new run to add inputs")
        if not inputs:
            raise ExperimentError("Name at least one file to add as an input")
        before = current["provenance"].get("inputs")
        taken = [i.get("path") if isinstance(i, dict) else None for i in (before if before is not None else [])]
        links, recorded = await self._resolve_inputs(inputs, taken)
        audit = self._audit("experiment.inputs", {"experiment": experiment_id, "inputs": [x["path"] for x in links]})
        async with self.scoped() as conn:
            await experiments.add_inputs(conn, self.storage, experiment_id, links, recorded, audit)
        run = await self.experiment(experiment_id)
        await self._refresh_report(run)
        return run

    async def rerun(
        self,
        experiment_id: str,
        given: dict[str, Any],
        inputs: list[dict[str, Any]] | None = None,
        node_id: str | None | object = _SAME_PLACE,
        provenance: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Runs an experiment again as a new run (issue #82): same place, parameters,
        hypothesis and inputs unless told otherwise. The inputs are read from
        the old run's inputs/ at the content its record names (#187), even if
        someone edited them since; `inputs` instead reads those files at their
        current versions. The old run stays as it is; the new one's provenance
        names it. You need to be able to see the old run.
        """
        old = await self.experiment(experiment_id)
        pinned: list[dict[str, Any]] = []
        if inputs is None:
            found = old["provenance"].get("inputs")
            for item in found if found is not None else []:
                sha256 = item.get("sha256")
                if not isinstance(sha256, str) or not sha256:
                    raise ExperimentError(
                        f"The earlier experiment's record doesn't say what {item['path']} held; "
                        "pass inputs to rerun with chosen files"
                    )
                path = item["path"]
                pinned.append(
                    {"path": path, "experiment": old["id"], "as": re.sub(r"^inputs/", "", path), "sha256": sha256}
                )

        def given_or(key: str, fallback: Any) -> Any:
            return given[key] if given.get(key) is not None else fallback

        return await self.start_run(
            old["nodeId"] if node_id is _SAME_PLACE else node_id,  # type: ignore[arg-type]
            {
                "title": given_or("title", f"{old['title']} (rerun)"),
                "hypothesis": given_or("hypothesis", old["hypothesis"]),
                "params": given_or("params", old["params"]),
            },
            inputs if inputs is not None else pinned,
            # Only the id: the old run may be a draft that viewers of this one can't see.
            {**(provenance or {}), "rerunOf": {"id": old["id"]}},
        )

    async def finish_run(self, experiment_id: str, results: dict[str, Any], state: str) -> dict[str, Any]:
        """
        Records a run's results and how it ended (done or failed), and refreshes
        the record in its report.md (creating the report if it has none). A
        finished run stays as it ended: the same call again changes nothing,
        and a different one is refused.
        """
        current = await self.experiment(experiment_id)
        self._need_author(current)
        if current["status"] == "archived":
            raise ForbiddenError(ARCHIVED)
        if current["state"] in ("done", "failed"):
            if current["state"] == state and same_json(current["results"], results):
                return current
            raise ExperimentError(f"This run already finished ({current['state']}); start a new run to try again")
        audit = self._audit("experiment.update", {"experiment": experiment_id, "fields": ["results", "state"]})
        async with self.scoped() as conn:
            await experiments.update(
                conn, self.storage, experiment_id, {"results": results, "state": state}, audit, {"finishedAt": _now()}
            )
        run = await self.experiment(experiment_id)
        await self._refresh_report(run, create=True)
        return run

    async def _refresh_report(self, run: dict[str, Any], create: bool = False) -> None:
        """
        Brings the record in a run's report.md front matter up to date, for runs
        Claude started (they have provenance). Makes the report when `create`
        is set and there is none. Archived runs are read only.
        """
        if not run["provenance"].get("startedAt") or run["status"] == "archived":
            return
        files = await self.experiment_files(run["id"])
        report = await files.read(REPORT_PATH)
        if not report and not create:
            return
        # As TextDecoder reads it: a leading byte order mark dropped, bad bytes replaced.
        before = report[1].decode("utf-8-sig", errors="replace") if report else f"# {run['title']}\n"
        after = with_front_matter(before, report_front_matter(run))
        if after != before:
            await files.write(REPORT_PATH, after.encode())

    async def update_experiment(self, experiment_id: str, given: dict[str, Any]) -> dict[str, Any]:
        """Archived experiments are read only, apart from changing the status back."""
        current = await self.experiment(experiment_id)
        self._need_author(current)
        archived = current["status"] == "archived" and given.get("status", "archived") == "archived"
        if archived and any(key != "status" for key in given):
            raise ForbiddenError(ARCHIVED)
        audit = self._audit("experiment.update", {"experiment": experiment_id, "fields": list(given)})
        async with self.scoped() as conn:
            await experiments.update(conn, self.storage, experiment_id, given, audit)
        # The report's record follows edits made after the run started.
        updated = await self.experiment(experiment_id)
        await self._refresh_report(updated)
        return updated

    async def delete_experiment(self, experiment_id: str) -> bool:
        self._need_author(await self.experiment(experiment_id))
        async with self.scoped() as conn:
            return await experiments.remove(
                conn, self.storage, experiment_id, self._audit("experiment.delete", {"experiment": experiment_id})
            )

    @staticmethod
    def _need_author(experiment: dict[str, Any]) -> None:
        if not experiment["mine"]:
            raise ForbiddenError("Only the experiment's author can change it")

    # Files

    async def files(self, node_id: str | None) -> FilesSession:
        """Files at the workspace root (None) or in a node."""
        role = await self.need(node_id, "viewer")
        async with self.storage.pool.connection() as conn:
            service = await FileService(self.storage).in_node(conn, node_id)
        if not service:
            raise NodeNotFoundError("Node not found")
        return FilesSession(self, service, role)

    async def experiment_files(self, experiment_id: str) -> FilesSession:
        """An experiment's files: its author edits them, others who may see it read them."""
        access = await self.access.experiment_access(self.principal.user_id, experiment_id)
        service = None
        if access:
            async with self.storage.pool.connection() as conn:
                service = await FileService(self.storage).in_experiment(conn, experiment_id)
        if not service:
            raise NodeNotFoundError("Experiment not found")
        return FilesSession(self, service, "editor" if access == "writer" else "viewer")

    # Proposed versions (see proposals.py): anyone who can read a place may
    # propose a change to its files, and editors there accept or reject it.

    async def proposals(
        self,
        *,
        node: str | None | object = EVERYWHERE,
        experiment: str | None = None,
        status: str = "open",
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        """Proposals you can see: on places you can read, and your own."""
        async with self.scoped() as conn:
            return await proposals.list_proposals(
                conn, self.ws, self.principal.user_id, node=node, experiment=experiment, status=status, limit=limit
            )

    async def proposal(self, proposal_id: str) -> dict[str, Any]:
        async with self.scoped() as conn:
            found = await proposals.get(conn, self.ws, self.principal.user_id, proposal_id)
        if not found:
            raise NodeNotFoundError("Proposal not found")
        return found

    async def proposal_content(self, proposal_id: str) -> tuple[dict[str, Any], bytes]:
        """A proposal and its proposed bytes."""
        proposal = await self.proposal(proposal_id)
        return proposal, await self.storage.blobs.get(proposal["sha256"])

    async def propose(
        self, node_id: str | None, path: str, data: bytes, *, mime: str | None = None, note: str | None = None
    ) -> dict[str, Any]:
        """Proposes new content for a file at the root (None) or in a node; returns the proposal."""
        await self.need(node_id, "viewer")
        principal = self.principal

        async def in_tx(conn: AsyncConnection, proposal_id: str) -> None:
            await self._audit("proposal.create", {"proposal": proposal_id, "node": node_id, "path": path})(conn)

        async with self.scoped() as conn:
            proposal_id = await proposals.propose(
                conn,
                self.storage,
                node=node_id,
                path=path,
                content=data,
                mime=mime,
                author=principal.actor,
                author_id=principal.user_id,
                note=note,
                in_tx=in_tx,
            )
        return await self.proposal(proposal_id)

    async def promotable(self, experiment_id: str) -> list[dict[str, Any]]:
        """What promoting an experiment would propose to its node."""
        await self.experiment(experiment_id)
        async with self.scoped() as conn:
            return await proposals.promotable(conn, self.ws, experiment_id)

    async def promote(
        self, experiment_id: str, paths: list[str] | None = None, note: str | None = None
    ) -> list[dict[str, Any]]:
        """
        Proposes an experiment's changed files (all of them, or those in `paths`)
        to its node, for someone who can edit there to accept. Only its author
        promotes it, and not once it is archived.
        """
        experiment = await self.experiment(experiment_id)
        self._need_author(experiment)
        if experiment["access"] != "writer":
            raise ForbiddenError("This experiment is archived; restore it to propose its files")
        candidates = await self.promotable(experiment_id)
        chosen = [c for c in candidates if c["path"] in paths] if paths is not None else candidates
        missing = [p for p in paths or [] if not any(c["path"] == p for c in candidates)]
        if missing:
            raise ProposalError(
                f"Nothing to propose for {', '.join(missing)}: "
                "the experiment didn't change it, or its node already has it"
            )
        if not chosen:
            raise ProposalError("This experiment has no changes its node doesn't have")
        principal = self.principal
        node_id = experiment["nodeId"]
        ids: list[str] = []
        for candidate in chosen:
            path = candidate["path"]

            async def in_tx(conn: AsyncConnection, proposal_id: str, path: str = path) -> None:
                target = {"proposal": proposal_id, "node": node_id, "path": path, "experiment": experiment_id}
                await self._audit("proposal.create", target)(conn)

            async with self.scoped() as conn:
                file = await proposals.experiment_file(conn, self.ws, experiment_id, path)
                if not file:
                    raise ProposalError(f"{path} is no longer in this experiment")
                proposal_id = await proposals.propose(
                    conn,
                    self.storage,
                    node=node_id,
                    path=path,
                    content=file,
                    mime=file["mime"],
                    author=principal.actor,
                    author_id=principal.user_id,
                    experiment_id=experiment_id,
                    note=note,
                    in_tx=in_tx,
                )
            ids.append(proposal_id)
        return [await self.proposal(proposal_id) for proposal_id in ids]

    async def decide(self, proposal_id: str, decision: str) -> dict[str, Any]:
        """
        Accepts (writes it as the file's next version, credited to its proposer),
        rejects, or withdraws a proposal. Accepting and rejecting need editor on
        its place; withdrawing is for its proposer.
        """
        proposal = await self.proposal(proposal_id)
        if proposal["status"] != "open":
            raise ProposalError(f"This proposal was already {proposal['status']}")
        if decision == "withdraw":
            if not proposal["mine"]:
                raise ForbiddenError("Only its proposer can withdraw a proposal")
        else:
            await self.need(proposal["node"], "editor")
        user_id = self.principal.user_id
        target = {"proposal": proposal_id, "node": proposal["node"], "path": proposal["path"]}
        audit = self._audit(f"proposal.{decision}", target)
        if decision != "accept":
            async with self.scoped() as conn:
                await proposals.decide(conn, self.storage, proposal_id, decision, user_id, audit)
            return await self.proposal(proposal_id)
        async with self.storage.pool.connection() as conn:
            files = await FileService(self.storage).in_node(conn, proposal["node"])
        if not files:
            raise NodeNotFoundError("Node not found")
        data = await self.storage.blobs.get(proposal["sha256"])
        decided = False

        async def in_tx(tx: AsyncConnection) -> None:
            nonlocal decided
            await proposals.decide_in(tx, self.storage, proposal_id, "accept", user_id)
            await audit(tx)
            decided = True

        async with self.scoped() as conn:
            await files.write(
                conn,
                proposal["path"],
                data,
                mime=proposal["mime"],
                author=proposal["author"],
                author_id=proposal["authorId"],
                in_tx=in_tx,
            )
            # The file already had these bytes, so no version was added.
            if not decided:
                await proposals.decide(conn, self.storage, proposal_id, "accept", user_id, audit)
        return await self.proposal(proposal_id)

    async def search(
        self,
        query: str,
        *,
        scope: str | None = None,
        near: str | None = None,
        near_experiment: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        """Files this principal may read that match, best first (see search.py)."""
        async with self.scoped() as conn:
            return await self.storage.search.search(
                conn,
                self.principal.user_id,
                query,
                scope=scope,
                near=near,
                near_experiment=near_experiment,
                limit=limit,
            )

    async def can_see(self, event: dict[str, Any]) -> bool:
        """Whether this principal may hear about a change."""
        user_id = self.principal.user_id
        op = event.get("op")
        # Hidden nodes stay hidden: not even their ids go out.
        if op == "node":
            return await self.access.sees_node(user_id, str(event.get("id")))
        if op == "experiment":
            return await self.access.hears_experiment(user_id, str(event.get("id")), str(event.get("change")))
        if op == "proposal":
            return event.get("authorId") == user_id or await self.role(event.get("node")) is not None
        if event.get("experiment"):
            return await self.access.experiment_access(user_id, str(event["experiment"])) is not None
        return await self.role(event.get("node")) is not None

    # The org tree and grants

    async def users(self) -> list[dict[str, Any]]:
        return await self.access.users()

    async def people(self) -> list[dict[str, Any]]:
        """Everyone who has signed in, with roles and groups: for workspace owners."""
        await self.need(None, "owner")
        return await self.access.people()

    async def groups(self) -> list[dict[str, Any]]:
        return await self.access.groups()

    async def create_group(self, parent_id: str | None, name: str) -> str:
        await self.need(None, "owner")

        async def in_tx(conn: AsyncConnection, group_id: str) -> None:
            await self._audit("group.create", {"group": group_id, "parent": parent_id, "name": name})(conn)

        return await self.access.create_group(parent_id, name, in_tx)

    async def rename_group(self, group_id: str, name: str) -> bool:
        await self.need(None, "owner")
        return await self.access.rename_group(
            group_id, name, self._audit("group.rename", {"group": group_id, "name": name})
        )

    async def delete_group(self, group_id: str) -> bool:
        await self.need(None, "owner")
        return await self.access.delete_group(group_id, self._audit("group.delete", {"group": group_id}))

    async def set_member(self, group_id: str, user_id: str, member: bool) -> bool:
        await self.need(None, "owner")
        action = "group.add_member" if member else "group.remove_member"
        return await self.access.set_member(
            group_id, user_id, member, self._audit(action, {"group": group_id, "user": user_id})
        )

    async def grants(self, node_id: str | None) -> list[dict[str, Any]]:
        """Grants on a node (None = workspace); owners of that node may see and change them."""
        await self.need(node_id, "owner")
        return await self.access.grants(node_id)

    async def set_grant(self, node_id: str | None, principal_type: str, principal_id: str, role: str) -> str:
        await self.need(node_id, "owner")
        return await self.access.set_grant(
            node_id,
            principal_type,
            principal_id,
            role,
            self.principal.user_id,
            self._audit(
                "grant.set",
                {"node": node_id, "principalType": principal_type, "principalId": principal_id, "role": role},
            ),
        )

    async def revoke(self, grant_id: str) -> bool:
        grant = next((g for g in await self.access.grants() if g["id"] == grant_id), None)
        if not grant:
            return False
        await self.need(grant["nodeId"], "owner")
        return await self.access.revoke(
            grant_id,
            self._audit(
                "grant.revoke",
                {"node": grant["nodeId"], "principalType": grant["principalType"], "principalId": grant["principalId"]},
            ),
        )

    async def audit_log(self, limit: int, kinds: list[str]) -> list[dict[str, Any]]:
        await self.need(None, "owner")
        return await self.access.audit_log(limit, kinds)


class FilesSession:
    """
    One place's files, as one principal (FilesSession in session.ts). Reads need
    viewer; writes and deletes need editor, like in a shared folder (a deleted
    file keeps its history, so nothing is lost).
    """

    def __init__(self, session: Session, service: FileService, role: Role) -> None:
        self.session = session
        self.service = service
        self.role = role

    @property
    def node_id(self) -> str | None:
        return self.service.node_id

    @property
    def experiment_id(self) -> str | None:
        return self.service.experiment_id

    def _need_editor(self) -> None:
        if at_least(self.role, "editor"):
            return
        raise ForbiddenError(
            "Only the experiment's author can change its files, and not once it is archived"
            if self.experiment_id
            else f"You can only {ROLE_VERB[self.role]} here; this needs editor access"
        )

    def _audit(self, action: str, target: dict[str, Any]):
        place = {"experiment": self.experiment_id} if self.experiment_id else {"node": self.node_id}
        return self.session._audit(action, {**place, **target})

    async def list(self) -> list[dict[str, Any]]:
        async with self.session.scoped() as conn:
            return await self.service.list(conn)

    async def stat(self, path: str) -> dict[str, Any] | None:
        async with self.session.scoped() as conn:
            return await self.service.stat(conn, path)

    async def read(self, path: str) -> tuple[dict[str, Any], bytes] | None:
        async with self.session.scoped() as conn:
            return await self.service.read(conn, path)

    async def history(self, path: str) -> list[dict[str, Any]] | None:
        async with self.session.scoped() as conn:
            return await self.service.history(conn, path)

    async def write(self, path: str, data: bytes, *, mime: str | None = None, create_only: bool = False):
        self._need_editor()
        principal = self.session.principal
        async with self.session.scoped() as conn:
            return await self.service.write(
                conn,
                path,
                data,
                mime=mime,
                create_only=create_only,
                author=principal.actor,
                author_id=principal.user_id,
                in_tx=self._audit("file.write", {"path": path, "size": len(data)}),
            )

    async def rename(self, source: str, target: str) -> dict[str, Any] | None:
        self._need_editor()
        async with self.session.scoped() as conn:
            return await self.service.rename(
                conn,
                source,
                target,
                author=self.session.principal.actor,
                in_tx=self._audit("file.rename", {"path": source, "to": target}),
            )

    async def remove(self, path: str) -> bool:
        self._need_editor()
        async with self.session.scoped() as conn:
            return await self.service.remove(conn, path, self._audit("file.delete", {"path": path}))
