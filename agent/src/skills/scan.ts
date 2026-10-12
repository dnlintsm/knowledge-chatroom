import { parseFrontMatter, SCRIPT_FILE, type SkillFile } from "./catalog";

/**
 * The check a hub version gets when it's published (issue #7, step 4): what
 * a person should look at before installing it. Flags warn; they don't stop
 * publishing, and a clean scan doesn't make a skill safe (that's what an
 * admin's verification is for).
 */

export type FlagKind = "scripts" | "network" | "large" | "binary" | "hidden-text" | "instructions";

export interface ScanFlag {
  kind: FlagKind;
  path: string;
  /** 1-based, for flags about a line. */
  line: number | null;
  detail: string;
}

/** Files bigger than this are flagged (the hub takes up to 1 MB each). */
export const LARGE_FILE_BYTES = 256 * 1024;
/** Flags kept per kind and file; the rest are counted in one more flag. */
const PER_FILE = 3;
/** Flags kept for a whole version. */
const MAX_FLAGS = 50;

const NETWORK = [
  { pattern: /\bhttps?:\/\/[^\s)\]>"'`]+/i, detail: (m: string) => `links to ${hostOf(m)}` },
  {
    pattern: /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|netcat|scp|rsync)\s/,
    detail: (m: string) => `runs ${m.trim()}`,
  },
  { pattern: /\b(fetch|XMLHttpRequest|requests\.(get|post|put)|urllib|http\.client|axios)\b/, detail: (m: string) => `calls ${m}` },
];

const INSTRUCTIONS = [
  /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|other|system)\s+(instructions|directions|rules|prompts?)/i,
  /\b(do\s+not|don't|never)\s+(tell|inform|mention|reveal|show|alert)\b[^.\n]{0,40}\b(the\s+)?(user|human|person)\b/i,
  /\bwithout\s+(telling|asking|informing|notifying)\s+(the\s+)?(user|human|person)\b/i,
  /\b(reveal|print|repeat|output)\s+(your\s+|the\s+)?(system\s+prompt|hidden\s+instructions)/i,
  /\bexfiltrat/i,
  /\b(api[\s_-]?keys?|passwords?|secrets?|tokens?|credentials?|\.env\b|ssh\s+keys?)\b[^\n]{0,60}\b(send|post|upload|email|forward|paste)\b/i,
  /\b(send|post|upload|email|forward)\b[^\n]{0,60}\b(api[\s_-]?keys?|passwords?|secrets?|credentials?|\.env\b|ssh\s+keys?)\b/i,
];

/** Zero-width, bidirectional-override and Unicode tag characters: text a reader can't see. */
const HIDDEN = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/u;
/** A run of base64-looking text long enough to hide a payload. */
const ENCODED = /[A-Za-z0-9+/]{200,}={0,2}/;

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
}

const clip = (text: string) => (text.length > 80 ? `${text.slice(0, 77)}…` : text);

/** Whether the bytes look like text: valid UTF-8 with no NUL bytes. */
function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Flags for a skill's files, at most MAX_FLAGS, in file order. */
export function scanSkill(files: SkillFile[]): ScanFlag[] {
  const flags: ScanFlag[] = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const counts = new Map<FlagKind, number>();
    const add = (kind: FlagKind, line: number | null, detail: string) => {
      const n = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, n);
      if (n <= PER_FILE) flags.push({ kind, path: file.path, line, detail });
    };

    if (SCRIPT_FILE.test(file.path)) add("scripts", null, "a script file; skills here don't run scripts yet");
    if (file.bytes.byteLength > LARGE_FILE_BYTES) {
      add("large", null, `${Math.round(file.bytes.byteLength / 1024)} KB`);
    }
    const text = asText(file.bytes);
    if (text === null) {
      add("binary", null, "not text, so not checked");
    } else {
      if (file.path === "SKILL.md" && /\bBash\b/.test(parseFrontMatter(text)["allowed-tools"] ?? "")) {
        add("scripts", null, "asks for Bash in allowed-tools");
      }
      const markdown = /\.(md|markdown)$/i.test(file.path);
      text.split(/\r?\n/).forEach((line, i) => {
        const at = i + 1;
        if (HIDDEN.test(i === 0 ? line.replace(/^\uFEFF/, "") : line)) add("hidden-text", at, "invisible characters");
        if (markdown && line.includes("<!--")) add("hidden-text", at, "an HTML comment, hidden when the page is shown");
        if (ENCODED.test(line)) add("hidden-text", at, "a long run of encoded text");
        for (const rule of NETWORK) {
          const match = rule.pattern.exec(line);
          if (match) add("network", at, rule.detail(match[0]));
        }
        for (const rule of INSTRUCTIONS) {
          const match = rule.exec(line);
          if (match) {
            add("instructions", at, `“${clip(match[0])}”`);
            break;
          }
        }
      });
    }
    for (const [kind, n] of counts) {
      if (n > PER_FILE) flags.push({ kind, path: file.path, line: null, detail: `and ${n - PER_FILE} more like this` });
    }
  }
  return flags.slice(0, MAX_FLAGS);
}
