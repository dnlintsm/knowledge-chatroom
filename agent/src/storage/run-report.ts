import type { Experiment } from "./experiments";

/**
 * A run's report.md carries the run's record in its front matter: state,
 * results and provenance (issue #82), so the report says where its numbers
 * came from even when it is copied or downloaded on its own. One key per
 * line, values as JSON (which YAML reads too), as the editor's front-matter
 * card shows them.
 */

export const REPORT_PATH = "report.md";

export function reportFrontMatter(run: Experiment): string {
  const p = run.provenance;
  const lines: [string, unknown][] = [
    ["run", run.id],
    ["title", run.title],
    ["state", run.state],
    ["started_by", startedBy(p.startedBy)],
    ["started_at", p.startedAt],
    ["finished_at", p.finishedAt],
    ["chat", p.chat],
    ["model", p.model],
    ["skill", p.skill],
    ["tools", p.tools],
    ["inputs", inputs(p.inputs)],
    ["params", Object.keys(run.params).length ? run.params : undefined],
    ["results", Object.keys(run.results).length ? run.results : undefined],
  ];
  const body = lines
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  return `---\n${body}\n---\n`;
}

function startedBy(who: unknown) {
  const { id, name } = (who ?? {}) as { id?: string; name?: string | null };
  return name ?? id;
}

/** Each input's path in the run, where it came from and its hash; the full record is on the run. */
function inputs(list: unknown) {
  if (!Array.isArray(list) || !list.length) return undefined;
  return (list as { path: string; from?: { path?: string }; sha256?: string }[]).map((i) => ({
    path: i.path,
    from: i.from?.path,
    sha256: i.sha256,
  }));
}

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** `markdown` with its front matter (if any) replaced by `frontMatter`. */
export function withFrontMatter(markdown: string, frontMatter: string): string {
  const rest = markdown.replace(FRONT_MATTER, "");
  return frontMatter + (rest.startsWith("\n") || !rest ? rest : `\n${rest}`);
}

/** A first report for a new run: its record and a title for Claude to write under. */
export function newReport(run: Experiment): string {
  return withFrontMatter(`# ${run.title}\n`, reportFrontMatter(run));
}
