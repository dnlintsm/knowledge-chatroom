# Generated from packages/contracts/openapi/storage.yaml by datamodel-codegen.
# Don't edit: change the spec, then run `uv run datamodel-codegen` in packages/knowledge-py.

from __future__ import annotations

from typing import Annotated, Any, Dict, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from typing_extensions import TypeAliasType


class Error(BaseModel):
    error: str
    exists: Literal[True] | None = None
    """
    The path already has a file.
    """


class IdOnly(BaseModel):
    id: str


Timestamp = TypeAliasType("Timestamp", AwareDatetime)
"""
ISO 8601, UTC.
"""


AuthorType = TypeAliasType("AuthorType", Literal["user", "agent"])


FileKind = TypeAliasType("FileKind", Literal["note", "skill", "upload", "artifact"])
"""
From the path's top folder (packages/contracts/src/files.ts KIND_FOLDERS).
"""


Role = TypeAliasType("Role", Literal["viewer", "editor", "owner"])


RoleOrNull = TypeAliasType("RoleOrNull", Role | None)


class FileInfo(BaseModel):
    path: str
    kind: FileKind
    mime: str
    size: Annotated[int, Field(ge=0)]
    sha256: Annotated[str, Field(pattern="^[a-f0-9]{64}$")]
    updatedAt: Timestamp
    author: AuthorType


class FileList(BaseModel):
    files: list[FileInfo]


class FileVersion(BaseModel):
    id: str
    sha256: Annotated[str, Field(pattern="^[a-f0-9]{64}$")]
    size: Annotated[int, Field(ge=0)]
    mime: str
    author: AuthorType
    authorId: str | None
    createdAt: Timestamp


class VersionList(BaseModel):
    versions: list[FileVersion]


class FileEvent(BaseModel):
    op: Literal["write", "delete"]
    node: str | None
    experiment: str | None = None
    path: str
    sha256: Annotated[str | None, Field(pattern="^[a-f0-9]{64}$")] = None
    author: AuthorType | None = None


class NodeEvent(BaseModel):
    op: Literal["node"]
    change: Literal["create", "rename", "delete"]
    id: str


class ExperimentEvent(BaseModel):
    op: Literal["experiment"]
    change: Literal["create", "update", "status", "delete"]
    id: str
    node: str | None
    """
    null for an experiment at the workspace root.
    """


class ProposalEvent(BaseModel):
    op: Literal["proposal"]
    change: Literal["create", "update", "accepted", "rejected", "withdrawn"]
    id: str
    node: str | None
    path: str
    author: AuthorType
    authorId: str


WorkspaceEvent = TypeAliasType("WorkspaceEvent", FileEvent | NodeEvent | ExperimentEvent | ProposalEvent)
"""
One change on the /files?watch stream.
"""


class NodeType(BaseModel):
    name: str
    """
    A level of the tree, such as tech (depth 1) or process (depth 4).
    """
    depth: Annotated[int, Field(ge=1)]


class KnowledgeNode(BaseModel):
    id: UUID
    parentId: str | None
    type: str
    depth: Annotated[int, Field(ge=1)]
    name: str
    fileCount: Annotated[int, Field(ge=0)]
    """
    Live files attached directly to this node.
    """
    updatedAt: Timestamp


class VisibleNode(KnowledgeNode):
    role: RoleOrNull
    """
    The user's role; null for a node shown only because something below it is visible (its fileCount is then 0).
    """


class Tree(BaseModel):
    types: list[NodeType]
    rootRole: RoleOrNull
    nodes: list[VisibleNode]


ExperimentStatus = TypeAliasType("ExperimentStatus", Literal["draft", "shared", "archived"])
"""
Who sees it. A draft only its author; shared or archived everyone who can view its node.
"""


ExperimentState = TypeAliasType("ExperimentState", Literal["ready", "running", "done", "failed"])
"""
How far a run got.
"""


class ExperimentInput(BaseModel):
    title: Annotated[str | None, Field(max_length=200)] = None
    hypothesis: str | None = None
    params: dict[str, Any] | None = None
    results: dict[str, Any] | None = None
    status: ExperimentStatus | None = None
    state: ExperimentState | None = None


class Experiment(BaseModel):
    id: str
    nodeId: str | None
    """
    null at the workspace root.
    """
    authorId: str
    authorName: str | None
    title: str
    hypothesis: str
    params: dict[str, Any]
    results: dict[str, Any]
    status: ExperimentStatus
    state: ExperimentState
    forkedAt: Timestamp
    updatedAt: Timestamp
    fileCount: Annotated[int, Field(ge=0)]
    provenance: dict[str, Any]
    """
    Where a run came from; {} when nobody recorded it.
    """
    access: Literal["writer", "reader"]
    """
    writer: its author, while it isn't archived. reader: may look.
    """
    mine: bool
    """
    Whether the asking user is its author.
    """


class ExperimentUploadMeta(ExperimentInput):
    """
    The `meta` part of an experiment upload, as JSON.
    """

    id: UUID
    """
    The new experiment's id.
    """
    path: str | list[str | None]
    """
    A node name for every level, top level first; empty (or null) for `None`.
    """
    title: Annotated[str, Field(max_length=200)]


class ExperimentUpload(BaseModel):
    experiment: Experiment
    lineage: list[KnowledgeNode]
    """
    The node it sits on and that node's ancestors, top level first.
    """
    created: list[KnowledgeNode]
    """
    The nodes of the path that didn't exist and were added for it, top level first.
    """
    files: list[FileInfo]


class RunInputSource(BaseModel):
    path: str
    node: str | None = None
    """
    Its knowledge node; null or left out for the workspace root.
    """
    experiment: str | None = None
    """
    Its experiment
    """
    as_: Annotated[str | None, Field(alias="as")] = None
    """
    Its name under inputs/; its own file name by default.
    """


class SearchHit(BaseModel):
    path: str
    kind: FileKind
    mime: str
    node: str | None
    """
    null at the root or in an experiment.
    """
    experiment: str | None
    where: list[str]
    """
    Node names from the top down to the file's node.
    """
    experimentTitle: str | None
    snippet: str
    """
    The passage that matched; "" when only the path did.
    """
    match: Literal["words", "meaning"]
    """
    words: its text or path has the words; meaning: only a passage close in meaning.
    """
    updatedAt: Timestamp
    author: AuthorType


ProposalStatus = TypeAliasType("ProposalStatus", Literal["open", "accepted", "rejected", "withdrawn"])


class Proposal(BaseModel):
    id: str
    node: str | None
    """
    The node whose file it changes; null for the workspace root.
    """
    path: str
    sha256: Annotated[str, Field(pattern="^[a-f0-9]{64}$")]
    size: Annotated[int, Field(ge=0)]
    mime: str
    author: AuthorType
    authorId: str
    """
    The user
    """
    authorName: str | None
    experiment: str | None
    """
    The experiment it was promoted from.
    """
    experimentTitle: str | None
    note: str
    status: ProposalStatus
    decidedByName: str | None
    decidedAt: Timestamp | None
    createdAt: Timestamp
    updatedAt: Timestamp
    isNew: bool
    """
    No live file at the path yet; accepting creates it.
    """
    fileChanged: bool
    """
    The file changed after this was proposed.
    """
    mine: bool
    """
    Whether the asking user proposed it (and may withdraw it).
    """
    canDecide: bool
    """
    Whether the asking user may accept or reject it.
    """


class ProposalList(BaseModel):
    proposals: list[Proposal]


class Promotable(BaseModel):
    path: str
    change: Literal["new", "changed"]
    """
    new: the node has no file there; changed: the node's differs.
    """
    size: Annotated[int, Field(ge=0)]
    mime: str
    proposal: str | None
    """
    This experiment's open proposal with exactly these bytes.
    """


class ChatSummary(BaseModel):
    id: str
    name: str | None
    agentId: str
    archived: bool
    createdAt: Timestamp
    updatedAt: Timestamp
    lastRunAt: Timestamp | None


class ChatRun(BaseModel):
    runId: str
    parentRunId: str | None
    events: list[Any]
    """
    The run's AG-UI events, compacted.
    """
    createdAt: Timestamp


class User(BaseModel):
    id: str
    subject: str
    email: str | None
    name: str | None


class Person(User):
    createdAt: Timestamp
    lastSeenAt: Timestamp | None
    role: RoleOrNull
    """
    Their own grant on the whole workspace, if any.
    """
    grantId: str | None
    effectiveRole: RoleOrNull
    """
    Their best workspace role, groups included.
    """
    groupIds: list[str]


class Group(BaseModel):
    id: str
    parentId: str | None
    name: str
    memberIds: list[str]
    """
    Direct members; members of sub-groups are listed on those groups.
    """


class Grant(BaseModel):
    id: str
    nodeId: str | None
    """
    null for the whole workspace.
    """
    principalType: Literal["user", "group"]
    principalId: str
    role: Role
    createdAt: Timestamp


class AuditEntry(BaseModel):
    id: str
    actorType: Literal["user", "agent"]
    actorId: str | None
    action: str
    """
    Such as node.create, group.add_member or grant.set.
    """
    target: dict[str, Any]
    at: Timestamp


class RunAgentInput(BaseModel):
    """
    An AG-UI run request (https://docs.ag-ui.com); only the fields /suggest reads are listed.
    """

    model_config = ConfigDict(
        extra="allow",
    )
    threadId: str
    runId: str
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]] | None = None
    context: list[dict[str, Any]] | None = None


class AgUiEvent(BaseModel):
    """
    One AG-UI event (https://docs.ag-ui.com), by `type`.
    """

    model_config = ConfigDict(
        extra="allow",
    )
    type: str


class ToolMenuItem(BaseModel):
    server: str
    """
    Its name in MCP_SERVERS.
    """
    label: str
    chip: str
    """
    The chip's text in the composer.
    """
    description: str | None
    icon: str | None
    mode: Literal["auto", "manual"]
    callable: list[str]
    """
    Tools the app may call with POST /tools/{server}/{tool}.
    """


SkillMode = TypeAliasType("SkillMode", Literal["auto", "manual", "off"])


SkillModeOrNull = TypeAliasType("SkillModeOrNull", SkillMode | None)


SkillSource = TypeAliasType("SkillSource", Literal["builtin", "workspace", "hub"])


class HubPin(BaseModel):
    """
    An installed hub skill's version, the newest one to update to, and their standing.
    """

    version: int
    latest: int
    """
    The newest version that isn't yanked.
    """
    verified: bool
    yanked: bool
    yankReason: str | None


class SkillInfo(BaseModel):
    name: str
    description: str
    argumentHint: str | None
    """
    Shown after /name in the slash menu, such as [file].
    """
    source: SkillSource
    path: str | None
    """
    Its SKILL.md in the workspace; null for built-in skills.
    """
    modelInvocable: bool
    """
    False when its front matter says disable-model-invocation: never auto.
    """
    userInvocable: bool
    """
    False when its front matter says user-invocable: false: no /name.
    """
    needsExecution: bool
    """
    It ships scripts or asks for a shell.
    """
    mode: SkillMode
    defaultMode: SkillMode
    workspaceMode: SkillModeOrNull
    userMode: SkillModeOrNull
    chatMode: SkillModeOrNull
    hub: HubPin | None


class SkillList(BaseModel):
    skills: list[SkillInfo]
    canSetDefaults: bool
    """
    Editor at the root: may set defaults and add skills.
    """
    canPublish: bool
    """
    Owner at the root.
    """
    hub: bool
    """
    There is a hub (it needs storage).
    """
    scripts: bool
    """
    Skills' scripts run (SKILL_SCRIPTS=on).
    """


class ScanFlag(BaseModel):
    kind: Literal[
        "scripts", "network", "large", "binary", "hidden-text", "instructions"
    ]
    path: str
    line: int | None
    detail: str


class HubListing(BaseModel):
    name: str
    description: str
    argumentHint: str | None
    modelInvocable: bool
    userInvocable: bool
    needsExecution: bool
    publisher: str | None
    """
    Who first published it.
    """
    mine: bool
    """
    You published it.
    """
    latest: int
    verified: bool
    """
    About `latest`.
    """
    yanked: bool
    """
    About `latest`.
    """
    flags: int
    """
    How many scan flags `latest` has.
    """
    updatedAt: Timestamp
    installed: int | None
    """
    The version installed in this workspace.
    """
    reports: int | None
    """
    Open reports
    """


class HubVersion(BaseModel):
    version: int
    publishedAt: Timestamp
    publishedBy: str | None
    files: int
    size: int
    needsExecution: bool
    verified: bool
    yanked: bool
    yankReason: str | None
    flags: list[ScanFlag]


class HubReport(BaseModel):
    id: str
    version: int | None
    reason: str
    reporter: str | None
    createdAt: Timestamp


class HubDetail(HubListing):
    versions: list[HubVersion]
    version: int
    """
    The version shown.
    """
    skillMd: str
    """
    That version's SKILL.md.
    """
    canModerate: bool
    """
    A hub admin: may verify and dismiss reports.
    """
    canYank: bool
    openReports: list[HubReport] | None


class HubList(BaseModel):
    skills: list[HubListing]
    canInstall: bool
    canPublish: bool
    isAdmin: bool


class HubDiffFile(BaseModel):
    path: str
    change: Literal["added", "removed", "changed"]
    before: str | None
    after: str | None
    binary: bool


class HubDiff(BaseModel):
    name: str
    from_: Annotated[int, Field(alias="from")]
    to: int
    files: list[HubDiffFile]
    flags: list[ScanFlag]
    """
    What the scan found in `to`.
    """


MemoryType = TypeAliasType("MemoryType", Literal["preference", "profile", "project", "reference", "feedback"])


MemoryMode = TypeAliasType("MemoryMode", Literal["on", "ask", "off"])


MemoryAuthor = TypeAliasType("MemoryAuthor", Literal["user", "agent"])


class MemoryInput(BaseModel):
    description: str
    """
    One line; it goes in the index.
    """
    type: str
    """
    One of MemoryType.
    """
    body: str
    """
    The note
    """


class MemorySummary(BaseModel):
    name: str
    description: str
    type: MemoryType
    version: int
    createdBy: MemoryAuthor
    updatedBy: MemoryAuthor
    archived: bool
    createdAt: Timestamp
    updatedAt: Timestamp
    lastUsedAt: Timestamp | None


class MemoryNote(MemorySummary):
    body: str


class MemoryVersion(BaseModel):
    version: int
    description: str
    type: MemoryType
    body: str
    changedBy: MemoryAuthor
    threadId: str | None
    createdAt: Timestamp


class Shared(BaseModel):
    """
    For a shared note, which one and where it lives.
    """

    id: str
    label: str


class MemoryEvent(BaseModel):
    """
    What Claude did with a note in a run, as the chat shows it.
    """

    id: str
    name: str
    description: str
    kind: Literal["read", "create", "update", "archive", "propose"]
    version: int
    shared: Shared | None = None
    """
    For a shared note, which one and where it lives.
    """


class MemoryActivity(MemoryEvent):
    threadId: str
    source: Literal["chat", "learn", "inbox"]
    at: Timestamp
    undone: bool
    undoable: bool
    """
    Still the note's latest change, so Undo can take it back.
    """


class InboxItem(BaseModel):
    """
    A change Claude proposed, waiting for the user.
    """

    id: str
    op: Literal["add", "update", "delete"]
    name: str
    description: str | None
    type: MemoryType | None
    body: str | None
    baseVersion: int | None
    """
    The note's version the change was made against.
    """
    source: Literal["chat", "learn", "import"]
    threadId: str | None
    reason: str | None
    createdAt: Timestamp


class MemorySettings(BaseModel):
    mode: MemoryMode
    incognito: bool


class MemoryImport(BaseModel):
    proposed: int
    """
    Notes now waiting in the inbox.
    """
    skipped: int
    """
    Notes left out: invalid, or the inbox was full.
    """
    how: Literal["files", "text", "whole"]
    """
    files: front matter read as is; text: the model sorted plain text; whole: the model wasn't available, so the text is one note.
    """


SharedScope = TypeAliasType("SharedScope", Literal["workspace", "node", "group"])


SharedMode = TypeAliasType("SharedMode", Literal["auto", "manual", "off"])


class SharedTarget(BaseModel):
    """
    A place for shared memory: the workspace, a knowledge node (`nodeId`) or a group (`groupId`).
    """

    scope: SharedScope
    nodeId: str | None = None
    groupId: str | None = None


class SharedPlace(BaseModel):
    scope: SharedScope
    nodeId: str | None
    groupId: str | None
    label: str
    """
    "Workspace", the node's or the group's name.
    """


class Pack(BaseModel):
    """
    Installed from a memory pack, read-only until the pack is forked.
    """

    installId: str
    name: str
    version: int


class SharedSummary(BaseModel):
    id: str
    name: str
    description: str
    type: MemoryType
    version: int
    place: SharedPlace
    canEdit: bool
    """
    You can edit it, set it for everyone, and decide its proposals.
    """
    mode: SharedMode
    myMode: SharedMode | None
    everyoneMode: SharedMode
    updatedAt: Timestamp
    pack: Pack | None
    """
    Installed from a memory pack, read-only until the pack is forked.
    """


class SharedNote(SharedSummary):
    body: str


class SharedVersion(BaseModel):
    version: int
    description: str
    type: MemoryType
    body: str
    changedBy: str | None
    changedAs: MemoryAuthor
    createdAt: Timestamp


class SharedProposal(BaseModel):
    id: str
    op: Literal["add", "update", "delete"]
    place: SharedPlace
    memoryId: str | None
    name: str
    description: str | None
    type: MemoryType | None
    body: str | None
    baseVersion: int | None
    author: str | None
    """
    The person, or the person Claude was working for.
    """
    authorType: MemoryAuthor
    mine: bool
    canDecide: bool
    threadId: str | None
    reason: str | None
    createdAt: Timestamp


class SharedTargetPlace(SharedPlace):
    canEdit: bool


class PackNote(BaseModel):
    name: str
    description: str
    type: MemoryType
    body: str


class PackVersion(BaseModel):
    version: int
    description: str
    notes: int
    flags: list[ScanFlag]
    publishedBy: str | None
    publishedAt: Timestamp
    verified: bool
    yanked: bool
    yankReason: str | None


class PackListing(BaseModel):
    name: str
    owner: str | None
    mine: bool
    latest: PackVersion | None
    """
    The newest version that isn't yanked; null when all are.
    """
    updatedAt: Timestamp


class PackDetail(PackListing):
    versions: list[PackVersion]
    version: PackVersion
    notes: list[PackNote]
    isAdmin: bool


class PackInstall(BaseModel):
    id: str
    name: str
    version: int
    latest: int | None
    """
    A newer version that isn't yanked, if any.
    """
    place: SharedPlace
    canEdit: bool
    notes: int
    installedAt: Timestamp


class Limits(BaseModel):
    notes: int
    body: int
    description: int
    index: int


class MemoryOverview(MemorySettings):
    notes: list[MemorySummary]
    """
    Your notes, archived ones last.
    """
    inbox: list[InboxItem]
    shared: list[SharedSummary]
    sharedProposals: list[SharedProposal]
    """
    Open proposals you decide or made.
    """
    targets: list[SharedTargetPlace]
    """
    The places you can share to.
    """
    installs: list[PackInstall]
    """
    Packs installed in places you read.
    """
    types: list[MemoryType]
    limits: Limits


class DeletedFlag(BaseModel):
    id: str
    deleted: Literal[True]


class RenameFileRequest(BaseModel):
    path: str
    """
    The new path.
    """


class DeleteFileResponse(BaseModel):
    deleted: str
    """
    The path.
    """


class CreateNodeRequest(BaseModel):
    parentId: str | None
    """
    null for a top-level node.
    """
    name: str


class GetNodeResponse(BaseModel):
    node: KnowledgeNode
    lineage: list[KnowledgeNode]


class RenameNodeRequest(BaseModel):
    name: str


class DeleteNodeResponse(BaseModel):
    deleted: str
    """
    The id.
    """


class ListExperimentsResponse(BaseModel):
    experiments: list[Experiment]


class CreateExperimentRequest(ExperimentInput):
    nodeId: str | None
    title: Annotated[str, Field(max_length=200)]


class UploadExperimentRequest(BaseModel):
    model_config = ConfigDict(
        extra="allow",
    )
    __annotations__ = {
        "__pydantic_extra__": Dict[str, bytes],
    }
    meta: ExperimentUploadMeta


class DeleteExperimentResponse(BaseModel):
    deleted: str
    """
    The id.
    """


class AddRunInputsRequest(BaseModel):
    inputs: list[RunInputSource]


class SearchResponse(BaseModel):
    results: list[SearchHit]


class PromoteExperimentRequest(BaseModel):
    experimentId: str
    paths: list[str] | None = None
    """
    Only these files; all changed files when left out.
    """
    note: str | None = None


class ListPromotableResponse(BaseModel):
    files: list[Promotable]


class ListChatsResponse(BaseModel):
    threads: list[ChatSummary]
    nextCursor: str | None


class GetChatResponse(BaseModel):
    chat: ChatSummary
    messages: list[Any]
    """
    AG-UI messages.
    """


class UpdateChatRequest(BaseModel):
    name: str | None = None
    archived: bool | None = None


class DeleteChatResponse(BaseModel):
    deleted: str
    """
    The id.
    """


class ListChatRunsResponse(BaseModel):
    runs: list[ChatRun]


class SaveChatRunRequest(BaseModel):
    agentId: str
    runId: str
    parentRunId: str | None = None
    events: list[Any]
    """
    The run's AG-UI events.
    """
    messages: list[Any]
    """
    The whole conversation after the run (AG-UI messages).
    """
    name: str | None = None
    """
    The chat's name if it has none yet.
    """


class GetMyAccessResponse(BaseModel):
    me: User | None
    rootRole: RoleOrNull


class ListUsersResponse(BaseModel):
    users: list[User]


class ListPeopleResponse(BaseModel):
    people: list[Person]


class ListGroupsResponse(BaseModel):
    groups: list[Group]


class CreateGroupRequest(BaseModel):
    parentId: str | None
    name: str


class RenameGroupRequest(BaseModel):
    name: str


class RenameGroupResponse(BaseModel):
    ok: Literal[True]


class DeleteGroupResponse(BaseModel):
    ok: Literal[True]


class AddGroupMemberResponse(BaseModel):
    ok: Literal[True]


class RemoveGroupMemberResponse(BaseModel):
    ok: Literal[True]


class ListGrantsResponse(BaseModel):
    grants: list[Grant]


class SetGrantRequest(BaseModel):
    node: str | None
    """
    null for the whole workspace.
    """
    principalType: Literal["user", "group"]
    principalId: str
    role: Role


class RevokeGrantResponse(BaseModel):
    ok: Literal[True]


class GetAuditLogResponse(BaseModel):
    entries: list[AuditEntry]


class GetHealthResponse(BaseModel):
    status: Literal["ok"]


class GetIdentityPublicKeyResponse(BaseModel):
    alg: Literal["Ed25519"]
    key: str
    """
    The raw public key
    """


class ListToolsResponse(BaseModel):
    tools: list[ToolMenuItem]


class CallToolRequest(BaseModel):
    arguments: dict[str, Any]


class CallToolResponse(BaseModel):
    result: Any
    """
    Its structured content, or the JSON in its text, or null.
    """
    text: str


class ImportSkillResponse(BaseModel):
    name: str
    path: str
    """
    Its SKILL.md in the workspace.
    """
    files: int


class SetSkillModeRequest(BaseModel):
    mode: SkillModeOrNull
    scope: Literal["user", "workspace", "chat"] | None = "user"
    """
    `workspace` needs editor access at the root.
    """
    thread: str | None = None
    """
    The chat
    """


class DeleteSkillResponse(BaseModel):
    name: str
    deleted: int
    """
    How many files.
    """


class PublishHubSkillRequest(BaseModel):
    skill: str
    """
    The workspace skill's name.
    """


class PublishHubSkillResponse(BaseModel):
    name: str
    version: int
    unchanged: bool


class InstallHubSkillRequest(BaseModel):
    version: Annotated[int | None, Field(ge=1)] = None
    """
    Leave out for the newest.
    """


class InstallHubSkillResponse(BaseModel):
    name: str
    version: int


class UninstallHubSkillResponse(BaseModel):
    name: str
    installed: None


class ForkHubSkillResponse(BaseModel):
    name: str
    path: str
    """
    Its SKILL.md in the workspace.
    """


class VerifyHubSkillRequest(BaseModel):
    version: Annotated[int, Field(ge=1)]
    verified: bool | None = True


class VerifyHubSkillResponse(BaseModel):
    name: str
    version: int
    verified: bool


class YankHubSkillRequest(BaseModel):
    version: Annotated[int, Field(ge=1)]
    yanked: bool | None = True
    reason: str | None = None


class YankHubSkillResponse(BaseModel):
    name: str
    version: int
    yanked: bool


class ReportHubSkillRequest(BaseModel):
    reason: str
    version: Annotated[int | None, Field(ge=1)] = None


class DismissHubReportResponse(BaseModel):
    id: str
    dismissed: Literal[True]


class SetMemorySettingsRequest(BaseModel):
    mode: MemoryMode | None = None
    thread: str | None = None
    """
    The chat
    """
    incognito: bool | None = None


class GetMemoryActivityResponse(BaseModel):
    activity: list[MemoryActivity]


class AcceptMemoryChangeResponse(BaseModel):
    id: str
    status: Literal["accepted"]
    note: MemoryNote | None
    """
    The note now; null when the change deleted it.
    """


class RejectMemoryChangeResponse(BaseModel):
    id: str
    status: Literal["rejected"]


class ImportMemoryRequest(BaseModel):
    text: str | None = None
    label: str | None = None
    """
    Where it came from
    """


class GetMemoryNoteResponse(BaseModel):
    note: MemoryNote
    versions: list[MemoryVersion]


class SaveMemoryNoteResponse(BaseModel):
    note: MemoryNote


class DeleteMemoryNoteResponse(BaseModel):
    name: str
    deleted: Literal[True]


class RestoreMemoryNoteRequest(BaseModel):
    version: Annotated[int, Field(ge=1)]


class RestoreMemoryNoteResponse(BaseModel):
    note: MemoryNote


class ArchiveMemoryNoteRequest(BaseModel):
    archived: bool | None = True


class ArchiveMemoryNoteResponse(BaseModel):
    note: MemoryNote


class UndoMemoryChangeResponse(BaseModel):
    name: str
    note: MemoryNote | None
    """
    The note now; null when undoing removed it.
    """


class ShareMemoryNoteRequest(SharedTarget, MemoryInput):
    name: str


class ShareMemoryNoteResponse(BaseModel):
    note: SharedNote | None
    proposal: SharedProposal | None


class DecideSharedMemoryProposalResponse(BaseModel):
    id: str
    status: Literal["accept", "reject", "withdraw"]
    note: SharedNote | None
    """
    The note after an accepted change; otherwise null.
    """


class GetSharedMemoryNoteResponse(BaseModel):
    note: SharedNote
    versions: list[SharedVersion]


class UpdateSharedMemoryNoteRequest(MemoryInput):
    version: int | None = None
    """
    Refuse (409) if the note is past this version.
    """


class UpdateSharedMemoryNoteResponse(BaseModel):
    note: SharedNote


class SetSharedMemoryModeRequest(BaseModel):
    mode: SharedMode | None = None
    """
    null clears your own choice.
    """
    everyone: bool | None = False


class SetSharedMemoryModeResponse(BaseModel):
    note: SharedSummary


class ListMemoryPacksResponse(BaseModel):
    packs: list[PackListing]
    isAdmin: bool


class PublishMemoryPackRequest(SharedTarget):
    name: str
    description: str


class PublishMemoryPackResponse(BaseModel):
    name: str
    version: int
    unchanged: bool


class GetMemoryPackResponse(BaseModel):
    pack: PackDetail


class InstallMemoryPackRequest(SharedTarget):
    version: Annotated[int | None, Field(ge=1)] = None


class InstallMemoryPackResponse(BaseModel):
    install: PackInstall


class VerifyMemoryPackRequest(BaseModel):
    version: Annotated[int, Field(ge=1)]
    verified: bool | None = True


class VerifyMemoryPackResponse(BaseModel):
    pack: PackDetail


class YankMemoryPackRequest(BaseModel):
    version: Annotated[int, Field(ge=1)]
    yanked: bool | None = True
    reason: str | None = None


class YankMemoryPackResponse(BaseModel):
    pack: PackDetail


class ForkMemoryPackResponse(BaseModel):
    id: str
    notes: int


class Tool(BaseModel):
    name: str
    description: str
    inputSchema: dict[str, Any]
    """
    A JSON Schema.
    """


class GetMemoryAgentResponse(BaseModel):
    prompt: str
    tools: list[Tool]


class CallMemoryToolRequest(BaseModel):
    """
    The tool's arguments, as its inputSchema says.
    """

    model_config = ConfigDict(
        extra="allow",
    )


class CallMemoryToolResponse(BaseModel):
    text: str
    isError: bool
