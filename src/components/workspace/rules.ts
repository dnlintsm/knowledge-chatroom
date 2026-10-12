/**
 * A run's general rules: fetched as JSON from the rules API (RULES_API_URL,
 * via /api/rules) and turned into <RUN_DIR>/models/general_rules.md by a fixed
 * transform. The file is written once, read-only, and never regenerated.
 */

export const RULES_FILE = "models/general_rules.md";

export function rulesPath(runDir: string) {
  return `${runDir}/${RULES_FILE}`;
}

export interface Rule {
  id: string;
  title: string;
  condition: string;
  action: string;
  /** 0 to 1. */
  confidence: number;
}

export interface RulesResponse {
  run: string;
  generatedAt: string;
  rules: Rule[];
}

const isString = (v: unknown): v is string => typeof v === "string";

/** Checks the API's JSON, so a malformed answer fails loudly instead of writing a broken file. */
export function parseRulesResponse(json: unknown): RulesResponse {
  const data = json as Partial<RulesResponse> | null;
  if (!data || typeof data !== "object") throw new Error("The rules API returned no JSON object");
  if (!isString(data.run) || !isString(data.generatedAt) || !Array.isArray(data.rules)) {
    throw new Error("The rules API answer needs run, generatedAt and rules");
  }
  const rules = data.rules.map((raw, i) => {
    const r = raw as Partial<Rule> | null;
    if (
      !r ||
      !isString(r.id) ||
      !isString(r.title) ||
      !isString(r.condition) ||
      !isString(r.action) ||
      typeof r.confidence !== "number" ||
      !Number.isFinite(r.confidence)
    ) {
      throw new Error(`Rule ${i + 1} from the rules API is malformed`);
    }
    return { id: r.id, title: r.title, condition: r.condition, action: r.action, confidence: r.confidence };
  });
  return { run: data.run, generatedAt: data.generatedAt, rules };
}

/** Table cells: one line, no column breaks. */
const cell = (text: string) => text.replace(/\r?\n|\r/g, " ").replace(/\|/g, "\\|").trim();

const percent = (confidence: number) => `${Math.round(Math.min(1, Math.max(0, confidence)) * 100)}%`;

/** The fixed JSON → markdown transform. Same input, same file. */
export function rulesToMarkdown(data: RulesResponse): string {
  const name = data.run.split("/").pop() || data.run;
  const lines = [
    `# General rules: ${name}`,
    "",
    `Generated from the rules API for \`${data.run}\` (${data.generatedAt}). This file is read-only.`,
    "",
  ];
  if (!data.rules.length) {
    lines.push("_The rules API returned no rules for this run._", "");
    return lines.join("\n");
  }
  lines.push("| ID | Rule | When | Then | Confidence |", "| --- | --- | --- | --- | --- |");
  for (const r of data.rules) {
    lines.push(`| ${cell(r.id)} | ${cell(r.title)} | ${cell(r.condition)} | ${cell(r.action)} | ${percent(r.confidence)} |`);
  }
  lines.push("");
  return lines.join("\n");
}
