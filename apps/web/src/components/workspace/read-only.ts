import { hasRole } from "./roles";
import type { Experiment, Role } from "./server-files";

/**
 * Why the place the user is in can't be changed (#187), in the words the
 * badges show: `label` for the editor's file header, `detail` for the
 * experiment header and as a tooltip. Since #175 there are only these
 * reasons; null when the user can change it.
 */
export interface ReadOnlyReason {
  kind: "archived" | "not-author" | "view-only";
  label: string;
  detail: string;
}

interface Place {
  /** The experiment the user is in, if any. */
  experiment: Experiment | null;
  /** Their role where they are (see resolvePlaceContext). */
  placeRole: Role | null;
  /** Where they are, by name: a node, or "the workspace". */
  placeName: string;
  /** They may rerun the experiment as their own (it's offered only then). */
  canRerun?: boolean;
}

export function readOnlyReason({ experiment, placeRole, placeName, canRerun = true }: Place): ReadOnlyReason | null {
  if (experiment) {
    if (experiment.access === "writer") return null;
    const author = experiment.authorName ?? "its author";
    const rerun = canRerun ? " Rerun it to work on your own copy." : "";
    if (experiment.status === "archived") {
      return {
        kind: "archived",
        label: "Read only · archived",
        detail: experiment.mine
          ? "Archived, so it's read only. Restore it to change it."
          : `Archived, so it's read only. Only ${author} can restore it.${rerun}`,
      };
    }
    return {
      kind: "not-author",
      label: `Read only · only ${author} can edit`,
      detail: `Only ${author} can edit this experiment.${rerun}`,
    };
  }
  if (hasRole(placeRole, "editor")) return null;
  // Who could grant more isn't named: a viewer may not be allowed to see grants.
  return {
    kind: "view-only",
    label: "Read only · view access",
    detail: `You can view ${placeName} but not edit it.`,
  };
}
