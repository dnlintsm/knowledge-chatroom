import {
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  File as FileIcon_,
  Sparkles,
} from "lucide-react";
import { extension, type WorkspaceFile } from "./types";

export function FileIcon({
  file,
  className = "size-4",
}: {
  file: Pick<WorkspaceFile, "path" | "mime" | "kind">;
  className?: string;
}) {
  const ext = extension(file.path);
  if (file.kind === "skill") return <Sparkles className={`${className} text-amber-500`} />;
  if (file.mime.startsWith("image/")) return <FileImage className={`${className} text-pink-500`} />;
  if (ext === "csv") return <FileSpreadsheet className={`${className} text-emerald-600`} />;
  if (ext === "md" || ext === "markdown" || ext === "txt")
    return <FileText className={`${className} text-sky-600`} />;
  if (["ts", "tsx", "js", "jsx", "py", "json", "html", "css", "sql", "sh"].includes(ext))
    return <FileCode className={`${className} text-violet-500`} />;
  return <FileIcon_ className={`${className} text-[var(--muted-foreground)]`} />;
}
