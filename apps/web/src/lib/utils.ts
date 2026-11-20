import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The type scale in globals.css, so `text-label` is read as a size and not a
// color: otherwise `cn("text-label", "text-brand-text")` drops the size.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["caption", "label", "body", "title"] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
/** "3 days ago", "just now"; a dash for no time. */
export function ago(iso: string | null) {
  if (!iso) return "—";
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return "just now";
}
