import {
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  File as FileIcon_,
  Sparkles,
} from "lucide-react";
import { previewKind, type WorkspaceFile } from "./types";

export function FileIcon({
  file,
  className = "size-4",
}: {
  file: Pick<WorkspaceFile, "path" | "mime" | "kind">;
  className?: string;
}) {
  if (file.kind === "skill") return <Sparkles className={`${className} text-amber-500`} />;
  switch (previewKind(file)) {
    case "image":
      return <FileImage className={`${className} text-pink-500`} />;
    case "audio":
      return <FileAudio className={`${className} text-orange-500`} />;
    case "video":
      return <FileVideo className={`${className} text-orange-500`} />;
    case "table":
      return <FileSpreadsheet className={`${className} text-emerald-600`} />;
    case "pdf":
      return <FileText className={`${className} text-red-500`} />;
    case "markdown":
    case "text":
      return <FileText className={`${className} text-sky-600`} />;
    case "code":
    case "html":
      return <FileCode className={`${className} text-violet-500`} />;
    default:
      return <FileIcon_ className={`${className} text-[var(--muted-foreground)]`} />;
  }
}
