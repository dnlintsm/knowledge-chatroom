import { isTextFile, mimeForPath, ReadOnlyFileError, type WorkspaceFile } from "./types";

/** A picked or dropped file as workspace content: text as is, anything else as a data: URL. */
export async function readUpload(file: File): Promise<{ content: string; mime: string }> {
  const mime = file.type || mimeForPath(file.name);
  if (isTextFile({ mime, path: file.name })) return { content: await file.text(), mime };
  const content = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return { content, mime };
}

/**
 * Writes each file to uploads/<name> in the current place and returns the
 * paths written. A read-only file of that name is skipped and reported.
 * Every file is read before any is written, so `stillHere` (checked once,
 * right before the writes) can refuse when the user moved meanwhile.
 */
export async function uploadFiles(
  list: FileList | File[] | null,
  write: (path: string, content: string, opts: { mime: string }) => WorkspaceFile,
  onReadOnly: (path: string) => void,
  stillHere: () => boolean = () => true,
): Promise<string[]> {
  const files = Array.from(list ?? []);
  const read = await Promise.all(files.map(readUpload));
  if (!stillHere()) throw new Error("You moved to another place before the upload started, so nothing was uploaded.");
  const written: string[] = [];
  for (const [i, file] of files.entries()) {
    const { content, mime } = read[i];
    const path = `uploads/${file.name}`;
    try {
      written.push(write(path, content, { mime }).path);
    } catch (err) {
      if (!(err instanceof ReadOnlyFileError)) throw err;
      onReadOnly(path);
    }
  }
  return written;
}
