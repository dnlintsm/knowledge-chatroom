/**
 * Ties the agent server's TypeScript types (the storage API, skills, the hub
 * and the tools menu) to its OpenAPI spec
 * (packages/contracts/openapi/storage.yaml, issue #169). Each line fails
 * `pnpm typecheck` when a type here and the spec's schema stop matching in
 * either direction: change both, then run `pnpm -C packages/contracts openapi`.
 * Types only; nothing here runs.
 */

import type { components } from "@knowledge-chatroom/contracts/generated/storage-api";
import type { FileInfo, WorkspaceEvent } from "@knowledge-chatroom/contracts/storage-contract";

import type { AuditEntry, Grant, Group, Person, User } from "./access";
import type { ChatRun, ChatSummary } from "./chats";
import type { Experiment, ExperimentInput } from "./experiments";
import type { FileVersion } from "./files";
import type { KnowledgeNode, NodeType } from "./nodes";
import type { Promotable, Proposal } from "./proposals";
import type { SearchHit } from "./search";
import type { ExperimentUpload, RunInputSource, Tree } from "./session";
import type { HubPin, SkillInfo } from "../skills/catalog";
import type { HubDetail, HubDiff, HubDiffFile, HubList, HubListing, HubReport, HubVersion } from "../skills/hub";
import type { ScanFlag } from "../skills/scan";
import type { SkillList } from "../skills/service";
import type { ToolMenuItem } from "../tools-api";

type Schema = components["schemas"];

/** true when each type can stand for the other. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Check<T extends true> = T;

export type StorageApiContract = [
  Check<Same<FileInfo, Schema["FileInfo"]>>,
  Check<Same<FileVersion, Schema["FileVersion"]>>,
  Check<Same<WorkspaceEvent, Schema["WorkspaceEvent"]>>,
  Check<Same<NodeType, Schema["NodeType"]>>,
  Check<Same<KnowledgeNode, Schema["KnowledgeNode"]>>,
  Check<Same<Tree, Schema["Tree"]>>,
  Check<Same<Experiment, Schema["Experiment"]>>,
  Check<Same<ExperimentInput, Schema["ExperimentInput"]>>,
  Check<Same<RunInputSource, Schema["RunInputSource"]>>,
  Check<Same<ExperimentUpload, Schema["ExperimentUpload"]>>,
  Check<Same<SearchHit, Schema["SearchHit"]>>,
  Check<Same<Proposal, Schema["Proposal"]>>,
  Check<Same<Promotable, Schema["Promotable"]>>,
  Check<Same<ChatSummary, Schema["ChatSummary"]>>,
  Check<Same<ChatRun, Schema["ChatRun"]>>,
  Check<Same<User, Schema["User"]>>,
  Check<Same<Person, Schema["Person"]>>,
  Check<Same<Group, Schema["Group"]>>,
  Check<Same<Grant, Schema["Grant"]>>,
  Check<Same<AuditEntry, Schema["AuditEntry"]>>,
];

export type AgentApiContract = [
  Check<Same<SkillInfo, Schema["SkillInfo"]>>,
  Check<Same<SkillList, Schema["SkillList"]>>,
  Check<Same<HubPin, Schema["HubPin"]>>,
  Check<Same<ScanFlag, Schema["ScanFlag"]>>,
  Check<Same<HubListing, Schema["HubListing"]>>,
  Check<Same<HubVersion, Schema["HubVersion"]>>,
  Check<Same<HubReport, Schema["HubReport"]>>,
  Check<Same<HubDetail, Schema["HubDetail"]>>,
  Check<Same<HubList, Schema["HubList"]>>,
  Check<Same<HubDiffFile, Schema["HubDiffFile"]>>,
  Check<Same<HubDiff, Schema["HubDiff"]>>,
  Check<Same<ToolMenuItem, Schema["ToolMenuItem"]>>,
];
