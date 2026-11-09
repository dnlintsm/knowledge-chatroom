"use client";

import { useCallback, useState } from "react";
import { listExperiments, listNodes, listProposals, type Account, type Experiment, type KnowledgeTree, type Proposal } from "./server-files";

/** Tree, experiments, proposals and account metadata, separate from file bytes. */
export function useWorkspaceCatalog() {
  const [tree, setTree] = useState<KnowledgeTree>({ types: [], rootRole: null, nodes: [] });
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [account, setAccount] = useState<Account>({ login: false, user: null });
  const refreshExperiments = useCallback(async () => {
    const next = await listExperiments();
    if (next) setExperiments(next);
    return next;
  }, []);
  const refreshProposals = useCallback(async () => {
    const next = await listProposals();
    if (next) setProposals(next);
    return next;
  }, []);
  const refreshTree = useCallback(async () => {
    const [next, list] = await Promise.all([listNodes(), refreshExperiments()]);
    if (next) setTree(next);
    return next && list ? { nodes: next.nodes, experiments: list } : null;
  }, [refreshExperiments]);
  return {
    tree, experiments, proposals, account, setExperiments, setProposals, setAccount,
    refreshExperiments, refreshProposals, refreshTree,
  };
}
