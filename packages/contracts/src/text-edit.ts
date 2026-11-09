/**
 * Exact-text edits for the agent's edit tools (apps/agent/src/storage/tools.ts
 * edit_file and the browser's editWorkspaceFile), with no Node, React or
 * package dependencies.
 *
 * Changing part of a file this way keeps a chat's context small: rewriting a
 * whole page for each tweak puts the page into the history twice per change,
 * which fills a smaller model's window within a few rounds (issue #126).
 */

export interface TextEdit {
  /** Text to find, copied exactly from the file (without line numbers). */
  oldText: string;
  /** What replaces it; may be empty to delete it. */
  newText: string;
  /** Replace every occurrence instead of requiring exactly one. */
  replaceAll?: boolean;
}

export type EditResult =
  | {
      ok: true;
      content: string;
      replacements: number;
      /** First and last line (1-based) of the first replacement in the new content. */
      lines: [number, number];
    }
  | { ok: false; error: string };

/** A leading "12\t" as read tools number lines; a sign the model copied them. */
const LINE_NUMBER = /^\s*\d+\t/;

export function applyEdit(content: string, { oldText, newText, replaceAll = false }: TextEdit): EditResult {
  if (!oldText) {
    return { ok: false, error: "oldText is empty. To create a file or replace all of it, write the whole file instead." };
  }
  if (oldText === newText) return { ok: false, error: "oldText and newText are the same; nothing to change." };

  // Read tools show lines split on any line ending: match a CRLF file too,
  // and keep its line endings in the replacement.
  const crlf = content.includes("\r\n");
  let find = oldText;
  const put = crlf ? newText.replace(/\r?\n/g, "\r\n") : newText;
  if (crlf && !content.includes(find) && !find.includes("\r\n")) find = find.replace(/\n/g, "\r\n");

  const first = content.indexOf(find);
  if (first === -1) {
    const numbered = oldText.split("\n").some((line) => LINE_NUMBER.test(line));
    return {
      ok: false,
      error:
        "oldText was not found in the file. " +
        (numbered
          ? "Leave out the line numbers and the tab after them: they are not part of the file. "
          : "") +
        "Copy it exactly (spaces and indentation too) from a fresh read of the lines you want to change; the file may have changed since you read it.",
    };
  }
  const count = content.split(find).length - 1;
  if (count > 1 && !replaceAll) {
    return {
      ok: false,
      error:
        `oldText occurs ${count} times. Include more of the surrounding lines so it matches only ` +
        "the place you mean, or set replaceAll to change every occurrence.",
    };
  }

  const updated = replaceAll ? content.split(find).join(put) : content.slice(0, first) + put + content.slice(first + find.length);
  const startLine = lineAt(updated, first);
  const endLine = lineAt(updated, first + Math.max(put.length - 1, 0));
  return { ok: true, content: updated, replacements: replaceAll ? count : 1, lines: [startLine, endLine] };
}

/** 1-based line number of character `index`, counting \r\n, \r and \n as one break each. */
function lineAt(text: string, index: number): number {
  return text.slice(0, index).split(/\r\n|\r|\n/).length;
}
