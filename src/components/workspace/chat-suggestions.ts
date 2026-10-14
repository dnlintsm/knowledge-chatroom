/**
 * The chat's first-round suggestion chips: knowledge-work actions on what the
 * user has in front of them. Each chip shows only when it applies and names
 * the file or run it works on, so a click sends a complete request.
 */
import { RUN_REPORT } from "./runs";
import { fileName } from "./types";

export interface ChatSuggestion {
  title: string;
  message: string;
}

export interface SuggestionPlace {
  /** The file in the middle pane, when it's a text file. */
  openFile: string | null;
  /** The focused run's folder. */
  runDir: string | null;
  /** True when the focused run has its report (RUN_REPORT). */
  hasReport: boolean;
  /** Knowledge node the user is on, by name. */
  nodeName: string | null;
  /** Experiment the user is working in, by title. */
  experimentTitle: string | null;
  /** Server storage is on, so Claude has the experiment and search tools. */
  serverStorage: boolean;
}

export function firstRoundSuggestions(place: SuggestionPlace): ChatSuggestion[] {
  const { openFile, runDir, hasReport, nodeName, experimentTitle, serverStorage } = place;
  const run = runDir ? fileName(runDir) : null;
  const chips: ChatSuggestion[] = [];

  if (openFile) {
    chips.push({
      title: `Summarize ${fileName(openFile)}`,
      message:
        `Summarize ${openFile} in a few bullets, then save the summary as a new file in the ` +
        `${runDir ? `${runDir}/artifacts` : "artifacts"} folder.`,
    });
  }

  chips.push({
    title: "Draft a note",
    message: runDir
      ? `Draft a short note on what I should do next for the run ${run}, based on its report and files, ` +
        `and save it as ${runDir}/notes/next-steps.md.`
      : "Look at my workspace files and draft a short note at notes/next-steps.md with what I should do next.",
  });

  if (runDir && hasReport) {
    chips.push({
      title: `Analyze the ${run} report`,
      message:
        `Analyze the report at ${runDir}/${RUN_REPORT}: the key findings and how strong the evidence is, ` +
        "anything that looks off or inconsistent, and which runs to try next.",
    });
  }

  if (serverStorage) {
    const like = experimentTitle
      ? `the experiment "${experimentTitle}"`
      : run
        ? `the run ${run}`
        : nodeName
          ? `the work on ${nodeName}`
          : "what I'm working on";
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
