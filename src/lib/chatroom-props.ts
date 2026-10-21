/**
 * What every chat run tells the agent about the user and where they are, as
 * AG-UI `forwardedProps.knowledge_chatroom` (docs/remote-agent.md is the
 * contract for backends). The browser fills in the place
 * (src/components/workspace/use-chatroom-props.ts); the Next.js server sets
 * `user` from the signed-in session (src/agent.ts), replacing whatever the
 * browser sent, so a backend can trust it as far as it trusts the app.
 *
 * Keys are snake_case for Python backends. Adapters that turn forwardedProps
 * into SDK options (ag_ui_claude_sdk, @ag-ui/claude-agent-sdk) skip this key.
 */

export const CHATROOM_PROPS = "knowledge_chatroom";
/** 2: runs are experiments, so `run_dir` is gone and `experiment` says how far the run got. */
export const CHATROOM_PROPS_VERSION = 2;

export interface ChatroomUser {
  /** "<issuer>|<subject>" from the login provider; "local" without login. */
  id: string;
  email: string | null;
  name: string | null;
  /** false without login (AUTH_MODE=local): everyone is the one local user. */
  signed_in: boolean;
}

/** Without login: the one built-in user, who owns the workspace. */
export const LOCAL_USER: ChatroomUser = { id: "local", email: null, name: null, signed_in: false };

export interface ChatroomNode {
  id: string;
  name: string;
  /** Its level, e.g. tech, module, loop or process. */
  type: string;
}

/** Where the user is; the browser sends it with every run. */
export interface ChatroomPlace {
  version: typeof CHATROOM_PROPS_VERSION;
  /** "server": files are in the storage API; "local": only in the browser. */
  storage: "server" | "local" | "loading";
  /** The knowledge node the user is in; null = the workspace root. */
  node: (ChatroomNode & { path: ChatroomNode[] }) | null;
  /**
   * The experiment (run) the user is working in, on `node`; `node_id` null
   * when it is at the workspace root. `report` is its report's path in it,
   * null when it has none yet.
   */
  experiment: {
    id: string;
    node_id: string | null;
    title: string;
    status: string;
    state: string;
    can_change: boolean;
    report: string | null;
  } | null;
  /** The file open in the middle pane, a path in the place's files. */
  selected_path: string | null;
}

export interface ChatroomProps extends ChatroomPlace {
  /** Set by the server; null when it couldn't tell who the run is for. */
  user: ChatroomUser | null;
}

export interface PlaceInput {
  storage: ChatroomPlace["storage"];
  /** Root to the current node, as the workspace's lineage; empty at the root. */
  lineage: { id: string; name: string; type: string }[];
  experiment: { id: string; nodeId: string | null; title: string; status: string; state: string; access: string } | null;
  /** The experiment's report path, if it has one. */
  report: string | null;
  selectedPath: string | null;
}

export function chatroomPlace({ storage, lineage, experiment, report, selectedPath }: PlaceInput): ChatroomPlace {
  const path = lineage.map(({ id, name, type }) => ({ id, name, type }));
  const node = path.at(-1);
  return {
    version: CHATROOM_PROPS_VERSION,
    storage,
    node: node ? { ...node, path } : null,
    experiment: experiment
      ? {
          id: experiment.id,
          node_id: experiment.nodeId,
          title: experiment.title,
          status: experiment.status,
          state: experiment.state,
          can_change: experiment.access === "writer",
          report,
        }
      : null,
    selected_path: selectedPath,
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The run input with the server's `user` in its chatroom props (and the rest kept). */
export function withChatroomUser<T extends { forwardedProps?: unknown }>(
  input: T,
  user: ChatroomUser | null,
): Omit<T, "forwardedProps"> & { forwardedProps: Record<string, unknown> } {
  const props = record(input.forwardedProps) ? input.forwardedProps : {};
  const sent = record(props[CHATROOM_PROPS]) ? props[CHATROOM_PROPS] : {};
  return {
    ...input,
    forwardedProps: { ...props, [CHATROOM_PROPS]: { version: CHATROOM_PROPS_VERSION, ...sent, user } },
  };
}
