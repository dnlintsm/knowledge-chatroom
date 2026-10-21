/**
 * The chat's first-round suggestion chips: knowledge-work actions on what the
 * user has in front of them. Each chip shows only when it applies and names
 * the file or run it works on, so a click sends a complete request.
 */
import { fileName } from "./types";

export interface ChatSuggestion {
  title: string;
  message: string;
}

export interface SuggestionPlace {
  /** The file in the middle pane, when it's a text file. */
  openFile: string | null;
  /** The run (experiment) the user is in, by title. */
  runTitle: string | null;
  /** That run's report, as a path in it; null when it has none yet. */
  report: string | null;
  /** Knowledge node the user is on, by name. */
  nodeName: string | null;
  /** Server storage is on, so Claude has the experiment and search tools. */
  serverStorage: boolean;
}

export function firstRoundSuggestions(place: SuggestionPlace): ChatSuggestion[] {
  const { openFile, runTitle, report, nodeName, serverStorage } = place;
  const run = runTitle ? `the run "${runTitle}"` : null;
  const chips: ChatSuggestion[] = [];

  if (openFile) {
    chips.push({
      title: `Summarize ${fileName(openFile)}`,
      message: `Summarize ${openFile} in a few bullets, then save the summary as a new file in the artifacts folder.`,
    });
  }

  chips.push({
    title: "Draft a note",
    message: run
      ? `Draft a short note on what I should do next for ${run}, based on its report, files and results, ` +
        "and save it as notes/next-steps.md in the run."
      : "Look at my workspace files and draft a short note at notes/next-steps.md with what I should do next.",
  });

  if (run && report) {
    chips.push({
      title: "Analyze the report",
      message:
        `Analyze the report of ${run} at ${report}: the key findings and how strong the evidence is, ` +
        "anything that looks off or inconsistent, and which runs to try next.",
    });
  }

  if (serverStorage) {
    const like = run ?? (nodeName ? `the work on ${nodeName}` : "what I'm working on");
    chips.push({
      title: "Search similar experiments",
      message:
        `Find experiments similar to ${like} (same goal, hypothesis or parameters) across the knowledge ` +
        "tree: use list_experiments and search_files by meaning. Compare the closest ones in a table " +
        "with title, where it lives, hypothesis, key parameters and results, then say what we can learn from them.",
    });
  }

  return chips;
}

/**
 * What the suggester (agent/src/suggest.ts) is asked for after each reply;
 * it also sees the conversation and the workspace context.
 */
export const FOLLOW_UP_INSTRUCTIONS =
  "Suggest the next steps the user is most likely to want after Claude's last reply, " +
  "about the files, run, report or experiments in front of them.";
