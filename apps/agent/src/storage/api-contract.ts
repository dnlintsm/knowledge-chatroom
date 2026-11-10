/**
 * Ties the storage API's TypeScript types to its OpenAPI spec
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
